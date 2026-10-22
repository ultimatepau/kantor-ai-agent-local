// Delegasi: leader memecah tugas -> anggota tim mengerjakan -> leader mereview & merangkum.
// Deterministik (dikendalikan server), jadi tidak bergantung pada tool-calling model kecil.
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
  // Ekstrak blok JSON pertama yang valid
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return [];

  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    // Coba bersihkan karakter escape atau trailing comma jika ada
    try {
      const cleaned = m[0].replace(/,\s*([}\]])/g, '$1');
      obj = JSON.parse(cleaned);
    } catch {
      return [];
    }
  }

  const ids = new Set(team.map((t) => t.id.toLowerCase()));
  const seen = new Set();
  const out = [];

  for (const t of Array.isArray(obj?.tugas) ? obj.tugas : []) {
    const rawId = String(t?.agent || '').toLowerCase().trim();
    // Cocokkan id persis atau nama depan karyawan (misal: "maya" dari "Maya Anggraini")
    const matched = team.find((x) => x.id.toLowerCase() === rawId || x.name.toLowerCase().includes(rawId));
    const brief = String(t?.brief || '').trim().slice(0, 800);

    if (!matched || !brief || seen.has(matched.id)) continue;
    seen.add(matched.id);
    out.push({ member: matched, brief });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

// Fallback cerdas: jika model gagal output JSON, server secara deterministik
// menugaskan anggota tim yang paling relevan berdasarkan keyword pesan user.
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
  // Pilih anggota terbaik atau fallback ke anggota pertama
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

  const lastMsg = messages[messages.length - 1].content;
  // Jangan buang kata delegasi jika merusak makna, cukup ambil pesan utuh user
  const userMsg = lastMsg;

  // 1) Rencana pembagian tugas
  send({ t: `🧭 **${leader.name.split(' ')[0]}** sedang membagi tugas ke tim...\n\n` });
  const planMessages = [{ role: 'user', content: `Permintaan user yang harus kamu bagi ke timmu:\n"${userMsg}"` }];

  const askPlan = async () => {
    let text = '';
    await run({
      model: modelFor(leader),
      system: buildSystemPrompt(leader) + '\n\n' + planPrompt(team),
      messages: planMessages,
      maxTokens: 800, // Beri kuota cukup untuk model reasoning / JSON
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

  // JIKA MODEL TETAP GAGAL MENGELUARKAN JSON:
  // JANGAN menyerah / batalkan delegasi! Server otomatis menugaskan anggota yang cocok (misal: Maya).
  if (!plan.length) {
    console.warn('[delegate] Fallback ke penugasan otomatis heuristik tim.');
    plan = heuristicPlan(userMsg, team);
  }

  // 2) Anggota tim langsung mengeksekusi tugasnya secara realtime
  const results = [];
  for (const { member, brief } of plan) {
    if (isClosed()) return;
    send({ t: `\n---\n### 👤 ${member.name.split(' ')[0]} (${member.role})\n_Tugas: ${brief}_\n\n` });
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
        send({ t });
      },
    });
    results.push({ member, brief, out: out.trim() });
  }

  // 3) Leader mereview hasil kerja tim dan memberikan kesimpulan akhir
  if (isClosed()) return;
  send({ t: `\n---\n### 🧑‍💼 Review & Rangkuman ${leader.name.split(' ')[0]}\n\n` });
  const bundle = results
    .map((r) => `## ${r.member.name} (${r.member.role})\nTugas: ${r.brief}\nHasil kerja:\n${r.out}`)
    .join('\n\n');

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
    onText: (t) => send({ t }),
  });
}
