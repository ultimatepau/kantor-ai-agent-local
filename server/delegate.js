// Delegasi: leader memecah tugas -> anggota tim mengerjakan -> leader mereview & merangkum.
// Memancarkan event terstruktur (bila didukung) agar frontend menampilkan bubble terpisah per anggota.
import { agentsOf } from '../shared/roster.js';
import { buildSystemPrompt } from './prompts.js';

const MAX_TASKS = 3;
const TRIGGER = /(\/tim\b|delegasi|delegasikan|delegate|suruh (tim|anak buah)|minta (tim|anak buah)|kerjakan (sama|bareng|oleh) tim|tugasin (ke )?(tim|anak buah)|libatkan tim)/i;

export const wantsDelegation = (text) => TRIGGER.test(text || '');

function planPrompt(team) {
  return [
    'PERINTAH SISTEM MUTLAK:',
    'Kamu adalah leader yang WAJIB membagi tugas user saat ini kepada anggota tim di bawah ini.',
    'DILARANG menjawab dengan obrolan biasa, DILARANG menolak, DILARANG meminta brief tambahan.',
    'Jika brief dari user minim atau hanya berupa URL/pertanyaan singkat, kamu TETAP WAJIB membuatkan tugas inisiatif / investigasi awal untuk anggota tim yang paling relevan.',
    '',
    'Daftar anggota timmu:',
    ...team.map((m) => `- ID: "${m.id}" -> ${m.name}, ${m.role} (Keahlian: ${m.focus})`),
    '',
    'Balas HANYA teks JSON murni (satu baris atau multi-baris), TANPA markdown backtick, TANPA kalimat sebelum/sesudah JSON. Format:',
    '{"tugas":[{"agent":"<id>","brief":"instruksi kerja yang spesifik untuk anggota ini"}]}',
  ].join('\n');
}

export function parsePlan(text, team) {
  if (!text) return [];
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return [];

  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    try {
      const cleaned = m[0].replace(/,\s*([}\]])/g, '$1');
      obj = JSON.parse(cleaned);
    } catch {
      return [];
    }
  }

  const seen = new Set();
  const out = [];

  for (const t of Array.isArray(obj?.tugas) ? obj.tugas : []) {
    const rawId = String(t?.agent || '').toLowerCase().trim();
    const matched = team.find((x) => x.id.toLowerCase() === rawId || x.name.toLowerCase().includes(rawId));
    const brief = String(t?.brief || '').trim().slice(0, 800);

    if (!matched || !brief || seen.has(matched.id)) continue;
    seen.add(matched.id);
    out.push({ member: matched, brief });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

function heuristicPlan(userMsg, team) {
  const lower = userMsg.toLowerCase();
  const scored = team.map((member) => {
    let score = 0;
    const words = `${member.id} ${member.role} ${member.focus}`.toLowerCase().split(/\W+/);
    for (const w of words) {
      if (w.length > 2 && lower.includes(w)) score += 2;
    }
    return { member, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0]?.score > 0 ? scored[0].member : team[0];
  return [{
    member: chosen,
    brief: `Analisis dan lakukan pemeriksaan awal sesuai keahlianmu (${chosen.focus}) untuk permintaan user berikut: "${userMsg.slice(0, 300)}"`,
  }];
}

// run({ model, system, messages, maxTokens, onText }) -> Promise (disediakan index.js)
export async function delegate({ leader, messages, run, modelFor, maxTokens, send, isClosed }) {
  const team = agentsOf(leader.division).filter((a) => !a.leader);
  if (!team.length) {
    send({ t: '_Divisi ini tidak memiliki anggota tim tambahan, gue tangani sendiri._\n\n' });
    await run({ model: modelFor(leader), system: buildSystemPrompt(leader), messages, maxTokens, onText: (t) => send({ t }) });
    return;
  }

  const userMsg = messages[messages.length - 1].content;

  // 1) Rencana pembagian tugas
  send({ event: 'system_note', text: `🧭 ${leader.name.split(' ')[0]} sedang membagi tugas ke tim...` });
  const planMessages = [{ role: 'user', content: `Permintaan user yang harus kamu bagi ke timmu:\n"${userMsg}"` }];

  const askPlan = async () => {
    let text = '';
    await run({
      model: modelFor(leader),
      system: buildSystemPrompt(leader) + '\n\n' + planPrompt(team),
      messages: planMessages,
      maxTokens: 800,
      onText: (t) => { text += t; },
    });
    return text;
  };

  let planText = await askPlan();
  let plan = parsePlan(planText, team);

  if (!plan.length) {
    console.warn('[delegate] Rencana JSON gagal diparsing, mencoba sekali lagi...');
    planText = await askPlan();
    plan = parsePlan(planText, team);
  }

  if (!plan.length) {
    console.warn('[delegate] Fallback ke penugasan otomatis heuristik tim.');
    plan = heuristicPlan(userMsg, team);
  }

  // 2) Anggota tim mengeksekusi tugas dalam bubble terpisah
  const results = [];
  for (const { member, brief } of plan) {
    if (isClosed()) return;
    send({
      event: 'speech_start',
      agent: { id: member.id, name: member.name, role: member.role, division: member.division },
      brief,
    });

    let out = '';
    await run({
      model: modelFor(member),
      system: buildSystemPrompt(member),
      messages: [
        {
          role: 'user',
          content: `Tugas dari ${leader.name.split(' ')[0]} (leader):\n${brief}\n\nKonteks permintaan asli user:\n${userMsg}`,
        },
      ],
      maxTokens,
      onText: (t) => {
        out += t;
        send({ event: 'speech_delta', t });
      },
    });

    const cleanOut = out.trim();
    results.push({ member, brief, out: cleanOut });
    send({ event: 'speech_end', cleanText: cleanOut });
  }

  // 3) Leader mereview dan merangkum dalam bubble kesimpulan
  if (isClosed()) return;
  send({
    event: 'summary_start',
    agent: { id: leader.id, name: leader.name, role: leader.role, division: leader.division },
  });

  const bundle = results
    .map((r) => `## ${r.member.name} (${r.member.role})\nTugas: ${r.brief}\nHasil kerja:\n${r.out}`)
    .join('\n\n');

  let rawSummary = '';
  await run({
    model: modelFor(leader),
    system: buildSystemPrompt(leader),
    messages: [
      {
        role: 'user',
        content: `Permintaan awal user:\n${userMsg}\n\nHasil kerja timmu yang baru saja selesai:\n\n${bundle}\n\nReview pekerjaan tim di atas sebagai leader: sebutkan apa yang sudah bagus, catatan tambahanmu, dan rekomendasi langkah konkret untuk user. Ringkas dan solutif.`,
      },
    ],
    maxTokens,
    onText: (t) => {
      rawSummary += t;
      send({ event: 'summary_delta', t });
    },
  });

  send({ event: 'summary_end', cleanText: rawSummary.trim() });
}
