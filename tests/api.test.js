'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'api.js');

let baseUrl;
let child;
let dataDir;
let serverOutput = '';

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/live`);
      if (response.status === 200) return;
    } catch (error) {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not become ready.\n${serverOutput}`);
}

async function request(method, route, body, address = '198.51.100.10') {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'X-Real-IP': address,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function partyState(name = 'Fiesta de pruebas') {
  return {
    v: 6,
    party: { name, date: '2026-08-15', updatedAt: 1 },
    people: [
      { id: 'p1', name: 'Ana', admin: true, active: true, updatedAt: 1 },
      { id: 'p2', name: 'Luis', admin: false, active: true, updatedAt: 1 },
    ],
    items: [],
    transfers: [],
    tombstones: [],
  };
}

before(async () => {
  const port = await availablePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apachas-api-test-'));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      STATIC_DIR: path.join(dataDir, 'no-static-files'),
      RATE_MAX: '1000',
      CREATE_RATE_MAX: '2',
      EVENT_RATE_MAX: '2',
      DELETION_RETENTION_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-20000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  await waitForServer();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('party lifecycle enforces write and owner credentials', async () => {
  const initialState = partyState();
  const created = await request('POST', '/api/parties', {
    state: initialState,
    actorId: 'p1',
    deviceId: 'device-api-test-0001',
  });

  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
  assert.match(created.body.key, /^[abcdefghjkmnpqrstuvwxyz23456789]{14}$/);
  assert.match(created.body.ownerKey, /^[abcdefghjkmnpqrstuvwxyz23456789]{24}$/);
  assert.equal(created.body.rev, 1);

  const { id, key, ownerKey } = created.body;
  const read = await request('GET', `/api/parties/${id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.state, initialState);
  assert.equal(read.body.rev, 1);
  assert.equal(read.body.key, undefined);
  assert.equal(read.body.ownerKey, undefined);

  const unchanged = await request('GET', `/api/parties/${id}?rev=1`);
  assert.equal(unchanged.status, 204);
  assert.equal(unchanged.body, null);

  const updatedState = partyState('Fiesta de pruebas actualizada');
  updatedState.party.updatedAt = 2;

  const forbiddenWrite = await request('PUT', `/api/parties/${id}`, {
    key: 'aaaaaaaaaaaaaa',
    rev: 1,
    state: updatedState,
  });
  assert.equal(forbiddenWrite.status, 403);

  const staleWrite = await request('PUT', `/api/parties/${id}`, {
    key,
    rev: 0,
    state: updatedState,
  });
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.body.rev, 1);

  const written = await request('PUT', `/api/parties/${id}`, {
    key,
    rev: 1,
    state: updatedState,
    actorId: 'p1',
    deviceId: 'device-api-test-0001',
  });
  assert.equal(written.status, 200);
  assert.equal(written.body.rev, 2);

  const forbiddenDelete = await request('DELETE', `/api/parties/${id}`, {
    ownerKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    rev: 2,
    confirmName: updatedState.party.name,
  });
  assert.equal(forbiddenDelete.status, 403);

  const staleDelete = await request('DELETE', `/api/parties/${id}`, {
    ownerKey,
    rev: 1,
    confirmName: updatedState.party.name,
  });
  assert.equal(staleDelete.status, 409);

  const mismatchedName = await request('DELETE', `/api/parties/${id}`, {
    ownerKey,
    rev: 2,
    confirmName: 'Otra fiesta',
  });
  assert.equal(mismatchedName.status, 400);

  const deleted = await request('DELETE', `/api/parties/${id}`, {
    ownerKey,
    rev: 2,
    confirmName: updatedState.party.name,
    deviceId: 'device-api-test-0001',
  });
  assert.equal(deleted.status, 202);
  assert.ok(Date.parse(deleted.body.purgeAt) > Date.now());

  const deletedRead = await request('GET', `/api/parties/${id}`);
  assert.equal(deletedRead.status, 410);
  assert.equal(deletedRead.body.error, 'Esta fiesta está borrada');

  const forbiddenRestore = await request('POST', `/api/parties/${id}/restore`, {
    ownerKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(forbiddenRestore.status, 403);

  const restored = await request('POST', `/api/parties/${id}/restore`, {
    ownerKey,
    deviceId: 'device-api-test-0001',
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.id, id);
  assert.equal(restored.body.key, key);
  assert.equal(restored.body.ownerKey, ownerKey);
  assert.equal(restored.body.rev, 2);
  assert.deepEqual(restored.body.state, updatedState);

  const finalRead = await request('GET', `/api/parties/${id}`);
  assert.equal(finalRead.status, 200);
  assert.equal(finalRead.body.rev, 2);
  assert.deepEqual(finalRead.body.state, updatedState);
});

test('create and client-event endpoints return retry guidance at their limits', async () => {
  const createAddress = '198.51.100.20';
  assert.equal((await request('POST', '/api/parties', { state: partyState('Una') }, createAddress)).status, 201);
  assert.equal((await request('POST', '/api/parties', { state: partyState('Dos') }, createAddress)).status, 201);
  const createLimited = await request('POST', '/api/parties', { state: partyState('Tres') }, createAddress);
  assert.equal(createLimited.status, 429);
  assert.match(createLimited.headers.get('retry-after'), /^\d+$/);

  const eventAddress = '198.51.100.30';
  const event = {
    events: [{
      code: 'usage.support_opened',
      route: 'client',
      deviceId: 'device-api-test-0002',
    }],
  };
  assert.equal((await request('POST', '/api/events', event, eventAddress)).status, 202);
  assert.equal((await request('POST', '/api/events', event, eventAddress)).status, 202);
  const eventLimited = await request('POST', '/api/events', event, eventAddress);
  assert.equal(eventLimited.status, 429);
  assert.match(eventLimited.headers.get('retry-after'), /^\d+$/);
});
