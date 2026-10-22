// Model lokal (llama.cpp / LM Studio / Ollama / llamafile) lewat API OpenAI-compatible.
// Dipakai bila MODEL_LEADER / MODEL_TEAM diawali "local:", contoh: local:qwen3-8b
export const isLocal = (model = '') => String(model).startsWith('local:');

let runtimeBase = (process.env.LOCAL_LLM_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
let runtimeKey = process.env.LOCAL_LLM_KEY || '';
let runtimeNoThink = process.env.LOCAL_NO_THINK !== '0';

export const localBase = () => runtimeBase;
export const localKey = () => runtimeKey;

export function updateLocalConfig({ base, key }) {
  if (base !== undefined) runtimeBase = String(base).trim().replace(/\/$/, '');
  if (key !== undefined) runtimeKey = String(key).trim();
}

// Fetch model list dari OpenAI-compatible /v1/models
export async function fetchRemoteModels(base = runtimeBase, key = runtimeKey) {
  const url = `${base.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}

const cfg = () => ({
  base: runtimeBase,
  key: runtimeKey,
  noThink: runtimeNoThink,
});

// Buang blok <think>...</think> (mode thinking Qwen3) dari stream, termasuk tag yang terpotong antar potongan.
function thinkFilter() {
  let inThink = false;
  let buf = '';
  const OPEN = '<think>';
  const CLOSE = '</think>';
  const partial = (s, tag) => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n -= 1) if (tag.startsWith(s.slice(-n))) return n;
    return 0;
  };
  return {
    push(chunk) {
      buf += chunk;
      let out = '';
      for (;;) {
        if (inThink) {
          const i = buf.indexOf(CLOSE);
          if (i < 0) { buf = buf.slice(Math.max(0, buf.length - (CLOSE.length - 1))); return out; }
          buf = buf.slice(i + CLOSE.length).replace(/^\s+/, '');
          inThink = false;
        } else {
          const i = buf.indexOf(OPEN);
          if (i >= 0) { out += buf.slice(0, i); buf = buf.slice(i + OPEN.length); inThink = true; continue; }
          const keep = partial(buf, OPEN);
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          return out;
        }
      }
    },
    flush() { const r = inThink ? '' : buf; buf = ''; return r; },
  };
}

// messages: [{role, content:string}] (format yang sama dengan server). Mengembalikan { input, output } token.
export async function streamLocal({ model, system, messages, maxTokens = 1500, signal, onText }) {
  const c = cfg();
  const msgs = [{ role: 'system', content: system }, ...messages];

  const thinkFlags = c.noThink
    ? {
        chat_template_kwargs: { thinking: false },
        enable_thinking: false,
        reasoning: { enabled: false, effort: 'none' },
      }
    : {};

  const request = (extra) =>
    fetch(`${c.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
      body: JSON.stringify({
        model: model.slice('local:'.length) || 'local',
        messages: msgs,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.6,
        ...extra,
      }),
      signal,
    });

  let res;
  try {
    res = await request(thinkFlags);
    if (!res.ok && res.status === 400 && c.noThink) res = await request({});
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error(`Server model lokal tidak bisa dihubungi di ${c.base}. Pastikan llama-server / LM Studio sedang jalan.`), { local: true });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw Object.assign(new Error(`Model lokal membalas HTTP ${res.status}: ${body}`), { local: true });
  }

  const usage = { input: 0, output: 0, content: 0, reasoning: 0, truncated: false };
  let finish = '';
  let reasoningChars = 0;
  const filter = thinkFilter();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!raw.startsWith('data:')) continue;
      const dataStr = raw.slice(5).trim();
      if (dataStr === '[DONE]') continue;
      let j;
      try { j = JSON.parse(dataStr); } catch { continue; }
      const c0 = j.choices?.[0];
      if (c0?.finish_reason) finish = c0.finish_reason;
      const delta = c0?.delta || {};
      if (delta.reasoning_content) reasoningChars += delta.reasoning_content.length;
      const txt = delta.content || '';
      if (txt) {
        const emit = filter.push(txt);
        if (emit) onText?.(emit);
      }
      if (j.usage) {
        usage.input = j.usage.prompt_tokens || usage.input;
        usage.output = j.usage.completion_tokens || usage.output;
        usage.reasoning = j.usage.completion_tokens_details?.reasoning_tokens || usage.reasoning;
      }
    }
  }

  const tail = filter.flush();
  if (tail) onText?.(tail);

  if (!usage.reasoning && reasoningChars > 0) {
    usage.reasoning = Math.round(reasoningChars / 3.5);
  }
  usage.truncated = finish === 'length';
  return usage;
}
