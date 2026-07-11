'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const HTML_FILE = path.resolve(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(HTML_FILE, 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim());

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected function ${name} in public/index.html`);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingBrace; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not find the end of function ${name}`);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function coreContext(extraSource, exportedNames) {
  const context = vm.createContext({});
  const declarations = [
    'stableEntityId',
    'legacyTransferId',
    'migrateLegacyTransfers',
    'normalizeAudit',
    'migrateState',
    'mergeStates',
    'accounts',
    'isRemoteParty',
    'canEditParty',
    'isReadOnlyParty',
  ].map((name) => extractFunction(scripts[0], name)).join('\n');
  vm.runInContext(`
    const STATE_VERSION = 6;
    const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
    const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;
    ${extraSource}
    ${declarations}
    this.testExports = { ${exportedNames.join(', ')} };
  `, context, { filename: 'public/index.html#core-functions' });
  return { context, functions: context.testExports };
}

test('the browser script parses as JavaScript', () => {
  assert.equal(scripts.length, 1, 'Expected one self-contained inline script');
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: HTML_FILE }));
});

test('v5 migration freezes consumers and turns completed settlements into transfers', () => {
  const { functions } = coreContext('', ['migrateState']);
  const migrated = functions.migrateState({
    v: 5,
    party: { name: 'Fiesta antigua', date: 'not-a-date' },
    people: [
      { id: 'p1', name: 'Ana', admin: true, active: true },
      { id: 'p2', name: 'Luis', admin: false, active: false },
    ],
    items: [
      { id: 'i1', name: 'Cena', status: 'bought', payerId: 'p1', priceCents: 1000 },
      { id: 'i2', name: 'Hielo', status: 'claimed', claimerId: 'p2' },
    ],
    settled: {
      'p2>p1': { done: true, cents: 500, at: 123, by: 'p2' },
    },
    tombstones: [],
  });

  assert.equal(migrated.v, 6);
  assert.equal(migrated.party.date, null);
  assert.deepEqual(plain(migrated.items[0].consumers), ['p1']);
  assert.equal(migrated.items[1].status, 'pending');
  assert.equal(migrated.items[1].claimerId, undefined);
  assert.equal(migrated.transfers.length, 1);
  assert.deepEqual(plain({
    fromId: migrated.transfers[0].fromId,
    toId: migrated.transfers[0].toId,
    cents: migrated.transfers[0].cents,
  }), { fromId: 'p2', toId: 'p1', cents: 500 });
});

test('shared-state merge preserves newer edits and referenced people', () => {
  const { functions } = coreContext('', ['mergeStates']);
  const party = (name, updatedAt) => ({ name, date: null, updatedAt });
  const p1 = { id: 'p1', name: 'Ana', admin: true, active: true, updatedAt: 1 };
  const p2 = { id: 'p2', name: 'Luis', admin: false, active: true, updatedAt: 1 };
  const expense = {
    id: 'i1', name: 'Cena', status: 'bought', payerId: 'p2',
    consumers: ['p1', 'p2'], priceCents: 1000, updatedAt: 20,
  };
  const server = {
    v: 6,
    party: party('Servidor', 1),
    people: [p1, p2],
    items: [expense],
    transfers: [],
    tombstones: [],
  };
  const local = {
    v: 6,
    party: party('Local', 2),
    people: [p1],
    items: [],
    transfers: [],
    tombstones: [
      { id: 'p2', at: 30, seenAt: 10 },
      { id: 'i1', at: 30, seenAt: 10 },
    ],
  };

  const merged = functions.mergeStates(server, local);
  assert.equal(merged.party.name, 'Local');
  assert.equal(merged.items.length, 1, 'An edit newer than its tombstone must survive');
  assert.ok(merged.people.some((person) => person.id === 'p2'),
    'A person referenced by a surviving expense must remain in history');
  assert.equal(merged.tombstones.length, 0);
});

test('accounts include completed transfers when calculating the next Bizum', () => {
  const { context, functions } = coreContext(
    'var S; const consumerIds = item => Array.isArray(item.consumers) ? item.consumers : [];',
    ['accounts'],
  );
  context.S = {
    people: [{ id: 'p1' }, { id: 'p2' }],
    items: [{
      id: 'i1', status: 'bought', payerId: 'p1', priceCents: 101,
      consumers: ['p1', 'p2'],
    }],
    transfers: [{ id: 't1', fromId: 'p2', toId: 'p1', cents: 20 }],
  };

  const result = functions.accounts();
  assert.equal(result.total, 101);
  assert.deepEqual(plain(result.owes), { p1: 51, p2: 50 });
  assert.deepEqual(plain(result.balance), { p1: 30, p2: -30 });
  assert.deepEqual(plain(result.bizums), [{ fromId: 'p2', toId: 'p1', cents: 30 }]);
});

test('read-only access is exactly the inverse of edit access for an open party', () => {
  const { context, functions } = coreContext(
    'var S; const WRITE_KEY_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{14}$/;',
    ['canEditParty', 'isReadOnlyParty'],
  );

  context.S = null;
  assert.equal(functions.canEditParty(), false);
  assert.equal(functions.isReadOnlyParty(), false);

  context.S = { party: { demo: false }, remote: null };
  assert.equal(functions.canEditParty(), true);
  assert.equal(functions.isReadOnlyParty(), false);

  context.S = {
    party: { demo: false },
    remote: { id: 'abcdefghjk', key: 'abcdefghjkmnpq' },
  };
  assert.equal(functions.canEditParty(), true);
  assert.equal(functions.isReadOnlyParty(), false);

  context.S.remote.key = null;
  assert.equal(functions.canEditParty(), false);
  assert.equal(functions.isReadOnlyParty(), true);

  context.S = { party: { demo: false }, remote: null, localReadOnly: true };
  assert.equal(functions.canEditParty(), false);
  assert.equal(functions.isReadOnlyParty(), true);
});
