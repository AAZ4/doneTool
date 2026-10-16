'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

const CODE_SLOT_MS = 60 * 1000;        // rotating TV code changes every minute
const CODE_VALID_SLOTS = 3;            // current code + the two before it are accepted
const RING_INTERVAL_MS = 45 * 1000;    // re-ring a ready ticket nobody reacted to
const MAX_RINGS = 3;
const TICKET_TTL_MS = 12 * 60 * 60 * 1000; // tickets are deleted after 12 hours (data minimisation)

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { restaurants: {}, tickets: {} };
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 300);
}

// On hosts with an ephemeral disk (e.g. Render) set the keys as env vars, otherwise they change on every deploy.
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:kontakt@done.example', vapid.publicKey, vapid.privateKey);

// ---------- helpers ----------

const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function berlinDay(date = new Date()) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

function slugify(name) {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'laden';
  let slug = base;
  while (db.restaurants[slug]) slug = `${base}-${crypto.randomInt(100, 999)}`;
  return slug;
}

function rotatingCode(restaurant, slot) {
  return crypto.createHmac('sha256', restaurant.codeSecret).update(String(slot)).digest('base64url').slice(0, 8);
}

function currentSlot() {
  return Math.floor(Date.now() / CODE_SLOT_MS);
}

function isValidEntryKey(restaurant, key) {
  if (!key) return false;
  if (safeEqual(key, restaurant.stickerKey)) return true;
  const slot = currentSlot();
  for (let i = 0; i < CODE_VALID_SLOTS; i++) {
    if (safeEqual(key, rotatingCode(restaurant, slot - i))) return true;
  }
  return false;
}

function publicTicket(t) {
  const r = db.restaurants[t.slug];
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    alert: t.alert,
    coming: t.coming,
    ringCount: t.ringCount,
    createdAt: t.createdAt,
    readyAt: t.readyAt,
    restaurantName: r ? r.name : '',
  };
}

function staffTicket(t) {
  return { ...publicTicket(t), source: t.source, hasPush: Boolean(t.push), doneAt: t.doneAt };
}

function staffState(slug) {
  const r = db.restaurants[slug];
  const tickets = Object.values(db.tickets)
    .filter((t) => t.slug === slug)
    .sort((a, b) => a.createdAt - b.createdAt);
  const open = tickets.filter((t) => t.status !== 'done');
  const done = tickets.filter((t) => t.status === 'done').slice(-12).reverse();
  return { restaurant: { slug: r.slug, name: r.name }, tickets: [...open, ...done].map(staffTicket) };
}

function newTicket(restaurant, source) {
  const today = berlinDay();
  if (restaurant.day !== today) {
    restaurant.day = today;
    restaurant.nextNumber = 1;
  }
  const ticket = {
    id: randomToken(9),
    slug: restaurant.slug,
    number: restaurant.nextNumber++,
    guestToken: randomToken(),
    source,
    status: 'preparing',
    alert: false,
    coming: false,
    push: null,
    ringCount: 0,
    lastRingAt: null,
    createdAt: Date.now(),
    readyAt: null,
    doneAt: null,
  };
  db.tickets[ticket.id] = ticket;
  save();
  return ticket;
}

// ---------- realtime ----------

const guestSockets = new Map(); // ticketId -> Set<ws>
const staffSockets = new Map(); // slug -> Set<ws>

function addSocket(map, key, ws) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(ws);
  ws.on('close', () => {
    const set = map.get(key);
    if (!set) return;
    set.delete(ws);
    if (!set.size) map.delete(key);
  });
}

function send(set, message) {
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
}

function broadcastStaff(slug) {
  send(staffSockets.get(slug), { type: 'state', ...staffState(slug) });
}

function broadcastTicket(ticket, extra = {}) {
  send(guestSockets.get(ticket.id), { type: 'ticket', ticket: publicTicket(ticket), ...extra });
  broadcastStaff(ticket.slug);
}

async function sendPush(ticket) {
  if (!ticket.push) return;
  const r = db.restaurants[ticket.slug];
  const payload = JSON.stringify({
    title: 'Dein Essen ist fertig!',
    body: `Nummer ${ticket.number} – bitte an der Theke abholen.${r ? ' ' + r.name : ''}`,
    tag: `done-${ticket.id}`,
    url: `/r/${ticket.slug}`,
  });
  try {
    await webpush.sendNotification(ticket.push, payload, { TTL: 600, urgency: 'high' });
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      ticket.push = null;
      save();
      broadcastStaff(ticket.slug);
    } else {
      console.warn('Push fehlgeschlagen:', err.statusCode || err.message);
    }
  }
}

function ring(ticket) {
  ticket.ringCount += 1;
  ticket.lastRingAt = Date.now();
  save();
  broadcastTicket(ticket, { ring: true });
  sendPush(ticket);
}

// Re-ring ready tickets until the guest reacts, and delete old tickets.
setInterval(() => {
  const now = Date.now();
  for (const t of Object.values(db.tickets)) {
    if (now - t.createdAt > TICKET_TTL_MS) {
      delete db.tickets[t.id];
      save();
      continue;
    }
    if (t.status === 'ready' && !t.coming && t.alert && t.ringCount < MAX_RINGS && now - t.lastRingAt >= RING_INTERVAL_MS) {
      ring(t);
    }
  }
}, 5000);

// ---------- http ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.use((req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

function requireStaff(req, res, next) {
  const r = db.restaurants[req.params.slug];
  if (!r || !safeEqual(req.get('x-staff-token'), r.staffToken)) {
    return res.status(403).json({ error: 'Kein Zugriff' });
  }
  req.restaurant = r;
  next();
}

function requireGuest(req, res, next) {
  const t = db.tickets[req.params.id];
  if (!t || !safeEqual(req.get('x-guest-token'), t.guestToken)) {
    return res.status(404).json({ error: 'Nummer nicht gefunden' });
  }
  req.ticket = t;
  next();
}

app.get('/api/vapid', (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/restaurants', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Bitte gib den Namen deines Ladens ein.' });
  const r = {
    slug: slugify(name),
    name,
    staffToken: randomToken(),
    stickerKey: randomToken(8),
    codeSecret: randomToken(24),
    day: berlinDay(),
    nextNumber: 1,
    createdAt: Date.now(),
  };
  db.restaurants[r.slug] = r;
  save();
  res.status(201).json({ slug: r.slug, name: r.name, staffToken: r.staffToken });
});

app.get('/api/r/:slug', (req, res) => {
  const r = db.restaurants[req.params.slug];
  if (!r) return res.status(404).json({ error: 'Laden nicht gefunden' });
  res.json({ slug: r.slug, name: r.name });
});

// Guest scans the QR code -> gets the next number.
app.post('/api/r/:slug/tickets', (req, res) => {
  const r = db.restaurants[req.params.slug];
  if (!r) return res.status(404).json({ error: 'Laden nicht gefunden' });
  if (!isValidEntryKey(r, req.body.key)) {
    return res.status(403).json({ error: 'Der QR-Code ist abgelaufen. Bitte scanne den Code an der Theke erneut.' });
  }
  const t = newTicket(r, 'guest');
  broadcastStaff(r.slug);
  res.status(201).json({ ticket: publicTicket(t), guestToken: t.guestToken });
});

app.get('/api/tickets/:id', requireGuest, (req, res) => res.json({ ticket: publicTicket(req.ticket) }));

app.post('/api/tickets/:id/alert', requireGuest, (req, res) => {
  const t = req.ticket;
  t.alert = true;
  const sub = req.body.subscription;
  if (sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys) {
    t.push = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
  }
  save();
  broadcastTicket(t);
  res.json({ ticket: publicTicket(t) });
});

app.post('/api/tickets/:id/coming', requireGuest, (req, res) => {
  const t = req.ticket;
  t.coming = true;
  save();
  broadcastTicket(t);
  res.json({ ticket: publicTicket(t) });
});

app.get('/api/r/:slug/staff', requireStaff, (req, res) => {
  res.json({ ...staffState(req.restaurant.slug), stickerKey: req.restaurant.stickerKey });
});

// Ticket for a guest without smartphone (number is called out / shown on the TV).
app.post('/api/r/:slug/manual', requireStaff, (req, res) => {
  const t = newTicket(req.restaurant, 'manual');
  broadcastStaff(t.slug);
  res.status(201).json({ ticket: staffTicket(t) });
});

app.post('/api/r/:slug/tickets/:id/status', requireStaff, (req, res) => {
  const t = db.tickets[req.params.id];
  if (!t || t.slug !== req.restaurant.slug) return res.status(404).json({ error: 'Nummer nicht gefunden' });
  const status = req.body.status;
  if (!['preparing', 'ready', 'done'].includes(status)) return res.status(400).json({ error: 'Ungültiger Status' });

  // Re-opening an already collected ticket ("undo") must not ring the guest again.
  const wasReady = t.status === 'ready' || t.status === 'done';
  t.status = status;
  if (status === 'preparing') {
    t.readyAt = null; t.doneAt = null; t.coming = false; t.ringCount = 0; t.lastRingAt = null;
  }
  if (status === 'done') t.doneAt = Date.now();
  if (status === 'ready') {
    t.doneAt = null;
    if (!wasReady) {
      t.readyAt = Date.now();
      t.coming = false;
      t.ringCount = 0;
      ring(t);
      return res.json({ ticket: staffTicket(t) });
    }
  }
  save();
  broadcastTicket(t);
  res.json({ ticket: staffTicket(t) });
});

app.post('/api/r/:slug/tickets/:id/ring', requireStaff, (req, res) => {
  const t = db.tickets[req.params.id];
  if (!t || t.slug !== req.restaurant.slug || t.status !== 'ready') return res.status(404).json({ error: 'Nummer nicht gefunden' });
  ring(t);
  res.json({ ticket: staffTicket(t) });
});

app.get('/api/r/:slug/code', requireStaff, (req, res) => {
  const slot = currentSlot();
  res.json({ code: rotatingCode(req.restaurant, slot), expiresAt: (slot + 1) * CODE_SLOT_MS });
});

app.get('/qr.svg', async (req, res) => {
  const data = String(req.query.d || '').slice(0, 400);
  if (!data) return res.status(400).end();
  const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

// Per-restaurant manifest so "Add to Home Screen" (needed for push on iPhone) opens the guest page.
app.get('/r/:slug/manifest.webmanifest', (req, res) => {
  const r = db.restaurants[req.params.slug];
  if (!r) return res.status(404).end();
  res.type('application/manifest+json').json({
    name: `${r.name} · done`,
    short_name: r.name.slice(0, 12),
    start_url: `/r/${r.slug}`,
    scope: '/',
    display: 'standalone',
    background_color: '#f7f6f2',
    theme_color: '#ff5a36',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  });
});

const pub = path.join(__dirname, 'public');
app.get('/r/:slug', (req, res) => res.sendFile(path.join(pub, 'guest.html')));
app.get('/k/:slug', (req, res) => res.sendFile(path.join(pub, 'staff.html')));
app.get('/tv/:slug', (req, res) => res.sendFile(path.join(pub, 'tv.html')));
app.get('/start/:slug', (req, res) => res.sendFile(path.join(pub, 'setup.html')));
app.use(express.static(pub));

// ---------- websocket ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'guest') {
      const t = db.tickets[msg.id];
      if (!t || !safeEqual(msg.token, t.guestToken)) return ws.send(JSON.stringify({ type: 'error', error: 'gone' }));
      addSocket(guestSockets, t.id, ws);
      ws.send(JSON.stringify({ type: 'ticket', ticket: publicTicket(t) }));
    }

    if (msg.type === 'staff') {
      const r = db.restaurants[msg.slug];
      if (!r || !safeEqual(msg.token, r.staffToken)) return ws.send(JSON.stringify({ type: 'error', error: 'forbidden' }));
      addSocket(staffSockets, r.slug, ws);
      ws.send(JSON.stringify({ type: 'state', ...staffState(r.slug) }));
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`done läuft auf http://localhost:${PORT}`));
