'use strict';

const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function logoHtml() {
  return `<span class="logo-mark">${LOGO_SVG}</span>done`;
}

document.querySelectorAll('[data-logo]').forEach((el) => { el.innerHTML = logoHtml(); });

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Reconnecting WebSocket. `hello` is sent on every (re)connect.
function connectSocket(hello, onMessage, onStatus = () => {}) {
  let ws;
  let retry = 0;
  let closed = false;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onStatus(true);
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      onStatus(false);
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 500 * 2 ** retry);
    };
  }

  open();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState > 1 && !closed) open();
  });
  return { close() { closed = true; ws.close(); } };
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
  return value;
}

function slugFromPath() {
  return decodeURIComponent(location.pathname.split('/')[2] || '');
}

function tokenFromHash() {
  return new URLSearchParams(location.hash.slice(1)).get('t') || '';
}

function qrSrc(text) {
  return `/qr.svg?d=${encodeURIComponent(text)}`;
}

function elapsed(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small Web Audio chime – no audio files needed. Must be unlocked by a user gesture first.
const chime = {
  ctx: null,
  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.ctx) this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  play(notes = [880, 1175, 1568], gap = 0.16) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + i * gap;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  },
};
