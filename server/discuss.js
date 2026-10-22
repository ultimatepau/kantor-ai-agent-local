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
  'MODE RAPAT / DEBAT TIM: kamu duduk bersama rekan kerja untuk menuntaskan satu tujuan.',
  'Aturan wajib dinamika diskusi:',
  '1. UJI KRITIS & DEBAT: Jangan langsung setuju begitu saja jika melihat ada kelemahan teknis, risiko, atau opsi yang lebih efektif dari sudut keahlianmu. Sanggah atau tawarkan alternatif yang lebih baik.',
  '2. HAK PASS (TIDAK MENJAWAB): Jika rekan sebelumnya sudah menyampaikan hal yang persis sama dengan pandanganmu dan kamu SEPENUHNYA SEPAKAT tanpa ada sanggahan/tambahan baru, balas HANYA dengan satu kata persis: "PASS". Jangan mengulang poin atau basa-basi "gue setuju".',
  '3. FOKUS & SINGKAT: Jika berbicara, batasi 80-140 kata. Langsung sebut nama rekan yang kamu tanggapi.',
  '4. JANGAN gunakan garis pemisah markdown seperti "---" di teks jawaban.',
  '5. KESEPAKATAN FINAL: Bila perdebatan sudah tuntas, semua pihak sudah saling mufakat atas solusi konkret, tulis keputusan akhirmu dan letakkan kata persis "SELESAI" di baris paling terakhir sendiri.',
].join('\n');

const CHECK_PROMPT = [
  'Kamu adalah ketua sidang/moderator rapat yang tegas dan objektif.',
  'Tugasmu menilai apakah perdebatan/diskusi sudah tuntas mencapai konsensus.',
  '',
  'Kriteria selesai (hanya boleh selesai jika):',
  '- Sudah ada solusi/arsitektur/rencana konkret yang disepakati.',
  '- Tidak ada lagi perdebatan aktif, penolakan, atau pertanyaan baru yang belum dijawab rekan lain.',
  '- Peserta yang lain sudah PASS (setuju) atau mengonfirmasi kesepakatan.',
  '',
  'Balas HANYA JSON valid satu baris, tanpa markdown, tanpa ```, tanpa kalimat lain:',
  '{"selesai":true,"alasan":"<alasan maksimal 15 kata>"}',
  'atau bila masih ada sanggahan atau pertanyaan yang belum dijawab:',
  '{"selesai":false,"alasan":"<poin debat yang masih berlangsung, maks 15 kata>"}',
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

// Cek apakah agent memilih PASS (tidak menjawab karena sudah sependapat)
function isPass(text) {
  if (!text) return true;
  const clean = text.trim().replace(/[*_#`."']/g, '').toUpperCase();
  return clean === 'PASS' || clean.startsWith('PASS ') || clean === 'LEWAT';
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

  const speak = async (agent, round) => {
    let rawOut = '';
    let speechStarted = false;

    await run({
      model: modelFor(agent),
      system: buildSystemPrompt(agent) + '\n\n' + ROOM_EXTRA,
      messages: [
        {
          role: 'user',
          content:
            `Transkrip rapat sejauh ini:\n\n${transcriptText(kept())}\n\n` +
            `Sekarang giliranmu (${agent.name}, ${agent.role}) pada Ronde ${round}.\n` +
            `- Bila ada sanggahan/pandangan lain, sebut nama rekanmu dan sampaikan argumen konkretmu.\n` +
            `- Bila kamu SEPENUHNYA SEPAKAT dengan solusi rekanmu dan tidak ada hal baru yang perlu didebatkan, cukup balas: PASS`,
        },
      ],
      maxTokens,
      onText: (t) => {
        rawOut += t;
        // Hanya stream ke UI jika ternyata bukan cuma PASS
        if (!speechStarted && rawOut.length > 10 && !isPass(rawOut)) {
          speechStarted = true;
          send({
            event: 'speech_start',
            agent: { id: agent.id, name: agent.name, role: agent.role, division: agent.division },
          });
          send({ event: 'speech_delta', t: rawOut });
        } else if (speechStarted) {
          send({ event: 'speech_delta', t });
        }
      },
    });

    const sanitized = sanitizeReply(rawOut);

    // KASUS 1: Agent memilih PASS (tidak menjawab karena sependapat)
    if (isPass(sanitized)) {
      send({
        event: 'system_note',
        text: `${agent.name.split(' ')[0]} sependapat & menyetujui solusi sebelumnya`,
      });
      transcript.push({ who: `${agent.name} (${agent.role})`, text: 'Menyetujui solusi sebelumnya.' });
      return { pass: true, finished: false };
    }

    // Jika belum sempat kirim speech_start (karena teks pendek) tapi bukan pass
    if (!speechStarted) {
      send({
        event: 'speech_start',
        agent: { id: agent.id, name: agent.name, role: agent.role, division: agent.division },
      });
      send({ event: 'speech_delta', t: sanitized });
    }

    const { finished, cleanText } = detectFinished(sanitized);
    transcript.push({ who: `${agent.name} (${agent.role})`, text: cleanText.slice(0, MAX_ENTRY_CHARS) });
    send({ event: 'speech_end', cleanText, who: `${agent.name} (${agent.role})` });

    // Jangan izinkan SELESAI di ronde 1 bila anggota cuma 2 orang (biar ada minimal 1x konfirmasi/tanggapan balik)
    const canFinish = round > 1 || team.length > 3;
    return {
      pass: false,
      finished: canFinish && finished ? `${agent.name.split(' ')[0]} menyatakan kesepakatan tercapai` : null,
    };
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
            `Tujuan rapat:\n${topic}\n\nTranskrip perdebatan & diskusi:\n\n${transcriptText(kept())}\n\n` +
            'Tulis RANGKUMAN KEPUTUSAN FINAL: apa mufakat/keputusan akhir yang disepakati bersama, bagaimana kompromi atas perdebatan yang terjadi, dan pembagian tugas konkret siap pakai.',
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
    let allPassed = true;

    for (const agent of team) {
      if (isClosed()) return;
      drain();
      if (isClosed()) return;
      const res = await speak(agent, round);
      if (!res.pass) allPassed = false;
      if (res.finished && !finishedSignal) finishedSignal = res.finished;
    }
    if (isClosed()) return;
    drain();

    // Jika di ronde ini SEMUA agent memilih PASS, artinya tidak ada lagi yang perlu didebatkan!
    if (allPassed && round > 1) {
      await wrapUp('semua pihak telah sepakat');
      return;
    }

    if (finishedSignal) {
      await wrapUp(finishedSignal);
      return;
    }

    if (maxRounds && round >= maxRounds) {
      await wrapUp(`batas ${maxRounds} ronde tercapai`);
      return;
    }

    send({ event: 'system_note', text: `Mengecek apakah perdebatan ronde ${round} sudah mufakat...` });

    let check = null;
    for (let attempt = 0; attempt < 2 && !check && !isClosed(); attempt++) {
      let raw = '';
      await run({
        model: leaderModel,
        system: CHECK_PROMPT,
        messages: [{ role: 'user', content: `Tujuan rapat:\n${topic}\n\nTranskrip debat:\n\n${transcriptText(kept())}` }],
        maxTokens: 500,
        onText: (t) => { raw += t; },
      });
      check = parseCheck(raw);
    }
    if (isClosed()) return;

    if (check?.selesai) {
      await wrapUp(check.alasan || 'mufakat tercapai');
      return;
    }

    if (!check) {
      badChecks++;
      if (badChecks >= 2) {
        await wrapUp('konsensus ronde tercapai');
        return;
      }
      send({ event: 'system_note', text: `Ronde ${round} selesai. Lanjut perdebatan ronde berikutnya.` });
      continue;
    }

    badChecks = 0;
    send({
      event: 'system_note',
      text: `Ronde ${round} belum mufakat (${check.alasan || 'masih berdebat'}). Lanjut ronde ${round + 1}.`,
    });
  }
}
