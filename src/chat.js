// Klien chat: simpan riwayat per karyawan (localStorage, opsional) dan baca stream SSE dari /api/chat.

const KEY_HISTORY = 'kantorai.history.v1';
const KEY_CODE = 'kantorai.code';

const safe = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* abaikan */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* abaikan */ }
  },
};

let histories = {};
try { histories = JSON.parse(safe.get(KEY_HISTORY) || '{}') || {}; } catch { histories = {}; }

const persist = () => safe.set(KEY_HISTORY, JSON.stringify(histories));

export const getHistory = (id) => histories[id] || [];
export function setHistory(id, list) {
  histories[id] = list.slice(-40);
  persist();
}
export function clearHistory(id) {
  delete histories[id];
  persist();
}

export const getCode = () => safe.get(KEY_CODE) || '';
export const setCode = (c) => (c ? safe.set(KEY_CODE, c) : safe.del(KEY_CODE));

export async function fetchConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('config');
    return await r.json();
  } catch {
    return { demo: false, needsCode: false, offline: true };
  }
}

export async function updateModels({ modelLeader, modelTeam, localUrl, localKey }) {
  const r = await fetch('/api/config/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
    body: JSON.stringify({ modelLeader, modelTeam, localUrl, localKey }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'Gagal mengubah model.');
  }
  return await r.json();
}

export async function fetchRemoteModels(base, key) {
  const params = new URLSearchParams();
  if (base) params.set('base', base);
  if (key !== undefined) params.set('key', key);
  const r = await fetch(`/api/config/fetch-models?${params.toString()}`, {
    headers: { 'x-access-code': getCode() },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'Gagal mengambil daftar model dari endpoint.');
  }
  return await r.json();
}

async function postJSON(url, body, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Tidak bisa menghubungi server. Cek koneksi atau pastikan backend jalan.');
  }

  if (!res.ok) {
    let msg = 'Terjadi kesalahan.';
    try { msg = (await res.json()).error || msg; } catch { /* abaikan */ }
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }
  return res;
}

// Baca stream SSE: onText(potongan, teksPenuh). Melempar Error jika server kirim {error} atau response tidak ok.
async function readSSE(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(raw.slice(5).trim()); } catch { continue; }
      if (evt.error) throw new Error(evt.error);
      if (evt.t) {
        full += evt.t;
        onText?.(evt.t, full);
      }
    }
  }
  return full;
}

// Mengirim riwayat + pesan baru. Memanggil onText(potongan) saat streaming.
// Melempar Error dengan .code === 401 bila kode akses salah.
export async function streamChat(agentId, messages, { onText, signal }) {
  const res = await postJSON('/api/chat', { agentId, messages }, signal);
  return readSSE(res, onText);
}

// Diskusi tim: server yang mengatur giliran sampai tujuan tercapai. Mengirim event terstruktur ke onEvent.
export async function streamDiscuss(id, topic, participants, { onEvent, signal }) {
  const res = await postJSON('/api/discuss', { id, topic, participants }, signal);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(raw.slice(5).trim()); } catch { continue; }
      if (evt.error) throw new Error(evt.error);
      onEvent?.(evt);
    }
  }
}

// Menyelakan pendapat user ke diskusi yang sedang jalan (dibacakan sebelum giliran berikutnya).
export async function sayTo(id, text) {
  const r = await fetch('/api/discuss/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
    body: JSON.stringify({ id, text }),
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return Boolean(j.ok);
}