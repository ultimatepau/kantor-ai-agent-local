import { AGENTS, agentById, agentsOf, divisionById } from '../shared/roster.js';
import { renderMarkdown } from './md.js';
import { getHistory, setHistory, clearHistory, streamChat, streamDiscuss, sayTo } from './chat.js';

const $ = (id) => document.getElementById(id);
const initials = (name) => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function createPanel({ onSelect, onClose, onStatus, onNeedCode, isDemo }) {
  const els = {
    avatar: $('avatar'),
    name: $('who-name'),
    role: $('who-role'),
    mates: $('mates'),
    messages: $('messages'),
    quick: $('quick'),
    form: $('composer'),
    input: $('input'),
    send: $('btn-send'),
    stop: $('btn-stop'),
    reset: $('btn-reset'),
    close: $('btn-close'),
    discuss: $('btn-discuss'),
  };

  let currentId = null;
  const live = new Map(); // agentId -> { text, el, abort }

  // State mode diskusi
  let discussMode = false;
  let activeDiscuss = null; // { id, topic, participants, text, el, abort }
  let selectedParticipants = new Set();
  const discussHistory = new Map(); // agentId/host -> [{ who, text }]
  const discussDoms = new Map(); // agentId/host -> HTMLElement[] anak-anak dom chat rapat

  const scrollDown = (force = false) => {
    const m = els.messages;
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
    if (force || near) m.scrollTop = m.scrollHeight;
  };

  function bubble(role, html, { text } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const b = document.createElement('div');
    b.className = 'bubble';
    if (role === 'user') b.textContent = text;
    else b.innerHTML = html;
    wrap.appendChild(b);
    if (role === 'assistant') {
      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.innerHTML = '<button type="button" data-copy>Salin</button>';
      wrap.appendChild(tools);
    }
    return wrap;
  }

  const typingHtml = '<span class="typing" aria-label="Sedang mengetik"><i></i><i></i><i></i></span>';

  function paint(l) {
    if (!l.el) return;
    const b = l.el.querySelector('.bubble');
    b.innerHTML = l.text ? renderMarkdown(l.text) : typingHtml;
    scrollDown();
  }

  function renderEmpty(agent) {
    const first = agent.name.split(' ')[0];
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = `<b>Halo, gue ${first}</b>${agent.role}. Tanya soal ${agent.focus}.`;
    els.messages.appendChild(e);
    els.quick.innerHTML = '';
    for (const q of agent.quick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q';
      btn.textContent = q;
      btn.addEventListener('click', () => submit(q));
      els.quick.appendChild(btn);
    }
  }

  function renderDiscussSetup() {
    const host = agentById(currentId);
    if (!selectedParticipants.size) {
      selectedParticipants = new Set([host.id]);
      const sameDiv = agentsOf(host.division).find((m) => m.id !== host.id);
      if (sameDiv) selectedParticipants.add(sameDiv.id);
    }

    const box = document.createElement('div');
    box.className = 'discuss-setup';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h4>👥 Mode Diskusi / Townhall</h4>
        <div style="display:flex;gap:6px;">
          <button type="button" id="btn-select-div" class="btn-micro">Pilih 1 Divisi</button>
          <button type="button" id="btn-select-all" class="btn-micro">Pilih Semua (${AGENTS.length})</button>
        </div>
      </div>
      <p style="margin:0;font-size:12px;color:var(--ink-soft)">
        Pilih peserta (bebas, bisa sampai seluruh kantor untuk Townhall). Tulis tujuan di bawah untuk mulai.
      </p>
      <div class="discuss-roster"></div>
    `;

    box.querySelector('#btn-select-all').addEventListener('click', () => {
      selectedParticipants = new Set(AGENTS.map((a) => a.id));
      render(currentId);
    });

    box.querySelector('#btn-select-div').addEventListener('click', () => {
      selectedParticipants = new Set(agentsOf(host.division).map((a) => a.id));
      render(currentId);
    });

    const rosterEl = box.querySelector('.discuss-roster');
    const ordered = [host, ...AGENTS.filter((a) => a.id !== host.id)];
    for (const a of ordered) {
      const lbl = document.createElement('label');
      lbl.className = 'chip-pick';
      const checked = selectedParticipants.has(a.id);
      lbl.innerHTML = `
        <input type="checkbox" value="${a.id}" ${checked ? 'checked' : ''} />
        <span>${a.name.split(' ')[0]}</span>
        <i>${a.role.split(' ')[0]}</i>
      `;
      const cb = lbl.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selectedParticipants.add(a.id);
        } else {
          if (selectedParticipants.size <= 2) {
            cb.checked = true;
            return;
          }
          selectedParticipants.delete(a.id);
        }
        syncSend();
      });
      rosterEl.appendChild(lbl);
    }
    els.messages.appendChild(box);
  }

  function render(agentId) {
    const agent = agentById(agentId);
    const div = divisionById(agent.division);
    document.body.style.setProperty('--c', div.color);
    els.avatar.style.setProperty('--c', div.color);
    els.avatar.textContent = initials(agent.name);
    els.name.textContent = agent.name;
    els.role.textContent = `${agent.role} · ${div.name}`;

    els.discuss.setAttribute('aria-pressed', String(discussMode));

    // rekan satu divisi
    els.mates.innerHTML = '';
    const team = agentsOf(agent.division);
    if (team.length > 1) {
      for (const m of team) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mate';
        b.style.setProperty('--c', div.color);
        b.setAttribute('aria-current', String(m.id === agentId));
        b.innerHTML = `<i>${initials(m.name)}</i>${m.name.split(' ')[0]}`;
        b.addEventListener('click', () => onSelect(m.id));
        els.mates.appendChild(b);
      }
    }

    els.messages.innerHTML = '';
    els.quick.innerHTML = '';

    if (activeDiscuss) {
      const banner = document.createElement('div');
      banner.className = 'discuss-banner';
      banner.innerHTML = `<span>👥 Diskusi tim sedang jalan...</span>`;
      els.messages.appendChild(banner);
      activeDiscuss.el = bubble('assistant', typingHtml);
      els.messages.appendChild(activeDiscuss.el);
      paint(activeDiscuss);
      scrollDown(true);
      syncSend();
      return;
    }

    if (discussMode) {
      const pastDoms = discussDoms.get(agentId) || [];
      if (pastDoms.length) {
        for (const node of pastDoms) els.messages.appendChild(node);
      } else {
        renderDiscussSetup();
      }
      scrollDown(true);
      syncSend();
      return;
    }

    const history = getHistory(agentId);
    const l = live.get(agentId);
    if (!history.length && !l) renderEmpty(agent);
    for (const m of history) {
      els.messages.appendChild(m.role === 'user' ? bubble('user', '', { text: m.content }) : bubble('assistant', renderMarkdown(m.content)));
    }
    if (l) {
      l.el = bubble('assistant', typingHtml);
      els.messages.appendChild(l.el);
      paint(l);
    }
    scrollDown(true);
    syncSend();
  }

  function syncSend() {
    const hasActiveDiscuss = Boolean(activeDiscuss);
    const busyAgent = live.has(currentId);

    if (hasActiveDiscuss) {
      // Saat diskusi aktif: tombol stop muncul, tombol kirim jadi tombol interupsi/sanggah
      els.stop.hidden = false;
      els.send.disabled = !els.input.value.trim();
      els.send.title = 'Sela / sanggah diskusi';
      els.input.placeholder = 'Sela atau sanggah diskusi ini (masuk sebelum giliran berikutnya)…';
      return;
    }

    els.stop.hidden = true;
    els.send.title = 'Kirim';

    if (discussMode) {
      els.send.disabled = selectedParticipants.size < 2 || !els.input.value.trim();
      els.input.placeholder = `Tulis goal rapat (${selectedParticipants.size} anggota terpilih)…`;
      return;
    }

    els.send.disabled = busyAgent || !els.input.value.trim();
    els.input.placeholder = busyAgent ? `${agentById(currentId).name.split(' ')[0]} lagi ngetik…` : 'Tulis pesan…';
  }

  function bubbleWithAuthor(agent, html, isSummary = false) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const div = divisionById(agent.division);

    const author = document.createElement('div');
    author.className = 'discuss-author';
    if (div?.color) author.style.setProperty('--c', div.color);
    author.innerHTML = isSummary
      ? `<b>✅ Kesimpulan Rapat</b> <span>· dirangkum ${agent.name.split(' ')[0]}</span>`
      : `<b>${agent.name.split(' ')[0]}</b> <span>· ${agent.role}</span>`;
    wrap.appendChild(author);

    const b = document.createElement('div');
    b.className = 'bubble' + (isSummary ? ' discuss-summary' : '');
    b.innerHTML = html;
    wrap.appendChild(b);

    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.innerHTML = '<button type="button" data-copy>Salin</button>';
    wrap.appendChild(tools);
    return wrap;
  }

  function systemPill(text) {
    const p = document.createElement('div');
    p.className = 'system-pill';
    p.textContent = text;
    return p;
  }

  async function submitDiscuss(topic) {
    topic = (topic || '').trim();
    const hostId = currentId;
    if (!topic || activeDiscuss || selectedParticipants.size < 2 || !hostId) return;

    const list = Array.from(selectedParticipants);
    const discId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const currentHist = discussHistory.get(hostId) || [];

    const d = {
      id: discId,
      hostId,
      topic,
      participants: list,
      currentBubble: null,
      currentText: '',
      abort: new AbortController(),
    };
    activeDiscuss = d;

    // Bersihkan form setup awal bila ini pesan pertama
    els.messages.querySelector('.discuss-setup')?.remove();

    // Jika ini diskusi baru (bukan lanjutan), tambahkan banner
    if (!currentHist.length) {
      const banner = document.createElement('div');
      banner.className = 'discuss-banner';
      banner.innerHTML = `<span>👥 Rapat: <b>${topic.slice(0, 60)}</b> (${list.length} orang)</span>`;
      els.messages.appendChild(banner);
    } else {
      // Jika kelanjutan, tambahkan bubble user dengan jelas di transkrip
      els.messages.appendChild(bubble('user', '', { text: topic }));
    }

    els.input.value = '';
    autosize();
    scrollDown(true);
    for (const pid of list) onStatus(pid, 'working');
    syncSend();

    const updateCurrent = (text) => {
      if (!d.currentBubble) return;
      const b = d.currentBubble.querySelector('.bubble');
      b.innerHTML = text ? renderMarkdown(text) : typingHtml;
      scrollDown();
    };

    const remember = (who, text) => {
      if (!text) return;
      const h = discussHistory.get(hostId) || [];
      h.push({ who, text });
      discussHistory.set(hostId, h);
    };

    try {
      await streamDiscuss(discId, topic, list, currentHist, {
        signal: d.abort.signal,
        onEvent: (evt) => {
          switch (evt.event) {
            case 'start':
              els.messages.appendChild(systemPill(evt.isFollowUp ? `Arahan baru: "${topic}"` : `Rapat dimulai dengan tujuan: "${topic}"`));
              scrollDown(true);
              break;

            case 'user_interrupt':
              els.messages.appendChild(bubble('user', '', { text: evt.text }));
              remember('User (moderator)', evt.text);
              scrollDown(true);
              break;

            case 'speech_start':
              d.currentText = '';
              d.currentBubble = bubbleWithAuthor(evt.agent, typingHtml, false);
              els.messages.appendChild(d.currentBubble);
              scrollDown(true);
              break;

            case 'speech_delta':
              d.currentText += evt.t;
              updateCurrent(d.currentText);
              break;

            case 'speech_end':
              if (d.currentBubble) {
                const clean = evt.cleanText || d.currentText;
                d.currentBubble.querySelector('.bubble').innerHTML = renderMarkdown(clean);
                remember(evt.who || `${evt.agent?.name}`, clean);
                d.currentBubble = null;
                d.currentText = '';
                scrollDown(true);
              }
              break;

            case 'summary_start':
              d.currentText = '';
              d.currentBubble = bubbleWithAuthor(evt.agent, typingHtml, true);
              els.messages.appendChild(d.currentBubble);
              scrollDown(true);
              break;

            case 'summary_delta':
              d.currentText += evt.t;
              updateCurrent(d.currentText);
              break;

            case 'summary_end':
              if (d.currentBubble) {
                const clean = evt.cleanText || d.currentText;
                d.currentBubble.querySelector('.bubble').innerHTML = renderMarkdown(clean);
                remember(evt.who || 'Kesimpulan', clean);
                d.currentBubble = null;
                d.currentText = '';
                scrollDown(true);
              }
              break;

            case 'system_note':
              els.messages.appendChild(systemPill(evt.text));
              scrollDown(true);
              break;

            case 'closed':
              els.messages.appendChild(systemPill(`🟢 Rapat selesai & ditutup${evt.reason ? ` (${evt.reason})` : ''}`));
              scrollDown(true);
              break;
          }
        },
      });

      // Simpan DOM saat ini untuk host tersebut
      discussDoms.set(hostId, Array.from(els.messages.children));
      activeDiscuss = null;
      for (const pid of list) onStatus(pid, 'done');
    } catch (err) {
      discussDoms.set(hostId, Array.from(els.messages.children));
      activeDiscuss = null;
      for (const pid of list) onStatus(pid, 'idle');
      if (err.name !== 'AbortError') {
        const e = bubble('assistant', '');
        e.classList.add('error');
        e.querySelector('.bubble').textContent = err.message;
        e.querySelector('.tools')?.remove();
        els.messages.appendChild(e);
        if (err.code === 401) onNeedCode();
      }
    } finally {
      syncSend();
    }
  }

  async function interruptDiscuss(text) {
    if (!activeDiscuss) return;
    text = (text || '').trim();
    if (!text) return;
    els.input.value = '';
    autosize();
    const ok = await sayTo(activeDiscuss.id, text);
    if (!ok) {
      const note = bubble('assistant', '');
      note.classList.add('error');
      note.querySelector('.bubble').textContent = 'Gagal menyelakan — antrean sela penuh atau rapat sudah selesai.';
      els.messages.appendChild(note);
      scrollDown(true);
    }
  }

  function stopDiscuss() {
    if (!activeDiscuss) return;
    activeDiscuss.abort.abort();
    for (const pid of activeDiscuss.participants) onStatus(pid, 'idle');
    els.messages.appendChild(systemPill('⏹️ Rapat dihentikan oleh moderator'));
    activeDiscuss = null;
    scrollDown(true);
    syncSend();
  }

  async function submit(text) {
    text = (text || '').trim();
    if (!text) return;

    if (activeDiscuss) {
      await interruptDiscuss(text);
      return;
    }

    if (discussMode) {
      await submitDiscuss(text);
      return;
    }

    const id = currentId;
    if (!id || live.has(id)) return;

    const history = getHistory(id);
    const sent = [...history, { role: 'user', content: text }];
    setHistory(id, sent);

    els.messages.querySelector('.empty')?.remove();
    els.quick.innerHTML = '';
    els.messages.appendChild(bubble('user', '', { text }));
    els.input.value = '';
    autosize();

    const l = { text: '', el: null, abort: new AbortController() };
    live.set(id, l);
    l.el = bubble('assistant', typingHtml);
    els.messages.appendChild(l.el);
    scrollDown(true);
    onStatus(id, 'working');
    syncSend();

    try {
      const full = await streamChat(id, sent, {
        signal: l.abort.signal,
        onText: (_t, all) => {
          l.text = all;
          if (!l.raf) {
            l.raf = requestAnimationFrame(() => {
              l.raf = 0;
              paint(l);
            });
          }
        },
      });
      setHistory(id, [...sent, { role: 'assistant', content: full }]);
      live.delete(id);
      if (l.el && currentId === id) l.el.querySelector('.bubble').innerHTML = renderMarkdown(full);
      onStatus(id, 'done');
    } catch (err) {
      live.delete(id);
      onStatus(id, 'idle');
      if (err.name === 'AbortError') {
        setHistory(id, sent.slice(0, -1));
      } else {
        setHistory(id, sent.slice(0, -1));
        if (currentId === id) {
          l.el?.remove();
          const e = bubble('assistant', '');
          e.classList.add('error');
          e.querySelector('.bubble').textContent = err.message;
          e.querySelector('.tools')?.remove();
          els.messages.appendChild(e);
          els.input.value = text;
          autosize();
          scrollDown(true);
        }
        if (err.code === 401) onNeedCode();
      }
    } finally {
      if (currentId === id) syncSend();
    }
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
  }

  // ---------- event ----------
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(els.input.value);
  });
  els.input.addEventListener('input', () => {
    autosize();
    syncSend();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(els.input.value);
    }
  });
  els.stop.addEventListener('click', stopDiscuss);
  els.discuss.addEventListener('click', () => {
    if (activeDiscuss) return;
    discussMode = !discussMode;
    if (currentId) render(currentId);
  });
  els.close.addEventListener('click', () => onClose());
  els.reset.addEventListener('click', () => {
    if (activeDiscuss) stopDiscuss();
    if (!currentId) return;
    live.get(currentId)?.abort.abort();
    clearHistory(currentId);
    discussHistory.delete(currentId);
    discussDoms.delete(currentId);
    render(currentId);
  });
  els.messages.addEventListener('click', (e) => {
    const copyCode = e.target.closest('.copy');
    const copyMsg = e.target.closest('[data-copy]');
    const flash = (btn, t) => {
      const old = btn.textContent;
      btn.textContent = t;
      setTimeout(() => { btn.textContent = old; }, 1200);
    };
    const write = async (text, btn) => {
      try {
        await navigator.clipboard.writeText(text);
        flash(btn, 'Tersalin');
      } catch {
        flash(btn, 'Gagal');
      }
    };
    if (copyCode) write(copyCode.parentElement.querySelector('code').textContent, copyCode);
    else if (copyMsg) write(copyMsg.closest('.msg').querySelector('.bubble').innerText, copyMsg);
  });

  return {
    open(agentId) {
      currentId = agentId;
      render(agentId);
      if (isDemo()) document.getElementById('banner').hidden = false;
      setTimeout(() => {
        if (matchMedia('(hover: hover)').matches) els.input.focus({ preventScroll: true });
      }, 350);
    },
    close() {
      currentId = null;
    },
    get current() {
      return currentId;
    },
  };
}
