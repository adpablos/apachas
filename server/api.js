#!/usr/bin/env node
// Minimal shared-party API for A Pachas. One JSON document per party,
// optimistic revision control, and zero dependencies beyond Node stdlib.
//
//   POST /api/parties            {state}              -> 201 {id, key, rev}
//   GET  /api/parties/:id[?rev=] -> 200 {rev, state, updatedAt} | 204
//   PUT  /api/parties/:id        {key, rev, state}    -> 200 {rev, updatedAt}
//                                  | 409 {rev, state} | 403 | 404 | 413
//   GET  /api/health             -> 200
//
// In local development (`node server/api.js`) this also serves public/ so the
// whole app can run at http://localhost:8010. In production, nginx serves
// static assets and only proxies /api/ here. See docs/deployment.md.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8010);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'public');

const MAX_BODY = 256 * 1024;          // A large party is ~30 KB; this is plenty.
const EXPIRY_MS = 240 * 24 * 3600 * 1000; // Untouched parties expire after 8 months.
// Point budget per IP per minute: reads cost 1, writes cost 5. The whole group
// often shares the village Wi-Fi IP, so this must support ~30 phones polling
// every 12 seconds (~150 points/min) with headroom.
const RATE_MAX = 600;
const MAX_PARTIES = 5000;             // Guardrail against bots filling disk.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // No i/l/o/0/1.
const PARTY_ID_RE = new RegExp(`^[${ALPHABET}]{10}$`);
const STATE_VERSION = 6;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- utilities ---------- */

function randomToken(length) {
  const bytes = crypto.randomBytes(length);
  let value = '';
  for (let i = 0; i < length; i++) value += ALPHABET[bytes[i] % ALPHABET.length];
  return value;
}

function partyFile(id) {
  return path.join(DATA_DIR, id + '.json');
}

// This process is the only writer, so party rev/key metadata can be cached.
// Polling is the most frequent request and usually unchanged, so this lets us
// return 204 without touching disk or parsing the full document.
const metadata = new Map(); // id -> { rev, key }

function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const key = doc.key;
  // Stored v5 parties are upgraded on read. Network writes must use the current
  // contract so an old browser cannot silently discard transfers or frozen
  // consumer lists introduced in v6.
  const state = validState(doc.state, { allowLegacy: true });
  if (!key || !state || !Number.isInteger(doc.rev)) return null;
  return {
    key,
    rev: doc.rev,
    updatedAt: doc.updatedAt || new Date().toISOString(),
    state,
  };
}

function readParty(id) {
  try {
    const doc = normalizeDocument(JSON.parse(fs.readFileSync(partyFile(id), 'utf8')));
    if (doc) metadata.set(id, { rev: doc.rev, key: doc.key });
    return doc;
  } catch (e) {
    return null;
  }
}

function writeParty(id, doc) {
  const stored = { key: doc.key, rev: doc.rev, updatedAt: doc.updatedAt, state: doc.state };
  const tmp = partyFile(id) + '.tmp-' + randomToken(6);
  fs.writeFileSync(tmp, JSON.stringify(stored));
  fs.renameSync(tmp, partyFile(id));
  metadata.set(id, { rev: doc.rev, key: doc.key });
}

function json(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      // Keep draining without storing; destroying the socket would give the
      // client a reset instead of a 413 response.
      if (total > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function stateResponse(doc) {
  return {
    rev: doc.rev,
    state: doc.state,
    updatedAt: doc.updatedAt,
  };
}

/* ---------- shared state validation and migration ---------- */

// Shared party state excludes client-local fields and uses English keys.
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const validId = (x) => typeof x === 'string' && ENTITY_ID_RE.test(x);
const optionalNumber = (x) => x == null || (typeof x === 'number' && isFinite(x));
const optionalId = (x) => x == null || validId(x);
const ITEM_STATUSES = ['pending', 'claimed', 'bought'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableEntityId(prefix, text) {
  let first = 2166136261;
  let second = 3335557771;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return `${prefix}${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function legacyTransferId(key, value) {
  return stableEntityId('tl', `${key}|${value.cents || 0}|${value.at || 0}`);
}

function migrateLegacyTransfers(input, people) {
  const transfers = [];
  const peopleIds = new Set(people.map((person) => person.id));
  const settled = input && typeof input === 'object' && !Array.isArray(input)
    ? input : {};
  for (const key of Object.keys(settled)) {
    const value = settled[key];
    const [fromId, toId, extra] = key.split('>');
    if (extra !== undefined || !value || !value.done ||
        !peopleIds.has(fromId) || !peopleIds.has(toId) || fromId === toId ||
        !Number.isInteger(value.cents) || value.cents <= 0) continue;
    const at = Number(value.at) || 0;
    transfers.push({
      id: legacyTransferId(key, value),
      fromId,
      toId,
      cents: value.cents,
      createdAt: at,
      ...(value.by != null ? { createdBy: value.by } : {}),
      updatedAt: at,
    });
  }
  return transfers;
}

function migrateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rawParty = input.party;
  if (!rawParty || typeof rawParty !== 'object') return null;

  const people = asArray(input.people).map((person, index) => ({
    id: person && person.id,
    name: person && person.name,
    admin: person && person.admin !== undefined ? !!person.admin : index < 2,
    active: person && person.active !== undefined ? !!person.active : true,
    updatedAt: person && (person.updatedAt ?? 0),
  }));
  if (people.length && !people.some((person) => person.active)) people[0].active = true;
  if (people.length && !people.some((person) => person.active && person.admin)) {
    people.find((person) => person.active).admin = true;
  }

  const items = asArray(input.items).map((item) => {
    const migrated = {
      id: item && item.id,
      name: item && item.name,
      status: item && item.status,
      updatedAt: item && (item.updatedAt ?? 0),
    };
    const priceCents = item && item.priceCents;
    const payerId = item && item.payerId;
    const claimerId = item && item.claimerId;
    const consumers = item && item.consumers;
    const createdAt = item && item.createdAt;
    const createdBy = item && item.createdBy;
    const updatedBy = item && item.updatedBy;
    if (priceCents != null) migrated.priceCents = priceCents;
    if (payerId != null) migrated.payerId = payerId;
    if (claimerId != null) migrated.claimerId = claimerId;
    if (consumers != null) migrated.consumers = consumers;
    if (createdAt != null) migrated.createdAt = createdAt;
    if (createdBy != null) migrated.createdBy = createdBy;
    if (updatedBy != null) migrated.updatedBy = updatedBy;
    return migrated;
  });

  const activeIds = people.filter((person) => person.active).map((person) => person.id);
  const activeIdSet = new Set(activeIds);
  const peopleIds = new Set(people.map((person) => person.id));
  for (const item of items) {
    // In v5, null meant "whoever is currently in the group". Freeze that set
    // during migration so later joins and departures cannot rewrite history.
    if (item.status === 'bought') {
      const validConsumers = Array.isArray(item.consumers)
        ? [...new Set(item.consumers.filter((id) => peopleIds.has(id)))] : [];
      item.consumers = validConsumers.length ? validConsumers : activeIds.slice();
    }
    if (item.status === 'claimed' && !activeIdSet.has(item.claimerId)) {
      item.status = 'pending';
      delete item.claimerId;
    }
  }

  const transfers = asArray(input.transfers).map((transfer) => ({
    id: transfer && transfer.id,
    fromId: transfer && transfer.fromId,
    toId: transfer && transfer.toId,
    cents: transfer && transfer.cents,
    createdAt: transfer && (transfer.createdAt ?? 0),
    ...(transfer && transfer.createdBy != null ? { createdBy: transfer.createdBy } : {}),
    updatedAt: transfer && (transfer.updatedAt ?? transfer.createdAt ?? 0),
    ...(transfer && transfer.updatedBy != null ? { updatedBy: transfer.updatedBy } : {}),
  }));
  if (!transfers.length && input.settled) {
    transfers.push(...migrateLegacyTransfers(input.settled, people));
  }

  const tombstones = asArray(input.tombstones).map((mark) => ({
    id: mark && mark.id,
    at: mark && (mark.at ?? 0),
    seenAt: mark && (mark.seenAt ?? mark.at ?? 0),
  }));

  return {
    v: STATE_VERSION,
    party: {
      name: rawParty.name,
      date: rawParty.date ?? null,
      updatedAt: rawParty.updatedAt ?? 0,
      ...(rawParty.demo ? { demo: true } : {}),
    },
    people,
    items,
    transfers,
    tombstones,
  };
}

function validState(payload, options = {}) {
  const sourceVersion = payload && Number(payload.v);
  if (!options.allowLegacy && sourceVersion !== STATE_VERSION) return null;
  const state = migrateState(payload);
  if (!state) return null;

  const party = state.party;
  if (typeof party.name !== 'string' || !party.name.trim() || party.name.length > 80) return null;
  // The client interpolates this date into value="...": YYYY-MM-DD or nothing.
  if (party.date != null && party.date !== '' &&
      !(typeof party.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(party.date))) return null;
  if (!optionalNumber(party.updatedAt)) return null;

  if (!Array.isArray(state.people) || state.people.length > 100) return null;
  if (!state.people.length || !state.people.some((person) => person.active)) return null;
  if (!state.people.some((person) => person.active && person.admin)) return null;
  const entityIds = new Set();
  const peopleIds = new Set();
  for (const person of state.people) {
    if (!person || typeof person !== 'object' || !validId(person.id)) return null;
    if (entityIds.has(person.id)) return null;
    entityIds.add(person.id);
    peopleIds.add(person.id);
    if (typeof person.name !== 'string' || !person.name.trim() || person.name.length > 40) return null;
    if (!optionalNumber(person.updatedAt)) return null;
  }

  if (!Array.isArray(state.items) || state.items.length > 500) return null;
  for (const item of state.items) {
    if (!item || typeof item !== 'object' || !validId(item.id)) return null;
    if (entityIds.has(item.id)) return null;
    entityIds.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) return null;
    if (!ITEM_STATUSES.includes(item.status)) return null;
    if (item.priceCents != null &&
        !(Number.isInteger(item.priceCents) && item.priceCents >= 0 && item.priceCents <= 100000000)) return null;
    if (!optionalId(item.payerId) || !optionalId(item.claimerId) ||
        !optionalId(item.createdBy) || !optionalId(item.updatedBy)) return null;
    if (item.consumers != null && (!Array.isArray(item.consumers) ||
        item.consumers.length > 100 || !item.consumers.every(validId))) return null;
    if (item.status === 'bought' && (!Array.isArray(item.consumers) || !item.consumers.length)) return null;
    if (item.status === 'bought' && (!peopleIds.has(item.payerId) ||
        !item.consumers.every((id) => peopleIds.has(id)))) return null;
    if (!optionalNumber(item.updatedAt) || !optionalNumber(item.createdAt)) return null;
  }

  if (!Array.isArray(state.transfers) || state.transfers.length > 500) return null;
  for (const transfer of state.transfers) {
    if (!transfer || typeof transfer !== 'object' || !validId(transfer.id) ||
        !validId(transfer.fromId) || !validId(transfer.toId) ||
        transfer.fromId === transfer.toId || !Number.isInteger(transfer.cents) ||
        transfer.cents <= 0 || transfer.cents > 100000000 ||
        !optionalId(transfer.createdBy) || !optionalId(transfer.updatedBy) ||
        !optionalNumber(transfer.createdAt) || !optionalNumber(transfer.updatedAt)) return null;
    if (entityIds.has(transfer.id) || !peopleIds.has(transfer.fromId) ||
        !peopleIds.has(transfer.toId)) return null;
    entityIds.add(transfer.id);
  }

  if (!Array.isArray(state.tombstones) || state.tombstones.length > 500) return null;
  for (const mark of state.tombstones) {
    if (!mark || typeof mark !== 'object' || !validId(mark.id) ||
        !optionalNumber(mark.at) || !optionalNumber(mark.seenAt)) return null;
    if (entityIds.has(mark.id)) return null;
  }

  // Whitelist rebuild: unknown fields are not stored. Without this, anyone
  // with the write key could inject hundreds of KB of ballast that honest
  // clients would keep re-uploading until the size cap turns the party
  // effectively read-only.
  const cleaned = {
    v: STATE_VERSION,
    party: {
      name: party.name,
      date: party.date ? party.date : null,
      updatedAt: party.updatedAt || 0,
      ...(party.demo ? { demo: true } : {}),
    },
    people: state.people.map((person) => ({
      id: person.id,
      name: person.name,
      admin: !!person.admin,
      active: !!person.active,
      updatedAt: person.updatedAt || 0,
    })),
    items: state.items.map((item) => {
      const entry = { id: item.id, name: item.name, status: item.status, updatedAt: item.updatedAt || 0 };
      if (item.priceCents != null) entry.priceCents = item.priceCents;
      if (item.payerId != null) entry.payerId = item.payerId;
      if (item.claimerId != null) entry.claimerId = item.claimerId;
      if (item.consumers != null) entry.consumers = item.consumers.slice();
      if (item.createdAt != null) entry.createdAt = item.createdAt;
      if (item.createdBy != null) entry.createdBy = item.createdBy;
      if (item.updatedBy != null) entry.updatedBy = item.updatedBy;
      return entry;
    }),
    transfers: state.transfers.map((transfer) => ({
      id: transfer.id,
      fromId: transfer.fromId,
      toId: transfer.toId,
      cents: transfer.cents,
      createdAt: transfer.createdAt || 0,
      ...(transfer.createdBy != null ? { createdBy: transfer.createdBy } : {}),
      updatedAt: transfer.updatedAt || 0,
      ...(transfer.updatedBy != null ? { updatedBy: transfer.updatedBy } : {}),
    })),
    tombstones: state.tombstones.map((mark) => ({
      id: mark.id,
      at: mark.at || 0,
      seenAt: mark.seenAt == null ? (mark.at || 0) : mark.seenAt,
    })),
  };
  return cleaned;
}

/* ---------- best-effort IP rate limit ---------- */

const buckets = new Map();
function withinRateLimit(req) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    req.socket.remoteAddress || '?';
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.until) {
    bucket = { count: 0, until: now + 60000 };
    buckets.set(ip, bucket);
  }
  bucket.count += (req.method === 'GET' || req.method === 'HEAD') ? 1 : 5;
  if (buckets.size > 5000) {
    // Drop expired buckets first; clear everything only if still overflowing.
    for (const [key, value] of buckets) if (now > value.until) buckets.delete(key);
    if (buckets.size > 5000) buckets.clear();
  }
  return bucket.count <= RATE_MAX;
}

/* ---------- abandoned-party cleanup ---------- */

// Count parties on disk on each POST. This endpoint is rate-limited and capped
// at <=5000 dirents, so it is cheap and avoids counters that drift.
function partyCount() {
  try {
    return fs.readdirSync(DATA_DIR).filter((file) => file.endsWith('.json')).length;
  } catch (e) { return 0; }
}

function purgeExpiredParties() {
  let deleted = 0;
  try {
    const cutoff = Date.now() - EXPIRY_MS;
    for (const file of fs.readdirSync(DATA_DIR)) {
      const filePath = path.join(DATA_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        // Orphan .tmp files older than one day can go too.
        const isTmp = file.includes('.tmp-');
        if ((file.endsWith('.json') && stat.mtimeMs < cutoff) ||
            (isTmp && stat.mtimeMs < Date.now() - 24 * 3600 * 1000)) {
          fs.unlinkSync(filePath);
          if (file.endsWith('.json')) metadata.delete(file.slice(0, -5));
          deleted++;
        }
      } catch (e) { /* Race with another cleanup pass; harmless. */ }
    }
  } catch (e) { /* Data dir may not exist yet. */ }
  if (deleted) console.log(`cleanup: ${deleted} expired party file(s)`);
}
// Delay the first cleanup until the server is listening. With many files, a
// synchronous scan before listen() would slow startup.
setTimeout(purgeExpiredParties, 5000).unref();
setInterval(purgeExpiredParties, 12 * 3600 * 1000).unref();

/* ---------- API ---------- */

async function parseJsonBody(req, res) {
  let value;
  try {
    value = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.message === 'too_large') throw e; // Outer catch returns 413.
    json(res, 400, { error: 'Cuerpo inválido' });
    return null;
  }
  // Syntactically valid but falsey JSON (null, false, 0, "") parses without
  // throwing; callers treat a falsey return as "already responded", so this
  // must send the 400 itself instead of letting the request hang unanswered.
  if (!value) {
    json(res, 400, { error: 'Cuerpo inválido' });
    return null;
  }
  return value;
}

async function api(req, res, url) {
  if (!withinRateLimit(req)) return json(res, 429, { error: 'Frena un poco, máquina.' });

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/parties') {
    if (partyCount() >= MAX_PARTIES) {
      return json(res, 503, { error: 'El servidor está hasta arriba de fiestas' });
    }
    const body = await parseJsonBody(req, res);
    if (!body) return;
    const state = validState(body.state);
    if (!state) return json(res, 400, { error: 'Eso no es una fiesta' });
    const id = randomToken(10);
    const key = randomToken(14);
    const doc = { key, rev: 1, updatedAt: new Date().toISOString(), state };
    writeParty(id, doc);
    return json(res, 201, { id, key, rev: 1 });
  }

  const match = url.pathname.match(/^\/api\/parties\/([^/]+)$/);
  if (match) {
    const id = match[1];
    if (!PARTY_ID_RE.test(id)) return json(res, 404, { error: 'No hay tal fiesta' });

    if (req.method === 'GET') {
      // 204 instead of 304: fetch handles an explicit unchanged response more
      // cleanly. Fast path: if the rev cache already says nothing changed,
      // skip disk and parsing.
      const cached = metadata.get(id);
      if (cached && url.searchParams.get('rev') === String(cached.rev)) return json(res, 204);
      const doc = readParty(id);
      if (!doc) return json(res, 404, { error: 'No hay tal fiesta' });
      if (url.searchParams.get('rev') === String(doc.rev)) return json(res, 204);
      return json(res, 200, stateResponse(doc));
    }

    if (req.method === 'PUT') {
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const doc = readParty(id);
      if (!doc) return json(res, 404, { error: 'No hay tal fiesta' });
      if (!body || body.key !== doc.key) {
        return json(res, 403, { error: 'Ese enlace no puede editar' });
      }
      const state = validState(body.state);
      if (!state) return json(res, 400, { error: 'Eso no es una fiesta' });
      if (Number(body.rev) !== doc.rev) {
        return json(res, 409, stateResponse(doc));
      }
      doc.rev++;
      doc.updatedAt = new Date().toISOString();
      doc.state = state;
      writeParty(id, doc);
      return json(res, 200, { rev: doc.rev, updatedAt: doc.updatedAt });
    }
  }

  return json(res, 404, { error: 'No hay nada por aquí' });
}

/* ---------- static serving for local development ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function staticFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'Solo lectura por aquí' });
  }
  let route = decodeURIComponent(url.pathname);
  if (route === '/' || route === '') route = '/index.html';
  const target = path.resolve(STATIC_DIR, '.' + route);
  if (!target.startsWith(path.resolve(STATIC_DIR) + path.sep) &&
      target !== path.resolve(STATIC_DIR)) {
    return json(res, 404, { error: 'No' });
  }
  let data;
  try { data = fs.readFileSync(target); }
  catch (e) { return json(res, 404, { error: 'No existe' }); }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ---------- server ---------- */

const hasStatic = fs.existsSync(path.join(STATIC_DIR, 'index.html'));

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, 'http://local');
  res.on('finish', () => {
    // Do not log party IDs; the ID alone is enough to read the party.
    const route = url.pathname.replace(/^(\/api\/parties\/)[^/]+/, '$1***');
    console.log(`${req.method} ${route} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await api(req, res, url);
    } else if (hasStatic) {
      staticFile(req, res, url);
    } else {
      json(res, 404, { error: 'No hay nada por aquí' });
    }
  } catch (e) {
    if (!res.headersSent) json(res, e.message === 'too_large' ? 413 : 500, { error: 'Se ha torcido algo' });
  }
});

server.listen(PORT, () => {
  console.log(`A Pachas API at http://localhost:${PORT} (data in ${DATA_DIR}${hasStatic ? `, static files from ${STATIC_DIR}` : ''})`);
});
