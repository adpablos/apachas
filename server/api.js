#!/usr/bin/env node
// Minimal shared-party API for A Pachas. One JSON document per party,
// optimistic revision control, and zero dependencies beyond Node stdlib.
//
//   POST /api/parties            {state, actorId?, deviceId?}
//                                  -> 201 {id, key, ownerKey, rev, audit}
//   GET  /api/parties/:id[?rev=] -> 200 {rev, state, updatedAt} | 204
//   PUT  /api/parties/:id        {key, rev, state, actorId?, deviceId?}
//                                                       -> 200 {rev, updatedAt, audit}
//                                  | 409 {rev, state} | 403 | 404 | 413
//   DELETE /api/parties/:id      {ownerKey, rev, deviceId?, confirmName}
//                                  -> 202 {purgeAt}
//   POST /api/parties/:id/restore {ownerKey, deviceId?}
//                                  -> 200 {id, key, ownerKey, rev, state, audit}
//   POST /api/events             {events}             -> 202
//   GET  /api/live               -> 200
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

function integerEnv(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

const PORT = Number(process.env.PORT || 8010);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRASH_DIR = path.join(DATA_DIR, '.trash');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'public');
const APP_RELEASE = /^[A-Za-z0-9._-]{1,64}$/.test(process.env.APP_RELEASE || '')
  ? process.env.APP_RELEASE : 'dev';
const APP_VERSION = /^v0\.[1-9][0-9]*\.0-beta\.[1-9][0-9]*$/.test(process.env.APP_VERSION || '')
  ? process.env.APP_VERSION : 'dev';
const REMOTE_QUEUE_MAX = integerEnv('REMOTE_QUEUE_MAX', 100);
const REMOTE_TIMEOUT_MS = integerEnv('REMOTE_TIMEOUT_MS', 2000);
const REMOTE_WARNING_INTERVAL_MS = integerEnv('REMOTE_WARNING_INTERVAL_MS', 60 * 1000);

const MAX_BODY = 256 * 1024;          // A large party is ~30 KB; this is plenty.
const EXPIRY_MS = 240 * 24 * 3600 * 1000; // Untouched parties expire after 8 months.
const DELETION_RETENTION_MS = integerEnv('DELETION_RETENTION_MS', 7 * 24 * 3600 * 1000);
const MAX_AUDIT_EVENTS = 200;
const MAX_AUDIT_BYTES = 256 * 1024;
const METRICS_INTERVAL_MS = 5 * 60 * 1000;
// Point budget per IP per minute: reads cost 1, writes cost 5. The whole group
// often shares the village Wi-Fi IP, so this must support ~30 phones polling
// every 12 seconds (~150 points/min) with headroom.
const RATE_MAX = integerEnv('RATE_MAX', 600);
const RATE_WINDOW_MS = integerEnv('RATE_WINDOW_MS', 60 * 1000);
const CREATE_RATE_MAX = integerEnv('CREATE_RATE_MAX', 10);
const CREATE_RATE_WINDOW_MS = integerEnv('CREATE_RATE_WINDOW_MS', 60 * 60 * 1000);
const EVENT_RATE_MAX = integerEnv('EVENT_RATE_MAX', 60);
const EVENT_RATE_WINDOW_MS = integerEnv('EVENT_RATE_WINDOW_MS', 60 * 1000);
const MAX_PARTIES = 5000;             // Guardrail against bots filling disk.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // No i/l/o/0/1.
const PARTY_ID_RE = new RegExp(`^[${ALPHABET}]{10}$`);
const WRITE_KEY_RE = new RegExp(`^[${ALPHABET}]{14}$`);
const OWNER_KEY_RE = new RegExp(`^[${ALPHABET}]{24}$`);
const SENSITIVE_TOKEN_RE = new RegExp(`[${ALPHABET}]{10,24}`, 'g');
const PARTY_PATH_RE = /^\/api\/parties\/([^/]+)(?:\/(restore))?$/;
const STATE_VERSION = 6;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

/* ---------- utilities ---------- */

function randomToken(length) {
  const bytes = crypto.randomBytes(length);
  let value = '';
  for (let i = 0; i < length; i++) value += ALPHABET[bytes[i] % ALPHABET.length];
  return value;
}

function loadObservabilityKey() {
  const keyFile = path.join(DATA_DIR, '.observability-key');
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(32);
  const tmp = `${keyFile}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  try {
    fs.renameSync(tmp, keyFile);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (cleanupError) { /* Best effort. */ }
    const existing = fs.readFileSync(keyFile);
    if (existing.length < 32) throw error;
    return existing;
  }
  return key;
}

const OBSERVABILITY_KEY = loadObservabilityKey();

function privateRef(namespace, value) {
  if (!value) return undefined;
  return crypto.createHmac('sha256', OBSERVABILITY_KEY)
    .update(`${namespace}:${value}`).digest('hex').slice(0, 16);
}

function sanitizeDiagnostic(value) {
  return String(value || '').replace(SENSITIVE_TOKEN_RE, '***').slice(0, 4000);
}

function configuredUrl(value, defaultPath = '') {
  if (!value) return null;
  try {
    const url = new URL(defaultPath, value);
    const testLoopback = process.env.ALLOW_INSECURE_OBSERVABILITY_FOR_TESTS === '1' &&
      url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    return url.protocol === 'https:' || testLoopback ? url : null;
  } catch {
    return null;
  }
}

const BETTER_STACK_TOKEN = /^[A-Za-z0-9._-]{8,300}$/.test(process.env.BETTER_STACK_SOURCE_TOKEN || '')
  ? process.env.BETTER_STACK_SOURCE_TOKEN : '';
const BETTER_STACK_URL = BETTER_STACK_TOKEN
  ? configuredUrl(process.env.BETTER_STACK_INGESTING_URL || 'https://in.logs.betterstack.com/') : null;
const POSTHOG_API_KEY = /^[A-Za-z0-9._-]{8,300}$/.test(process.env.POSTHOG_API_KEY || '')
  ? process.env.POSTHOG_API_KEY : '';
const POSTHOG_URL = POSTHOG_API_KEY
  ? configuredUrl(process.env.POSTHOG_HOST || 'https://eu.i.posthog.com', '/capture/') : null;

function remoteQueue(name, url, headers, maxAttempts = 1) {
  const queue = [];
  let sending = false;
  let deliveryDrops = 0;
  let overflowDrops = 0;
  let deliveryDegraded = false;
  let lastDeliveryWarningAt = 0;
  let lastOverflowWarningAt = 0;

  function diagnostic(level, event, fields) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), level,
      event, version: APP_VERSION, release: APP_RELEASE, sink: name, ...fields,
    }));
  }

  function noteDeliveryDrop(error) {
    deliveryDrops++;
    deliveryDegraded = true;
    const now = Date.now();
    if (now - lastDeliveryWarningAt >= REMOTE_WARNING_INTERVAL_MS) {
      diagnostic('warn', 'remote_observability_degraded', {
        reason: 'delivery_failed', dropped: deliveryDrops,
        ...(error ? { errorName: error.name || 'Error' } : {}),
      });
      lastDeliveryWarningAt = now;
    }
  }

  function noteOverflow() {
    overflowDrops++;
    const now = Date.now();
    if (now - lastOverflowWarningAt >= REMOTE_WARNING_INTERVAL_MS) {
      diagnostic('warn', 'remote_observability_degraded', {
        reason: 'queue_overflow', dropped: overflowDrops,
      });
      lastOverflowWarningAt = now;
    }
  }

  async function deliverWithRetry(payload) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`status_${response.status}`);
        return true;
      } catch (error) {
        if (attempt === maxAttempts) {
          noteDeliveryDrop(error);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    return false;
  }

  async function flush() {
    if (sending || !queue.length) return;
    sending = true;
    const payload = queue.shift();
    try {
      if (await deliverWithRetry(payload) && deliveryDegraded) {
        diagnostic('info', 'remote_observability_recovered', { dropped: deliveryDrops });
        deliveryDrops = 0;
        deliveryDegraded = false;
        lastDeliveryWarningAt = 0;
      }
    } finally {
      sending = false;
      if (overflowDrops && queue.length < Math.ceil(REMOTE_QUEUE_MAX / 2)) {
        diagnostic('info', 'remote_observability_queue_recovered', { dropped: overflowDrops });
        overflowDrops = 0;
        lastOverflowWarningAt = 0;
      }
      if (queue.length) setImmediate(flush);
    }
  }
  return (payload) => {
    if (!url) return;
    if (queue.length >= REMOTE_QUEUE_MAX) {
      queue.shift();
      noteOverflow();
    }
    queue.push(payload);
    setImmediate(flush);
  };
}

const forwardRemoteLog = remoteQueue('better_stack', BETTER_STACK_URL,
  BETTER_STACK_TOKEN ? { Authorization: `Bearer ${BETTER_STACK_TOKEN}` } : {});
const forwardServerProductEvent = remoteQueue('posthog_server', POSTHOG_URL, {}, 3);
const forwardClientProductEvent = remoteQueue('posthog_client', POSTHOG_URL, {}, 2);
const REMOTE_LOG_FIELDS = new Set([
  'timestamp', 'level', 'event', 'version', 'release', 'requestId', 'method', 'route', 'status',
  'durationMs', 'partyRef', 'deviceRef', 'auditEvents', 'errorName', 'errorCode',
  'stackRef', 'windowMs', 'requests', 'routes', 'statuses', 'errors', 'auditActions',
  'clientEvents', 'activeParties', 'activeDevices', 'averageDurationMs', 'maxDurationMs',
  'parties', 'deletedParties', 'storageReady', 'storageFreeBytes', 'deleted', 'purgeAt',
  'port', 'node', 'staticServing', 'code', 'source',
]);

function remoteLogPayload(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => REMOTE_LOG_FIELDS.has(key)));
}

function logEvent(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(), level, event,
    version: APP_VERSION, release: APP_RELEASE, ...fields,
  };
  console.log(JSON.stringify(entry));
  if (BETTER_STACK_URL) forwardRemoteLog(remoteLogPayload(entry));
}

function safeError(error) {
  return {
    errorName: error && error.name ? sanitizeDiagnostic(error.name) : 'Error',
    errorCode: error && error.code ? sanitizeDiagnostic(error.code) : undefined,
    stack: error && error.stack ? sanitizeDiagnostic(error.stack) : undefined,
    stackRef: error && error.stack ? privateRef('stack', error.stack) : undefined,
  };
}

const PRODUCT_EVENTS = new Set([
  'party_created', 'collaboration_started', 'first_expense_recorded',
  'first_transfer_completed', 'party_opened_write', 'party_opened_read',
  'invite_share_intent', 'accounts_share_intent', 'support_opened', 'accounts_viewed',
  'feedback_opened',
]);

function captureProductEvent(event, partyRef, source) {
  if (!PRODUCT_EVENTS.has(event) || !partyRef || !['server', 'client'].includes(source)) return;
  logEvent('info', 'product_event', { code: event, partyRef, source });
  if (!POSTHOG_URL) return;
  const forward = source === 'server' ? forwardServerProductEvent : forwardClientProductEvent;
  forward({
    api_key: POSTHOG_API_KEY,
    event,
    properties: {
      distinct_id: partyRef,
      $insert_id: source === 'server'
        ? privateRef('product-event', `${partyRef}:${event}`) : crypto.randomUUID(),
      $process_person_profile: false,
      version: APP_VERSION,
      release: APP_RELEASE,
      source,
    },
  });
}

const REQUEST_ID_RE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i;
function requestContext(req, url) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming)
    ? incoming : crypto.randomUUID();
  const partyMatch = url.pathname.match(PARTY_PATH_RE);
  const partyId = partyMatch && PARTY_ID_RE.test(partyMatch[1]) ? partyMatch[1] : null;
  let route = 'unknown';
  if (url.pathname === '/api/health') route = 'health.ready';
  else if (url.pathname === '/api/live') route = 'health.live';
  else if (url.pathname === '/api/events') route = 'client.events';
  else if (url.pathname === '/api/parties') route = 'parties.create';
  else if (partyMatch && partyMatch[2] === 'restore') route = 'parties.restore';
  else if (partyMatch && req.method === 'GET') route = 'parties.read';
  else if (partyMatch && req.method === 'PUT') route = 'parties.update';
  else if (partyMatch && req.method === 'DELETE') route = 'parties.delete';
  else if (partyMatch) route = 'parties.document';
  else if (!url.pathname.startsWith('/api')) route = 'static';
  return {
    requestId,
    route,
    partyRef: privateRef('party', partyId),
    deviceRef: undefined,
    auditEvents: 0,
  };
}

let metrics = newMetrics();
function newMetrics() {
  return {
    startedAt: Date.now(), requests: 0, durationMs: 0, maxDurationMs: 0,
    routes: Object.create(null), statuses: Object.create(null), errors: Object.create(null),
    auditActions: Object.create(null), clientEvents: Object.create(null),
    activePartyRefs: new Set(), activeDeviceRefs: new Set(),
  };
}

function recordRequest(context, status, durationMs) {
  metrics.requests++;
  metrics.durationMs += durationMs;
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
  metrics.routes[context.route] = (metrics.routes[context.route] || 0) + 1;
  metrics.statuses[status] = (metrics.statuses[status] || 0) + 1;
  if (status >= 400) metrics.errors[status] = (metrics.errors[status] || 0) + 1;
  if (context.partyRef) metrics.activePartyRefs.add(context.partyRef);
  if (context.deviceRef) metrics.activeDeviceRefs.add(context.deviceRef);
}

function recordAuditActions(events) {
  for (const event of events) {
    metrics.auditActions[event.action] = (metrics.auditActions[event.action] || 0) + 1;
  }
}

function partyFile(id) {
  return path.join(DATA_DIR, id + '.json');
}

function trashFile(id, deletedAt) {
  return path.join(TRASH_DIR, `${id}.${deletedAt}.json`);
}

function findTrashedParty(id) {
  const prefix = `${id}.`;
  try {
    const names = fs.readdirSync(TRASH_DIR)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .reverse();
    for (const name of names) {
      const deletedAt = Number(name.slice(prefix.length, -5));
      if (!Number.isFinite(deletedAt)) continue;
      const file = path.join(TRASH_DIR, name);
      try {
        const doc = normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (doc) return { file, doc, purgeAt: deletedAt + DELETION_RETENTION_MS };
      } catch (error) {
        if (error instanceof SyntaxError) {
          logEvent('error', 'trash_read_failed', {
            partyRef: privateRef('party', id),
            errorName: sanitizeDiagnostic(error.name),
          });
          continue;
        }
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return null;
}

// This process is the only writer, so party revisions can be cached.
// Polling is the most frequent request and usually unchanged, so this lets us
// return 204 without touching disk or parsing the full document.
const metadata = new Map(); // id -> rev

function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const key = doc.key;
  const ownerKey = OWNER_KEY_RE.test(doc.ownerKey || '') ? doc.ownerKey : null;
  // Stored v5 parties are upgraded on read. Network writes must use the current
  // contract so an old browser cannot silently discard transfers or frozen
  // consumer lists introduced in v6.
  const state = validState(doc.state, { allowLegacy: true });
  if (!WRITE_KEY_RE.test(key || '') || !state || !Number.isInteger(doc.rev)) return null;
  const audit = normalizeAudit(doc.audit);
  const auditDevices = new Set(audit.map((event) => event.deviceRef).filter(Boolean));
  const milestones = {
    collaborationStarted: doc.milestones && doc.milestones.collaborationStarted === true ||
      auditDevices.size >= 2,
    firstExpenseRecorded: doc.milestones && doc.milestones.firstExpenseRecorded === true ||
      state.items.some((item) => item.status === 'bought') || audit.some((event) =>
        event.action.startsWith('item.') && event.changes.some((change) =>
          change.field === 'status' && change.after === 'bought')),
    firstTransferCompleted: doc.milestones && doc.milestones.firstTransferCompleted === true ||
      state.transfers.length > 0 || audit.some((event) => event.action === 'transfer.created'),
  };
  return {
    key,
    ownerKey,
    rev: doc.rev,
    updatedAt: doc.updatedAt || new Date().toISOString(),
    state,
    audit,
    milestones,
  };
}

function readParty(id, context) {
  try {
    const doc = normalizeDocument(JSON.parse(fs.readFileSync(partyFile(id), 'utf8')));
    if (doc) metadata.set(id, doc.rev);
    return doc;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logEvent('error', 'party_read_failed', {
        requestId: context && context.requestId,
        partyRef: privateRef('party', id),
        ...safeError(error),
      });
    }
    return null;
  }
}

function writeParty(id, doc) {
  const stored = {
    key: doc.key,
    ...(doc.ownerKey ? { ownerKey: doc.ownerKey } : {}),
    rev: doc.rev,
    updatedAt: doc.updatedAt,
    state: doc.state,
    audit: normalizeAudit(doc.audit),
    milestones: {
      collaborationStarted: doc.milestones && doc.milestones.collaborationStarted === true,
      firstExpenseRecorded: doc.milestones && doc.milestones.firstExpenseRecorded === true,
      firstTransferCompleted: doc.milestones && doc.milestones.firstTransferCompleted === true,
    },
  };
  const tmp = partyFile(id) + '.tmp-' + randomToken(6);
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tmp, partyFile(id));
  metadata.set(id, doc.rev);
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
    audit: normalizeAudit(doc.audit),
  };
}

/* ---------- shared state validation and migration ---------- */

// Shared party state excludes client-local fields and uses English keys.
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const validId = (x) => typeof x === 'string' && ENTITY_ID_RE.test(x);
const optionalNumber = (x) => x == null || (typeof x === 'number' && isFinite(x));
const optionalId = (x) => x == null || validId(x);
const ITEM_STATUSES = ['pending', 'claimed', 'bought'];
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const AUDIT_ACTIONS = new Set([
  'party.created', 'party.updated',
  'person.created', 'person.updated', 'person.deleted',
  'item.created', 'item.updated', 'item.deleted',
  'transfer.created', 'transfer.updated', 'transfer.deleted',
]);
const AUDIT_FIELDS = {
  party: ['name', 'date'],
  person: ['name', 'admin', 'active'],
  item: ['name', 'status', 'claimerId', 'priceCents', 'payerId', 'consumers'],
  transfer: ['fromId', 'toId', 'cents'],
};

function auditValue(value) {
  if (value == null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') return value.slice(0, 80);
  if (Array.isArray(value)) return value.filter(validId).slice(0, 100);
  return null;
}

function normalizeAudit(input) {
  if (!Array.isArray(input)) return [];
  const normalized = input.slice(-MAX_AUDIT_EVENTS).flatMap((event) => {
    if (!event || typeof event !== 'object' || !validId(event.id) ||
        !AUDIT_ACTIONS.has(event.action) || !Number.isInteger(event.rev) || event.rev < 1 ||
        typeof event.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.at)) return [];
    const changes = Array.isArray(event.changes) ? event.changes.slice(0, 12).flatMap((change) => {
      if (!change || typeof change.field !== 'string' || change.field.length > 30) return [];
      return [{ field: change.field, before: auditValue(change.before), after: auditValue(change.after) }];
    }) : [];
    return [{
      id: event.id,
      rev: event.rev,
      at: event.at,
      action: event.action,
      ...(optionalId(event.entityId) && event.entityId ? { entityId: event.entityId } : {}),
      ...(optionalId(event.actorId) && event.actorId ? { actorId: event.actorId } : {}),
      ...(typeof event.deviceRef === 'string' && /^[a-f0-9]{16}$/.test(event.deviceRef)
        ? { deviceRef: event.deviceRef } : {}),
      ...(typeof event.requestId === 'string' && REQUEST_ID_RE.test(event.requestId)
        ? { requestId: event.requestId } : {}),
      ...(typeof event.label === 'string' && event.label ? { label: event.label.slice(0, 80) } : {}),
      changes,
    }];
  });
  const bounded = [];
  let bytes = 2;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const eventBytes = Buffer.byteLength(JSON.stringify(normalized[index])) + (bounded.length ? 1 : 0);
    if (bytes + eventBytes > MAX_AUDIT_BYTES) break;
    bounded.unshift(normalized[index]);
    bytes += eventBytes;
  }
  return bounded;
}

function sameAuditValue(left, right) {
  return JSON.stringify(left === undefined ? null : left) ===
    JSON.stringify(right === undefined ? null : right);
}

function auditChanges(type, before, after) {
  return AUDIT_FIELDS[type].flatMap((field) => {
    const previous = before && before[field];
    const next = after && after[field];
    if (sameAuditValue(previous, next)) return [];
    return [{ field, before: auditValue(previous), after: auditValue(next) }];
  });
}

function auditMeta(body, oldState, newState, partyId, context) {
  const peopleIds = new Set([
    ...((oldState && oldState.people) || []).map((person) => person.id),
    ...((newState && newState.people) || []).map((person) => person.id),
  ]);
  const actorId = body && validId(body.actorId) && peopleIds.has(body.actorId)
    ? body.actorId : null;
  const deviceId = body && DEVICE_ID_RE.test(body.deviceId || '') ? body.deviceId : null;
  const deviceRef = deviceId
    ? privateRef('party-device', `${partyId}:${deviceId}`) : undefined;
  context.deviceRef = deviceId ? privateRef('device', deviceId) : undefined;
  return { actorId, deviceRef, requestId: context.requestId };
}

function makeAuditEvent(action, entityId, label, changes, meta, rev, at) {
  return {
    id: randomToken(12), rev, at, action,
    ...(entityId ? { entityId } : {}),
    ...(meta.actorId ? { actorId: meta.actorId } : {}),
    ...(meta.deviceRef ? { deviceRef: meta.deviceRef } : {}),
    requestId: meta.requestId,
    ...(label ? { label: String(label).slice(0, 80) } : {}),
    changes,
  };
}

function auditEventsForChange(before, after, meta, rev, at) {
  const events = [];
  const partyChanges = auditChanges('party', before.party, after.party);
  if (partyChanges.length) {
    events.push(makeAuditEvent('party.updated', null, after.party.name, partyChanges, meta, rev, at));
  }
  for (const [type, collection] of [['person', 'people'], ['item', 'items'], ['transfer', 'transfers']]) {
    const previous = new Map((before[collection] || []).map((entity) => [entity.id, entity]));
    const next = new Map((after[collection] || []).map((entity) => [entity.id, entity]));
    for (const [id, entity] of next) {
      const oldEntity = previous.get(id);
      const changes = auditChanges(type, oldEntity, entity);
      if (!oldEntity) {
        events.push(makeAuditEvent(`${type}.created`, id, entity.name, changes, meta, rev, at));
      } else if (changes.length) {
        events.push(makeAuditEvent(`${type}.updated`, id, entity.name || oldEntity.name,
          changes, meta, rev, at));
      }
    }
    for (const [id, entity] of previous) {
      if (!next.has(id)) {
        events.push(makeAuditEvent(`${type}.deleted`, id, entity.name,
          auditChanges(type, entity, null), meta, rev, at));
      }
    }
  }
  return events;
}

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

const requestBuckets = new Map();
const createBuckets = new Map();
const eventBuckets = new Map();

function clientAddress(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    req.socket.remoteAddress || '?';
}

function consumeRateLimit(req, buckets, maximum, windowMs, cost = 1) {
  const address = clientAddress(req);
  const now = Date.now();
  let bucket = buckets.get(address);
  if (!bucket || now > bucket.until) {
    bucket = { count: 0, until: now + windowMs };
    buckets.set(address, bucket);
  }
  bucket.count += cost;
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now > value.until) buckets.delete(key);
    if (buckets.size > 5000) buckets.clear();
  }
  return {
    ok: bucket.count <= maximum,
    retryAfter: Math.max(1, Math.ceil((bucket.until - now) / 1000)),
  };
}

function enforceRateLimit(req, res, buckets, maximum, windowMs, cost = 1) {
  const result = consumeRateLimit(req, buckets, maximum, windowMs, cost);
  if (result.ok) return true;
  res.setHeader('Retry-After', String(result.retryAfter));
  json(res, 429, { error: 'Frena un poco, máquina.' });
  return false;
}

/* ---------- abandoned-party cleanup ---------- */

// Count documents on disk on each POST. This endpoint is rate-limited and the
// total is capped, so directory scans stay cheap and cannot drift.
function documentCount(directory) {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).length;
  } catch (e) { return 0; }
}
const partyCount = () => documentCount(DATA_DIR);
const deletedPartyCount = () => documentCount(TRASH_DIR);

function storageStatus() {
  try {
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    const stats = fs.statfsSync(DATA_DIR);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { ok: freeBytes > MAX_BODY * 2, freeBytes };
  } catch (error) {
    return { ok: false, freeBytes: 0 };
  }
}

function flushMetrics() {
  const snapshot = metrics;
  metrics = newMetrics();
  const storage = storageStatus();
  logEvent('info', 'metrics_snapshot', {
    windowMs: Date.now() - snapshot.startedAt,
    requests: snapshot.requests,
    routes: snapshot.routes,
    statuses: snapshot.statuses,
    errors: snapshot.errors,
    auditActions: snapshot.auditActions,
    clientEvents: snapshot.clientEvents,
    activeParties: snapshot.activePartyRefs.size,
    activeDevices: snapshot.activeDeviceRefs.size,
    averageDurationMs: snapshot.requests
      ? Number((snapshot.durationMs / snapshot.requests).toFixed(2)) : 0,
    maxDurationMs: snapshot.maxDurationMs,
    parties: partyCount(),
    deletedParties: deletedPartyCount(),
    storageReady: storage.ok,
    storageFreeBytes: storage.freeBytes,
  });
}

setInterval(flushMetrics, METRICS_INTERVAL_MS).unref();

function purgeExpiredParties() {
  let deleted = 0;
  let purgedTrash = 0;
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
  try {
    const cutoff = Date.now() - DELETION_RETENTION_MS;
    for (const file of fs.readdirSync(TRASH_DIR)) {
      const match = file.match(/^[a-z0-9]+\.(\d+)\.json$/);
      if (!match || Number(match[1]) >= cutoff) continue;
      fs.unlinkSync(path.join(TRASH_DIR, file));
      purgedTrash++;
    }
  } catch (e) { /* Trash dir may not exist yet. */ }
  if (deleted) logEvent('info', 'expired_parties_deleted', { deleted });
  if (purgedTrash) logEvent('info', 'deleted_parties_purged', { deleted: purgedTrash });
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

const CLIENT_ERROR_CODES = new Set([
  'sync.timeout', 'sync.network_error', 'sync.rejected',
  'sync.conflict_exhausted', 'sync.access_lost', 'sync.party_missing',
  'client.error', 'client.unhandled_rejection',
]);
const USAGE_EVENT_CODES = new Set([
  'usage.party_opened_write', 'usage.party_opened_read',
  'usage.invite_share_intent', 'usage.accounts_share_intent',
  'usage.support_opened', 'usage.accounts_viewed', 'usage.feedback_opened',
]);
const USAGE_PRODUCT_EVENTS = new Map([...USAGE_EVENT_CODES]
  .map((code) => [code, code.slice('usage.'.length)]));
const CLIENT_EVENT_CODES = new Set([...CLIENT_ERROR_CODES, ...USAGE_EVENT_CODES]);
const CLIENT_ERROR_TYPES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'DOMException', 'AbortError', 'NetworkError',
  'TimeoutError', 'NotAllowedError', 'SecurityError', 'QuotaExceededError',
]);
const CLIENT_ROUTES = new Set([
  'parties.create', 'parties.read', 'parties.update', 'parties.delete', 'parties.restore', 'client',
]);

function recordClientEvents(body, context) {
  if (!body || !Array.isArray(body.events) || !body.events.length || body.events.length > 10) return false;
  const events = [];
  for (const item of body.events) {
    if (!item || typeof item !== 'object' || !CLIENT_EVENT_CODES.has(item.code) ||
        !CLIENT_ROUTES.has(item.route)) return false;
    const partyId = typeof item.partyId === 'string' && PARTY_ID_RE.test(item.partyId)
      ? item.partyId : null;
    const deviceRef = DEVICE_ID_RE.test(item.deviceId || '')
      ? privateRef('device', item.deviceId) : undefined;
    if (deviceRef) context.deviceRef = deviceRef;
    events.push({
      requestId: context.requestId,
      code: item.code,
      route: item.route,
      status: Number.isInteger(item.status) && item.status >= 0 && item.status <= 599
        ? item.status : undefined,
      relatedRequestId: typeof item.requestId === 'string' && REQUEST_ID_RE.test(item.requestId)
        ? item.requestId : undefined,
      partyRef: privateRef('party', partyId),
      deviceRef,
      errorType: typeof item.errorType === 'string' && CLIENT_ERROR_TYPES.has(item.errorType)
        ? item.errorType : undefined,
    });
  }
  for (const event of events) {
    metrics.clientEvents[event.code] = (metrics.clientEvents[event.code] || 0) + 1;
    if (event.partyRef) metrics.activePartyRefs.add(event.partyRef);
    if (event.deviceRef) metrics.activeDeviceRefs.add(event.deviceRef);
    logEvent(USAGE_EVENT_CODES.has(event.code) ? 'info' : 'warn',
      USAGE_EVENT_CODES.has(event.code) ? 'usage_event' : 'client_event', event);
    const productEvent = USAGE_PRODUCT_EVENTS.get(event.code);
    if (productEvent) captureProductEvent(productEvent, event.partyRef, 'client');
  }
  return true;
}

function advanceMilestones(doc, after, deviceRef) {
  const events = [];
  const previousDevices = new Set((doc.audit || []).map((event) => event.deviceRef).filter(Boolean));
  if (!doc.milestones.collaborationStarted && deviceRef && previousDevices.size >= 1 &&
      !previousDevices.has(deviceRef)) {
    doc.milestones.collaborationStarted = true;
    events.push('collaboration_started');
  }
  if (!doc.milestones.firstExpenseRecorded &&
      after.items.some((item) => item.status === 'bought')) {
    doc.milestones.firstExpenseRecorded = true;
    events.push('first_expense_recorded');
  }
  if (!doc.milestones.firstTransferCompleted && after.transfers.length) {
    doc.milestones.firstTransferCompleted = true;
    events.push('first_transfer_completed');
  }
  return events;
}

async function api(req, res, url, context) {
  const generalCost = (req.method === 'GET' || req.method === 'HEAD') ? 1 : 5;
  if (!enforceRateLimit(req, res, requestBuckets, RATE_MAX, RATE_WINDOW_MS, generalCost)) return;

  if (req.method === 'GET' && url.pathname === '/api/live') {
    return json(res, 200, { ok: true, version: APP_VERSION, release: APP_RELEASE });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const storage = storageStatus();
    if (!storage.ok) {
      return json(res, 503, { ok: false, version: APP_VERSION, release: APP_RELEASE });
    }
    return json(res, 200, { ok: true, version: APP_VERSION, release: APP_RELEASE });
  }

  if (req.method === 'POST' && url.pathname === '/api/events') {
    if (!enforceRateLimit(req, res, eventBuckets, EVENT_RATE_MAX, EVENT_RATE_WINDOW_MS)) return;
    const body = await parseJsonBody(req, res);
    if (!body) return;
    if (!recordClientEvents(body, context)) {
      return json(res, 400, { error: 'Evento inválido' });
    }
    return json(res, 202, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/parties') {
    if (!enforceRateLimit(req, res, createBuckets, CREATE_RATE_MAX, CREATE_RATE_WINDOW_MS)) return;
    if (partyCount() + deletedPartyCount() >= MAX_PARTIES) {
      return json(res, 503, { error: 'El servidor está hasta arriba de planes' });
    }
    const body = await parseJsonBody(req, res);
    if (!body) return;
    const state = validState(body.state);
    if (!state) return json(res, 400, { error: 'Eso no es un plan' });
    const id = randomToken(10);
    const key = randomToken(14);
    const ownerKey = randomToken(24);
    context.partyRef = privateRef('party', id);
    const updatedAt = new Date().toISOString();
    const meta = auditMeta(body, null, state, id, context);
    const audit = [makeAuditEvent('party.created', null, state.party.name,
      auditChanges('party', null, state.party), meta, 1, updatedAt)];
    const doc = {
      key, ownerKey, rev: 1, updatedAt, state, audit,
      milestones: {
        collaborationStarted: false,
        firstExpenseRecorded: false,
        firstTransferCompleted: false,
      },
    };
    const productEvents = advanceMilestones(doc, state, meta.deviceRef);
    writeParty(id, doc);
    context.auditEvents = audit.length;
    recordAuditActions(audit);
    captureProductEvent('party_created', context.partyRef, 'server');
    for (const event of productEvents) captureProductEvent(event, context.partyRef, 'server');
    return json(res, 201, { id, key, ownerKey, rev: 1, updatedAt, audit });
  }

  const match = url.pathname.match(PARTY_PATH_RE);
  if (match) {
    const id = match[1];
    const action = match[2];
    if (!PARTY_ID_RE.test(id)) return json(res, 404, { error: 'No hay tal plan' });

    if (action === 'restore') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Eso no se hace así' });
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const deleted = findTrashedParty(id);
      if (!deleted) return json(res, 404, { error: 'No hay tal plan' });
      if (!deleted.doc.ownerKey || body.ownerKey !== deleted.doc.ownerKey) {
        return json(res, 403, { error: 'Este móvil no puede recuperar ese plan' });
      }
      if (Date.now() >= deleted.purgeAt) {
        fs.unlinkSync(deleted.file);
        return json(res, 410, { error: 'Ya no se puede recuperar ese plan' });
      }
      if (fs.existsSync(partyFile(id))) {
        return json(res, 409, { error: 'Ese plan ya está en vivo' });
      }
      if (DEVICE_ID_RE.test(body.deviceId || '')) {
        context.deviceRef = privateRef('device', body.deviceId);
      }
      fs.renameSync(deleted.file, partyFile(id));
      metadata.set(id, deleted.doc.rev);
      logEvent('warn', 'party_restored', {
        requestId: context.requestId,
        partyRef: context.partyRef,
        deviceRef: context.deviceRef,
      });
      return json(res, 200, {
        id,
        key: deleted.doc.key,
        ownerKey: deleted.doc.ownerKey,
        ...stateResponse(deleted.doc),
      });
    }

    if (req.method === 'GET') {
      // 204 instead of 304: fetch handles an explicit unchanged response more
      // cleanly. Fast path: if the rev cache already says nothing changed,
      // skip disk and parsing.
      const cached = metadata.get(id);
      if (cached !== undefined && url.searchParams.get('rev') === String(cached)) return json(res, 204);
      const doc = readParty(id, context);
      if (!doc) {
        const deleted = findTrashedParty(id);
        if (deleted && Date.now() < deleted.purgeAt) {
          return json(res, 410, {
            error: 'Este plan está borrado',
            purgeAt: new Date(deleted.purgeAt).toISOString(),
          });
        }
        return json(res, 404, { error: 'No hay tal plan' });
      }
      if (url.searchParams.get('rev') === String(doc.rev)) return json(res, 204);
      return json(res, 200, stateResponse(doc));
    }

    if (req.method === 'PUT') {
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const doc = readParty(id, context);
      if (!doc) return json(res, 404, { error: 'No hay tal plan' });
      if (!body || body.key !== doc.key) {
        return json(res, 403, { error: 'Ese enlace no puede editar' });
      }
      const state = validState(body.state);
      if (!state) return json(res, 400, { error: 'Eso no es un plan' });
      if (Number(body.rev) !== doc.rev) {
        return json(res, 409, stateResponse(doc));
      }
      const nextRev = doc.rev + 1;
      const updatedAt = new Date().toISOString();
      const meta = auditMeta(body, doc.state, state, id, context);
      const productEvents = advanceMilestones(doc, state, meta.deviceRef);
      const events = auditEventsForChange(doc.state, state, meta, nextRev, updatedAt);
      doc.rev = nextRev;
      doc.updatedAt = updatedAt;
      doc.state = state;
      doc.audit = normalizeAudit([...(doc.audit || []), ...events]);
      writeParty(id, doc);
      context.auditEvents = events.length;
      recordAuditActions(events);
      for (const event of productEvents) captureProductEvent(event, context.partyRef, 'server');
      return json(res, 200, { rev: doc.rev, updatedAt: doc.updatedAt, audit: doc.audit });
    }

    if (req.method === 'DELETE') {
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const doc = readParty(id, context);
      if (!doc) return json(res, 404, { error: 'No hay tal plan' });
      if (!doc.ownerKey || body.ownerKey !== doc.ownerKey) {
        return json(res, 403, { error: 'Este móvil no puede borrar el plan' });
      }
      if (Number(body.rev) !== doc.rev) return json(res, 409, stateResponse(doc));
      if (body.confirmName !== doc.state.party.name) {
        return json(res, 400, { error: 'El nombre no coincide' });
      }
      if (DEVICE_ID_RE.test(body.deviceId || '')) {
        context.deviceRef = privateRef('device', body.deviceId);
      }
      const deletedAt = Date.now();
      const purgeAt = deletedAt + DELETION_RETENTION_MS;
      fs.renameSync(partyFile(id), trashFile(id, deletedAt));
      metadata.delete(id);
      logEvent('warn', 'party_deleted', {
        requestId: context.requestId,
        partyRef: context.partyRef,
        deviceRef: context.deviceRef,
        purgeAt: new Date(purgeAt).toISOString(),
      });
      return json(res, 202, { purgeAt: new Date(purgeAt).toISOString() });
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
  const context = requestContext(req, url);
  res.setHeader('X-Request-ID', context.requestId);
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    recordRequest(context, res.statusCode, durationMs);
    // Successful polling, health checks, and static reads stay in the periodic
    // metrics snapshot. Writes, failures, and slow requests remain individually
    // traceable without logging party IDs, names, content, keys, IPs, or URLs.
    const shouldLog = !['GET', 'HEAD'].includes(req.method) || res.statusCode >= 400 || durationMs >= 1000;
    if (shouldLog) {
      logEvent(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'request', {
        requestId: context.requestId,
        method: req.method,
        route: context.route,
        status: res.statusCode,
        durationMs,
        partyRef: context.partyRef,
        auditEvents: context.auditEvents || undefined,
      });
    }
  });
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await api(req, res, url, context);
    } else if (hasStatic) {
      staticFile(req, res, url);
    } else {
      json(res, 404, { error: 'No hay nada por aquí' });
    }
  } catch (e) {
    logEvent('error', 'request_exception', {
      requestId: context.requestId,
      method: req.method,
      route: context.route,
      partyRef: context.partyRef,
      ...safeError(e),
    });
    if (!res.headersSent) json(res, e.message === 'too_large' ? 413 : 500, { error: 'Se ha torcido algo' });
  }
});

server.listen(PORT, () => {
  logEvent('info', 'api_started', {
    port: PORT,
    node: process.version,
    staticServing: hasStatic,
    storageReady: storageStatus().ok,
  });
});
