// Diskusi tim / Townhall: anggota duduk bareng bergantian bicara sampai tujuan tercapai.
// Memancarkan event SSE terstruktur agar frontend bisa membuat bubble per orang secara rapi.
import { buildSystemPrompt } from './prompts.js';

const MAX_ENTRY_CHARS = 2500; // batas teks per giliran di transkrip
const MAX_KEEP = 30; // jumlah giliran terakhir yang diingat di context

// Sela (interupsi) user per sesi. Antrean hidup hanya selama diskusinya jalan.
const inbox = new Map(); // id -> string[]

export function sayTo(id, text) {
  id = String(id || '').slice(0, 64);
  text = String(text || '').trim().slice(0, 4000);
  if (!id || !text || !inbox.has(id)) return false;
  const q = inbox.get(id);
  if (q.length >= 10) return false;
  q.push(text);
  return true;
}

export function dropInbox(id) {
  inbox.delete(id);
}

const ROOM_EXTRA = [
  'MODE RAPAT / TOWNHALL: kamu duduk bersama rekan kerja untuk menuntaskan satu tujuan.',
  'Aturan wajib:',
  '1. Bicara padat dan tegas (maksimal 100-150 kata). Langsung ke inti pandanganmu tanpa basa-basi pembuka/penutup.',
  '2. Bicaralah dari sudut pandang keahlianmu. Bangun di atas ucapan rekan sebelumnya (setujui singkat / sanggah dengan alasan konkret).',
  '3. Jangan mengulang poin yang sudah disepakati.',
  '4. Jangan mencantumkan garis pembatas markdown seperti "---" di dalam jawabanmu.',
  '5. KRUSIAL: Jika menurutmu tujuan rapat ini sudah tercapai (sudah ada kesepakatan solusi, pembagian tugas, atau jawaban tuntas atas apa yang diminta user), tulis ringkasan keputusanmu lalu letakkan kata persis "SELESAI" di baris paling terakhir sendiri.',
].join('\n');

const CHECK_PROMPT = [
  'Kamu adalah ketua sidang/moderator rapat yang tegas dan objektif.',
  'Tugasmu menilai apakah tujuan rapat sudah tercapai dari transkrip yang ada.',
  '',
  'Kriteria selesai (cukup penuhi MINIMAL SATU dari ini):',
  'A. Sudah ada keputusan/solusi konkret yang disepakati untuk pertanyaan user.',
  'B. Sudah ada rencana tindak lanjut / pembagian tugas yang jelas.',
  'C. Semua peserta sudah sepakat dan tidak ada lagi perdebatan aktif atau pertanyaan baru.',
  'D. Peserta sudah saling mengulang poin yang sama (konsensus tercapai).',
  '',
  'Balas HANYA JSON valid satu baris, tanpa markdown, tanpa ```, tanpa kalimat lain:',
  '{"selesai":true,"alasan":"<alasan maksimal 15 kata>"}',
  'atau bila benar-benar masih butuh perdebatan kritis yang belum terjawab:',
  '{"selesai":false,"alasan":"<poin yang masih menggantung, maks 15 kata>"}',
].join('\n');

function parseCheck(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o?.selesai !== 'boolean') return null;
    return { selesai: o.selesai, alasan: String(o.alasan || '').slice(0, 140) };
  } catch {
    return null;
  }
}

// Cek apakah ada deklarasi kata SELESAI di baris terakhir/mandiri ucapan agent
function detectFinished(text) {
  if (!text) return { finished: false, cleanText: '' };
  const lines = text.trim().split(/\r?\n/);
  const lastLine = (lines[lines.length - 1] || '').trim().replace(/[*_#`]/g, '');
  const isFinish = /^SELESAI[.!?:;]?$/i.test(lastLine);
  if (isFinish) {
    lines.pop();
    return { finished: true, cleanText: lines.join('\n').trim() };
  }
  return { finished: false, cleanText: text.trim() };
}

// Bersihkan garis pemisah kotor '---' yang sering dibuat LLM
function sanitizeReply(text) {
  return String(text || '')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// run({ model, system, messages, maxTokens, onText }) -> Promise (disediakan index.js)
// send(eventObj)
export async function discuss({ id, topic, history = [], team, run, leaderModel, modelFor, maxTokens, maxRounds, send, isClosed }) {
  inbox.set(id, []);

  // Format transkrip awal dari history sebelumnya (jika ada) + prompt topik baru
  const transcript = [];
  if (Array.isArray(history) && history.length) {
    for (const h of history) {
      if (h && typeof h.text === 'string') {
        transcript.push({
          who: h.who ? String(h.who).slice(0, 60) : null,
          text: String(h.text).slice(0, MAX_ENTRY_CHARS),
        });
      }
    }
    transcript.push({ who: 'User (moderator)', text: `Tanggapan / arahan baru:\n${topic}` });
  } else {
    transcript.push({ who: null, text: `Tujuan diskusi (dari user):\n${topic}` });
  }

  let badChecks = 0;

  const kept = () =>
    transcript.length > MAX_KEEP + 1 ? [transcript[0], ...transcript.slice(-MAX_KEEP)] : transcript;
  const transcriptText = (list) =>
    list.map((e) => (e.who ? `**${e.who}:** ${e.text}` : e.text)).join('\n\n');

  // Sela user dimasukkan ke transkrip dan dikirim sebagai bubble user terpisah
  const drain = () => {
    const q = inbox.get(id) || [];
    inbox.set(id, []);
    for (const t of q) {
      transcript.push({ who: 'User (moderator)', text: t });
      send({ event: 'user_interrupt', text: t });
    }
  };

  send({
    event: 'start',
    topic,
    isFollowUp: Array.isArray(history) && history.length > 0,
    team: team.map((a) => ({ id: a.id, name: a.name, role: a.role, division: a.division })),
  });

  const speak = async (agent) => {
    send({
      event: 'speech_start',
      agent: { id: agent.id, name: agent.name, role: agent.role, division: agent.division },
    });
    let rawOut = '';
    await run({
      model: modelFor(agent),
      system: buildSystemPrompt(agent) + '\n\n' + ROOM_EXTRA,
      messages: [
        {
          role: 'user',
          content: `Transkrip rapat sejauh ini:\n\n${transcriptText(kept())}\n\nSekarang giliranmu (${agent.name}, ${agent.role}). Jawab sesuai aturan rapat.`,
        },
      ],
      maxTokens,
      onText: (t) => {
        rawOut += t;
        send({ event: 'speech_delta', t });
      },
    });

    const sanitized = sanitizeReply(rawOut);
    const { finished, cleanText } = detectFinished(sanitized);
    transcript.push({ who: `${agent.name} (${agent.role})`, text: cleanText.slice(0, MAX_ENTRY_CHARS) });
    send({ event: 'speech_end', cleanText, who: `${agent.name} (${agent.role})` });
    return finished ? `${agent.name.split(' ')[0]} menyatakan tujuan tercapai` : null;
  };

  const wrapUp = async (reason) => {
    if (isClosed()) return;
    const chair = team.find((a) => a.leader) || team[0];
    send({
      event: 'summary_start',
      agent: { id: chair.id, name: chair.name, role: chair.role, division: chair.division },
    });
    let rawSummary = '';
    await run({
      model: leaderModel,
      system: buildSystemPrompt(chair),
      messages: [
        {
          role: 'user',
          content:
            `Tujuan rapat:\n${topic}\n\nTranskrip rapat:\n\n${transcriptText(kept())}\n\n` +
            'Tulis RANGKUMAN KEPUTUSAN FINAL: apa keputusan yang disepakati bersama, siapa mengerjakan apa (action items konkret), dan kesimpulan akhir. Padat dan siap dieksekusi.',
        },
      ],
      maxTokens,
      onText: (t) => {
        rawSummary += t;
        send({ event: 'summary_delta', t });
      },
    });
    const finalClean = sanitizeReply(rawSummary);
    send({ event: 'summary_end', cleanText: finalClean, who: `Kesimpulan (${chair.name.split(' ')[0]})` });
    send({ event: 'closed', reason });
  };

  for (let round = 1; ; round++) {
    let finishedSignal = null;

    for (const agent of team) {
      if (isClosed()) return;
      drain();
      if (isClosed()) return;
      const sig = await speak(agent);
      if (sig && !finishedSignal) finishedSignal = sig;
    }
    if (isClosed()) return;
    drain();
    if (isClosed()) return;

    if (finishedSignal) {
      await wrapUp(finishedSignal);
      return;
    }

    if (maxRounds && round >= maxRounds) {
      await wrapUp(`batas ${maxRounds} ronde tercapai`);
      return;
    }

    send({ event: 'system_note', text: `Mengecek hasil ronde ${round}...` });

    let check = null;
    for (let attempt = 0; attempt < 2 && !check && !isClosed(); attempt++) {
      let raw = '';
      await run({
        model: leaderModel,
        system: CHECK_PROMPT,
        messages: [{ role: 'user', content: `Tujuan rapat:\n${topic}\n\nTranskrip rapat:\n\n${transcriptText(kept())}` }],
        maxTokens: 500,
        onText: (t) => { raw += t; },
      });
      check = parseCheck(raw);
    }
    if (isClosed()) return;

    if (check?.selesai) {
      await wrapUp(check.alasan || 'tujuan tercapai');
      return;
    }

    if (!check) {
      badChecks++;
      if (badChecks >= 2) {
        await wrapUp('konsensus ronde tercapai');
        return;
      }
      send({ event: 'system_note', text: `Ronde ${round} selesai. Lanjut ronde berikutnya.` });
      continue;
    }

    badChecks = 0;
    send({
      event: 'system_note',
      text: `Ronde ${round} selesai${check.alasan ? ` (${check.alasan})` : ''}. Lanjut ronde ${round + 1}.`,
    });
  }
}
