import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentById } from '../shared/roster.js';
import { buildSystemPrompt } from './prompts.js';
import { isLocal, streamLocal, localBase, localKey, updateLocalConfig, fetchRemoteModels } from './local.js';
import { delegate, wantsDelegation } from './delegate.js';
import { discuss, sayTo, dropInbox } from './discuss.js';

// ---------- Konfigurasi (lihat .env.example) ----------
const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
let MODEL_LEADER = process.env.MODEL_LEADER || 'claude-sonnet-5-5';
let MODEL_TEAM = process.env.MODEL_TEAM || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 1500) || 0; // 0 = tanpa batas (pakai maksimum bawaan model)
const RATE_PER_MINUTE = Number(process.env.RATE_PER_MINUTE || 15);
const DAILY_MAX_REQUESTS = Number(process.env.DAILY_MAX_REQUESTS || 300);
const MAX_HISTORY = 20;
const MAX_CHARS = 4000;
// Batas aman ronde diskusi tim (0 = tanpa batas, berhenti saat tujuan tercapai).
const DISCUSSION_MAX_ROUNDS = Math.max(0, Number(process.env.DISCUSSION_MAX_ROUNDS || 0));

const USES_LOCAL = () => isLocal(MODEL_LEADER) || isLocal(MODEL_TEAM);
const isDemoMode = () => !API_KEY && !USES_LOCAL();
const client = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- Pembatas: akses, rate limit per IP, batas harian ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function requireAccess(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
  res.status(401).json({ error: 'Kode akses salah atau belum diisi.' });
}

const hits = new Map(); // ip -> [timestamp]
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MINUTE) {
    return res.status(429).json({ error: 'Terlalu cepat. Tunggu sebentar lalu coba lagi.' });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
  }
}, 5 * 60_000).unref();

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
let daily = { day: today(), count: 0 };
function dailyCap(req, res, next) {
  if (daily.day !== today()) daily = { day: today(), count: 0 };
  if (daily.count >= DAILY_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Batas pemakaian harian tercapai. Coba lagi besok.' });
  }
  daily.count += 1;
  next();
}

// ---------- Util ----------
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demoReply(agent, lastUser) {
  return (
    `Halo, gue ${agent.name.split(' ')[0]} (${agent.role}).\n\n` +
    `**Mode demo**: server belum punya ANTHROPIC_API_KEY, jadi ini jawaban contoh supaya tampilan chat bisa dites.\n\n` +
    `Lo bilang: "${lastUser.slice(0, 160)}"\n\n` +
    `Setelah API key dipasang, gue bakal jawab sungguhan sesuai keahlian gue: ${agent.focus}.\n\n` +
    `- Poin contoh pertama\n- Poin contoh kedua\n- Poin contoh ketiga`
  );
}

function friendlyError(err) {
  if (err?.local) return err.message;
  const status = err?.status;
  if (status === 401) return 'API key Anthropic ditolak. Cek ANTHROPIC_API_KEY di server.';
  if (status === 402 || status === 403) return 'Akun API tidak punya akses atau saldo. Cek Console Anthropic.';
  if (status === 429) return 'Kena rate limit dari Anthropic. Coba lagi sebentar lagi.';
  if (status === 529 || status >= 500) return 'Server Claude lagi sibuk. Coba lagi sebentar lagi.';
  return 'Terjadi kesalahan di server. Coba lagi.';
}

// Satu pintu untuk semua pemanggilan model (lokal atau Claude), dipakai /api/chat dan /api/discuss.
function makeRunner(ac, logTag) {
  let stream = null;
  const run = async ({ model, system, messages: msgs, maxTokens, onText }) => {
    if (isLocal(model)) {
      const u = await streamLocal({ model, system, messages: msgs, maxTokens, signal: ac.signal, onText });
      console.log(
        `[chat] ${logTag} model=${model} in=${u.input} out=${u.output}` +
          (u.reasoning ? ` reasoning=${u.reasoning}` : '') +
          (u.truncated ? ' TERPOTONG(finish=length)' : ''),
      );
      if (u.truncated) {
        onText(
          `\n\n> ⚠️ Jawaban ini terpotong karena batas ${maxTokens ? `MAX_TOKENS=${maxTokens}` : 'maksimum model'}` +
            (u.reasoning ? ` (${u.reasoning} token terpakai untuk reasoning)` : '') +
            `. Naikkan MAX_TOKENS di .env atau matikan reasoning (LOCAL_NO_THINK=1).`,
        );
      }
      return;
    }
    if (!client) throw Object.assign(new Error('Model ini memakai Claude tapi ANTHROPIC_API_KEY belum diisi. Isi key, atau ubah MODEL_LEADER/MODEL_TEAM ke local:...'), { local: true });
    // Anthropic mewajibkan max_tokens: pakai angka tinggi kalau mode tanpa batas.
    stream = client.messages.stream({ model, max_tokens: maxTokens || 8192, system, messages: msgs }, { signal: ac.signal });
    stream.on('text', (t) => onText(t));
    const final = await stream.finalMessage();
    const u = final.usage || {};
    console.log(`[chat] ${logTag} model=${final.model} in=${u.input_tokens} out=${u.output_tokens}`);
  };
  return {
    run,
    abortStream: () => {
      if (stream && !ac.signal.aborted) stream.abort();
    },
  };
}

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({
    demo: isDemoMode(),
    needsCode: Boolean(ACCESS_CODE),
    modelLeader: MODEL_LEADER,
    modelTeam: MODEL_TEAM,
    localUrl: localBase(),
    hasLocalKey: Boolean(localKey()),
  });
});

app.get('/api/config/fetch-models', requireAccess, async (req, res) => {
  const base = String(req.query?.base || localBase());
  const key = req.query?.key !== undefined ? String(req.query.key) : localKey();
  try {
    const models = await fetchRemoteModels(base, key);
    res.json({ ok: true, models });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/config/models', requireAccess, (req, res) => {
  const leader = String(req.body?.modelLeader || '').trim();
  const team = String(req.body?.modelTeam || '').trim();
  const base = req.body?.localUrl !== undefined ? String(req.body.localUrl) : undefined;
  const key = req.body?.localKey !== undefined ? String(req.body.localKey) : undefined;

  if (leader) MODEL_LEADER = leader;
  if (team) MODEL_TEAM = team;
  if (base !== undefined || key !== undefined) {
    updateLocalConfig({ base, key });
  }

  console.log(`[settings] Diubah runtime: leader=${MODEL_LEADER} team=${MODEL_TEAM} base=${localBase()}`);
  res.json({
    ok: true,
    modelLeader: MODEL_LEADER,
    modelTeam: MODEL_TEAM,
    localUrl: localBase(),
    demo: isDemoMode(),
  });
});

app.get('/api/verify', requireAccess, (req, res) => res.json({ ok: true }));

app.post('/api/chat', requireAccess, rateLimit, dailyCap, async (req, res) => {
  const agent = agentById(req.body?.agentId);
  if (!agent) return res.status(400).json({ error: 'Karyawan tidak ditemukan.' });

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Pesan kosong.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let closed = false;
  let runner = null;
  res.on('close', () => {
    closed = true;
    runner?.abortStream();
  });

  try {
    let outChars = 0; // jaga-jaga: model reasoning bisa menghabiskan max_tokens tanpa menghasilkan teks
    const emit = (t) => {
      if (closed || !t) return;
      outChars += String(t).length;
      send({ t });
    };

    if (isDemoMode()) {
      const words = demoReply(agent, messages[messages.length - 1].content).split(/(\s+)/);
      for (const w of words) {
        if (closed) return;
        send({ t: w });
        await sleep(25);
      }
    } else {
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const modelFor = (a) => (a.leader ? MODEL_LEADER : MODEL_TEAM);
      runner = makeRunner(ac, agent.id);
      const { run } = runner;

      const last = messages[messages.length - 1].content;
      if (agent.leader && wantsDelegation(last)) {
        await delegate({ leader: agent, messages, run, modelFor, maxTokens: MAX_TOKENS, send: (o) => (o?.t ? emit(o.t) : (!closed && send(o))), isClosed: () => closed });
      } else {
        await run({ model: modelFor(agent), system: buildSystemPrompt(agent), messages, maxTokens: MAX_TOKENS, onText: emit });
      }

      if (!closed && outChars === 0) {
        send({ error: 'Model tidak mengembalikan teks apa pun (token habis untuk mode reasoning). Coba pertanyaan lebih pendek, atau set LOCAL_NO_THINK=1 / naikkan MAX_TOKENS di .env.' });
        return;
      }
    }
    if (!closed) send({ done: true });
  } catch (err) {
    if (!closed) {
      console.error('[chat error]', err?.status || '', err?.message || err);
      send({ error: friendlyError(err) });
    }
  } finally {
    res.end();
  }
});

// ---------- Diskusi tim ----------
app.post('/api/discuss/say', requireAccess, rateLimit, (req, res) => {
  const ok = sayTo(String(req.body?.id || ''), String(req.body?.text || ''));
  res.json(ok ? { ok: true } : { ok: false, error: 'Sesi diskusi tidak dikenal atau antrean sela penuh.' });
});

app.post('/api/discuss', requireAccess, rateLimit, dailyCap, async (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  const discId = String(req.body?.id || '').slice(0, 64);
  if (!discId) return res.status(400).json({ error: 'ID diskusi tidak valid.' });
  if (topic.length < 3) return res.status(400).json({ error: 'Tulis tujuan diskusinya dulu (minimal 3 karakter).' });

  const seen = new Set();
  const team = [];
  for (const raw of Array.isArray(req.body?.participants) ? req.body.participants : []) {
    const a = agentById(String(raw));
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      team.push(a);
    }
  }
  if (team.length < 2) return res.status(400).json({ error: 'Pilih minimal 2 karyawan untuk diskusi.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let closed = false;
  let runner = null;
  res.on('close', () => {
    closed = true;
    runner?.abortStream();
  });

  try {
    let outChars = 0;

    if (isDemoMode()) {
      send({ event: 'start', topic, team: team.map((a) => ({ id: a.id, name: a.name, role: a.role, division: a.division })) });
      for (const a of team.slice(0, 2)) {
        if (closed) return;
        send({ event: 'speech_start', agent: { id: a.id, name: a.name, role: a.role, division: a.division } });
        send({ event: 'speech_delta', t: `(demo) Saya setuju dengan tujuan "${topic}". Tapi kita perlu data konkret.` });
        send({ event: 'speech_end', cleanText: `(demo) Saya setuju dengan tujuan "${topic}". Tapi kita perlu data konkret.` });
        await sleep(300);
      }
      send({ event: 'summary_start', agent: { id: team[0].id, name: team[0].name, role: team[0].role, division: team[0].division } });
      send({ event: 'summary_delta', t: 'Keputusan: Diskusi demo selesai.' });
      send({ event: 'summary_end', cleanText: 'Keputusan: Diskusi demo selesai.' });
      send({ event: 'closed', reason: 'demo' });
    } else {
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      runner = makeRunner(ac, `diskusi:${discId}`);
      const modelFor = (a) => (a.leader ? MODEL_LEADER : MODEL_TEAM);

      await discuss({
        id: discId,
        topic,
        team,
        run: runner.run,
        leaderModel: MODEL_LEADER,
        modelFor,
        maxTokens: MAX_TOKENS,
        maxRounds: DISCUSSION_MAX_ROUNDS,
        send: (o) => (!closed && send(o)),
        isClosed: () => closed,
      });
    }
    if (!closed) send({ done: true });
  } catch (err) {
    if (!closed) {
      console.error('[discuss error]', err?.status || '', err?.message || err);
      send({ error: friendlyError(err) });
    }
  } finally {
    dropInbox(discId);
    res.end();
  }
});

// ---------- Frontend hasil build (produksi) ----------
const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(`${dist}/index.html`);
  });
}

app.listen(PORT, () => {
  console.log(`Kantor AI API jalan di http://localhost:${PORT}`);
  console.log(isDemoMode() ? 'Mode: DEMO (tanpa ANTHROPIC_API_KEY)' : `Mode: LIVE  leader=${MODEL_LEADER}  tim=${MODEL_TEAM}${USES_LOCAL() ? `  (model lokal: ${localBase()})` : ''}`);
  console.log(MAX_TOKENS ? `Batas jawaban: MAX_TOKENS=${MAX_TOKENS}` : 'Batas jawaban: tanpa batas (maksimum bawaan model)');
  console.log(ACCESS_CODE ? 'Kode akses: aktif' : 'Kode akses: TIDAK aktif (isi ACCESS_CODE sebelum dipublikasi)');
});
