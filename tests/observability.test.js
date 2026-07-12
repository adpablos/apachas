'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'api.js');

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

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function state() {
  return {
    v: 6,
    party: { name: 'Secret celebration name', date: '2026-08-15', updatedAt: 1 },
    people: [
      { id: 'p1', name: 'Private person one', admin: true, active: true, updatedAt: 1 },
      { id: 'p2', name: 'Private person two', admin: false, active: true, updatedAt: 1 },
    ],
    items: [], transfers: [], tombstones: [],
  };
}

test('remote observability is allowlisted, pseudonymous, and server-derived', async (t) => {
  const records = [];
  let forcedCaptureFailure = false;
  const collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const responseStatus = req.url === '/capture/' && !forcedCaptureFailure ? 503 : 200;
      if (responseStatus === 503) forcedCaptureFailure = true;
      records.push({
        path: req.url,
        authorization: req.headers.authorization,
        body,
        responseStatus,
      });
      res.writeHead(responseStatus).end('{}');
    });
  });
  const collectorPort = await availablePort();
  collector.listen(collectorPort, '127.0.0.1');
  await once(collector, 'listening');

  const apiPort = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apachas-observability-test-'));
  let output = '';
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      STATIC_DIR: path.join(dataDir, 'no-static-files'),
      RATE_MAX: '1000',
      CREATE_RATE_MAX: '1000',
      EVENT_RATE_MAX: '1000',
      APP_RELEASE: 'test-release',
      ALLOW_INSECURE_OBSERVABILITY_FOR_TESTS: '1',
      BETTER_STACK_SOURCE_TOKEN: 'better-stack-test-token',
      BETTER_STACK_INGESTING_URL: `http://127.0.0.1:${collectorPort}/logs`,
      POSTHOG_API_KEY: 'posthog-test-key',
      POSTHOG_HOST: `http://127.0.0.1:${collectorPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captureOutput = (chunk) => { output += chunk.toString(); };
  child.stdout.on('data', captureOutput);
  child.stderr.on('data', captureOutput);

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    collector.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitUntil(async () => {
    try { return (await fetch(`${baseUrl}/api/live`)).ok; } catch (error) { return false; }
  }, 'API did not start');

  const poisonedRequestId = 'AlejandroDePablos';
  const poisonedResponse = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': poisonedRequestId },
    body: JSON.stringify({ events: [{
      code: 'usage.support_opened', route: 'client', deviceId: 'private-device-00000003',
    }] }),
  });
  assert.equal(poisonedResponse.status, 202);
  assert.notEqual(poisonedResponse.headers.get('X-Request-ID'), poisonedRequestId);
  assert.match(poisonedResponse.headers.get('X-Request-ID'), /^[a-f0-9-]{36}$/);

  async function request(method, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const initial = state();
  const firstDevice = 'private-device-00000001';
  const secondDevice = 'private-device-00000002';
  const created = await request('POST', '/api/parties', {
    state: initial, actorId: 'p1', deviceId: firstDevice,
  });
  assert.equal(created.status, 201);

  const withExpense = structuredClone(initial);
  withExpense.items.push({
    id: 'i1', name: 'Private expense content', status: 'bought', payerId: 'p1',
    consumers: ['p1', 'p2'], priceCents: 987654, createdAt: 2, updatedAt: 2,
  });
  const expense = await request('PUT', `/api/parties/${created.body.id}`, {
    key: created.body.key, rev: 1, state: withExpense, actorId: 'p2', deviceId: secondDevice,
  });
  assert.equal(expense.status, 200);

  const withTransfer = structuredClone(withExpense);
  withTransfer.transfers.push({
    id: 't1', fromId: 'p2', toId: 'p1', cents: 12345, createdAt: 3, updatedAt: 3,
  });
  const transfer = await request('PUT', `/api/parties/${created.body.id}`, {
    key: created.body.key, rev: 2, state: withTransfer, actorId: 'p2', deviceId: secondDevice,
  });
  assert.equal(transfer.status, 200);

  const usage = await request('POST', '/api/events', { events: [
    {
      code: 'usage.accounts_viewed', route: 'client',
      partyId: created.body.id, deviceId: secondDevice,
    },
    {
      code: 'usage.feedback_opened', route: 'client',
      partyId: created.body.id, deviceId: secondDevice,
    },
  ] });
  assert.equal(usage.status, 202);

  const validRelatedRequestId = '123e4567-e89b-42d3-a456-426614174000';
  const adversarialError = await request('POST', '/api/events', { events: [
    {
      code: 'client.error', route: 'client', partyId: created.body.id,
      deviceId: secondDevice, requestId: 'PrivateNameCanLeak', errorType: 'PrivatePerson',
    },
    {
      code: 'client.error', route: 'client', partyId: created.body.id,
      deviceId: secondDevice, requestId: validRelatedRequestId, errorType: 'TypeError',
    },
  ] });
  assert.equal(adversarialError.status, 202);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, `${created.body.id}.json`), 'utf8'));
  assert.deepEqual(stored.milestones, {
    collaborationStarted: true,
    firstExpenseRecorded: true,
    firstTransferCompleted: true,
  });

  const expectedEvents = new Set([
    'party_created', 'collaboration_started', 'first_expense_recorded',
    'first_transfer_completed', 'accounts_viewed', 'feedback_opened',
  ]);
  await waitUntil(() => {
    const received = new Set(records.filter((record) => record.path === '/capture/')
      .map((record) => record.body.event));
    return [...expectedEvents].every((event) => received.has(event));
  }, 'Expected product events were not captured');

  const failedCapture = records.find((record) => record.responseStatus === 503);
  assert.ok(failedCapture, 'The collector should exercise one transient provider failure');
  assert.ok(records.some((record) => record.responseStatus === 200 &&
    record.body.properties?.$insert_id === failedCapture.body.properties.$insert_id),
    'A retry must reuse the same deduplication ID');

  const productRecords = records.filter((record) => record.path === '/capture/' &&
    record.responseStatus === 200 &&
    expectedEvents.has(record.body.event));
  assert.equal(productRecords.length, expectedEvents.size);
  const partyRefs = new Set();
  for (const record of productRecords) {
    assert.deepEqual(Object.keys(record.body).sort(), ['api_key', 'event', 'properties']);
    assert.deepEqual(Object.keys(record.body.properties).sort(),
      ['$insert_id', '$process_person_profile', 'distinct_id', 'release', 'source']);
    assert.equal(record.body.api_key, 'posthog-test-key');
    assert.equal(record.body.properties.$process_person_profile, false);
    assert.match(record.body.properties.distinct_id, /^[a-f0-9]{16}$/);
    assert.equal(record.body.properties.release, 'test-release');
    assert.ok(['server', 'client'].includes(record.body.properties.source));
    assert.match(record.body.properties.$insert_id,
      /^(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/);
    partyRefs.add(record.body.properties.distinct_id);
  }
  assert.equal(partyRefs.size, 1);

  await waitUntil(() => records.some((record) => record.path === '/logs' &&
    record.body.event === 'client_event' && record.body.code === 'client.error'),
    'The adversarial client event was not forwarded');
  const logRecords = records.filter((record) => record.path === '/logs');
  assert.ok(logRecords.every((record) => record.authorization === 'Bearer better-stack-test-token'));
  const allowedLogFields = new Set([
    'timestamp', 'level', 'event', 'release', 'requestId', 'method', 'route', 'status',
    'durationMs', 'partyRef', 'deviceRef', 'auditEvents', 'errorName', 'errorCode',
    'stackRef', 'windowMs', 'requests', 'routes', 'statuses', 'errors', 'auditActions',
    'clientEvents', 'activeParties', 'activeDevices', 'averageDurationMs', 'maxDurationMs',
    'parties', 'deletedParties', 'storageReady', 'storageFreeBytes', 'deleted', 'purgeAt',
    'port', 'node', 'staticServing', 'code', 'source',
  ]);
  assert.ok(logRecords.every((record) =>
    Object.keys(record.body).every((field) => allowedLogFields.has(field))));
  assert.ok(logRecords.every((record) => !Object.hasOwn(record.body, 'stack')));

  const outbound = JSON.stringify(records);
  for (const forbidden of [
    created.body.id, created.body.key, created.body.ownerKey, firstDevice, secondDevice,
    'Secret celebration name', 'Private person one', 'Private person two',
    'Private expense content', 'PrivateNameCanLeak', 'PrivatePerson',
    poisonedRequestId, validRelatedRequestId, 'TypeError', '987654', '12345', '/api/parties/',
  ]) {
    assert.ok(!outbound.includes(forbidden), `Outbound telemetry contained ${forbidden}`);
  }
  assert.match(output, /"event":"request"/, 'Local JSON logs must remain enabled');
  assert.ok(!output.includes('PrivateNameCanLeak'));
  assert.ok(!output.includes('PrivatePerson'));
  assert.ok(output.includes(validRelatedRequestId));
  assert.match(output, /"errorType":"TypeError"/);
});

test('the browser contains no third-party analytics runtime', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!html.includes('posthog-js'));
  assert.ok(!html.includes('eu.i.posthog.com'));
  assert.ok(!html.includes('in.logs.betterstack.com'));
  assert.ok(!/document\.cookie\s*=/.test(html));
  assert.match(html, /usage\.accounts_viewed/);
});
