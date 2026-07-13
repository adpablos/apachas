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

test('usage events are reported once per code and party in a browser session', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    var S = { remote: { id: 'party-one' } };
    const reportedUsageEvents = new Set();
    const sent = [];
    function reportClientEvent(code, details) { sent.push({ code, details }); }
    ${extractFunction(scripts[0], 'reportUsageEvent')}
    this.testExports = { reportUsageEvent, sent };
  `, context, { filename: 'public/index.html#usage-events' });

  context.testExports.reportUsageEvent('usage.accounts_viewed');
  context.testExports.reportUsageEvent('usage.accounts_viewed');
  context.S.remote.id = 'party-two';
  context.testExports.reportUsageEvent('usage.accounts_viewed');
  context.testExports.reportUsageEvent('usage.support_opened');

  assert.deepEqual(plain(context.testExports.sent.map((event) => event.code)), [
    'usage.accounts_viewed',
    'usage.accounts_viewed',
    'usage.support_opened',
  ]);
});

test('feedback leaves through a context-free external link without embedded third-party code', () => {
  assert.match(html, /const FEEDBACK_URL = 'https:\/\/apachas\.featurebase\.app';/);
  assert.match(html, /href="\$\{FEEDBACK_URL\}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
  assert.match(html, /reportUsageEvent\('usage\.feedback_opened'\)/);
  assert.doesNotMatch(html,
    /reportUsageEvent\('usage\.feedback_opened'\);\s*closeSheet\(\)/);
  assert.match(html, /El tablón lo gestiona Featurebase/);
  assert.match(html, /No incluyas nombres, importes ni enlaces del plan/);
  assert.doesNotMatch(html, /<script[^>]+src=["'][^"']*featurebase/i);
  assert.doesNotMatch(html, /<iframe[^>]+featurebase/i);
  assert.doesNotMatch(html, /FEEDBACK_URL\s*\+/);
  assert.doesNotMatch(html, /featurebase\.app\/[^'"\s<]/i);
});

test('feedback has one clear global entry with keyboard and touch access', () => {
  const footerSource = extractFunction(scripts[0], 'footerHtml');
  const bindFooterSource = extractFunction(scripts[0], 'bindFooter');
  assert.match(html, /querySelectorAll\('a\[href\],button:not\(\[disabled\]\)/);
  assert.match(html, /\.utility-entry\{[\s\S]*?min-height:56px/);
  assert.equal([...footerSource.matchAll(/id="feedbackButton"/g)].length, 1);
  assert.match(footerSource, /Comentarios e ideas/);
  assert.match(footerSource, /Cuéntanos qué falla o qué mejorarías/);
  assert.match(bindFooterSource, /feedback\.onclick = feedbackSheet/);
  assert.doesNotMatch(html, /accountsFeedbackButton|privacyFeedbackButton|feedback-cta/);
});

test('party management is grouped without changing role or owner capabilities', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    const OWNER_KEY_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{24}$/i;
    var S;
    var readOnly;
    var admin;
    function isReadOnlyParty() { return readOnly; }
    function isAdmin() { return admin; }
    ${extractFunction(scripts[0], 'partyOptionsHtml')}
    this.renderOptions = (state, isReadOnly, isCurrentAdmin) => {
      S = state;
      readOnly = isReadOnly;
      admin = isCurrentAdmin;
      return partyOptionsHtml();
    };
  `, context, { filename: 'public/index.html#party-options' });

  const editableAdminOwnerOptions = context.renderOptions({
    remote: { ownerKey: 'abcdefghjkmnpqrstuvwxy23' },
    items: [{ status: 'pending' }],
  }, false, true);
  for(const id of ['activityButton', 'renameButton', 'repeatPartyButton',
    'forgetPartyButton', 'deletePartyButton']) {
    assert.match(editableAdminOwnerOptions, new RegExp(`id="${id}"`));
  }
  assert.match(editableAdminOwnerOptions, /Gestionar este plan/);
  assert.doesNotMatch(editableAdminOwnerOptions, /switchPartyButton|Ver tus planes/);

  const readOnlyOptions = context.renderOptions({
    remote: { ownerKey: 'abcdefghjkmnpqrstuvwxy23' },
    items: [{ status: 'pending' }],
  }, true, true);
  assert.match(readOnlyOptions, /id="activityButton"/);
  assert.match(readOnlyOptions, /id="forgetPartyButton"/);
  assert.doesNotMatch(readOnlyOptions, /id="(?:rename|repeatParty|switchParty|deleteParty)Button"/);

  const nonAdminOwnerOptions = context.renderOptions({
    remote: { ownerKey: 'abcdefghjkmnpqrstuvwxy23' },
    items: [{ status: 'pending' }],
  }, false, false);
  assert.match(nonAdminOwnerOptions, /id="deletePartyButton"/,
    'The creator-phone capability must stay independent of the admin role');
  assert.doesNotMatch(nonAdminOwnerOptions, /id="(?:rename|repeatParty)Button"/);

  const localNonAdminOptions = context.renderOptions({ remote: null, items: [] }, false, false);
  assert.doesNotMatch(localNonAdminOptions, /Actividad y datos/,
    'Empty option groups should not render');
});

test('recent live parties keep access and per-party context until explicitly forgotten', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    const RECENT_PARTIES_KEY = 'recent';
    const PARTY_ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/i;
    const WRITE_KEY_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{14}$/i;
    const OWNER_KEY_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{24}$/i;
    const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
    const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;
    const PARTY_TABS = ['party','list','group','accounts'];
    const data = new Map();
    const localStorage = {
      getItem: key => data.has(key) ? data.get(key) : null,
      setItem: (key,value) => data.set(key,String(value)),
    };
    const now = () => 9999999999999;
    var S = null;
    ${extractFunction(scripts[0], 'loadRecentParties')}
    ${extractFunction(scripts[0], 'rememberCurrentParty')}
    this.testExports = { data, loadRecentParties, rememberCurrentParty, setState:value => { S=value; } };
  `, context, { filename: 'public/index.html#recent-parties' });

  const parties = ['2','3','4','5','6','7'].map((suffix,index) => ({
    id: `abcdefghj${suffix}`,
    key: 'abcdefghjkmnpq',
    readOnly: false,
    name: `Fiesta ${index + 1}`,
    date: null,
    lastOpenedAt: 1,
  }));
  context.testExports.data.set('recent', JSON.stringify(parties));

  assert.equal(context.testExports.loadRecentParties().length, 6,
    'Old access pointers and the sixth party must not disappear silently');

  context.testExports.setState({
    remote: { id: 'abcdefghj2', key: 'abcdefghjkmnpq', ownerKey: 'abcdefghjkmnpqrstuvwxy23' },
    party: { name: 'Fiesta 1', date: '2026-07-13', demo: false },
    me: 'p1',
    tab: 'accounts',
  });
  context.testExports.rememberCurrentParty();
  const remembered = context.testExports.loadRecentParties();
  assert.equal(remembered.length, 6);
  assert.deepEqual(plain({ id:remembered[0].id, me:remembered[0].me, tab:remembered[0].tab }),
    { id:'abcdefghj2', me:'p1', tab:'accounts' });
});

test('core copy and controls state money actions literally and expose accessible names', () => {
  const partySource = extractFunction(scripts[0], 'partyView');
  assert.doesNotMatch(html,
    /catar|catan|Sí, adelante|Solo quiero mirar|\bpa\b|garrafón no|Haz bizum/i);
  assert.match(html, /¿Entre quiénes se reparte\?/);
  assert.match(html, /Quién paga a quién para quedar en paz/);
  assert.match(partySource, /Te queda un Bizum para quedar en paz/);
  assert.match(partySource, /Te quedan \$\{myOutgoingBizums\.length\} Bizums para quedar en paz/);
  assert.match(partySource, /Solo quedan los Bizums pendientes/);
  assert.match(html, /id="offlineBanner" role="status"/);
  assert.match(extractFunction(scripts[0], 'refreshSync'), /banner\.textContent !== message/);
  assert.match(partySource, /<h1 class="title">\$\{escapeHtml\(S\.party\.name\)\}<\/h1>/);
  assert.match(html, /aria-label="Cambiar quién pagó"/);
  assert.match(html, /aria-label="Cambiar el reparto"/);
  assert.match(html, /aria-pressed="\$\{classes\.split/);
  for(const inputId of ['linkInput', 'codeInput', 'itemInput', 'personInput']) {
    assert.match(html, new RegExp(`for="${inputId}"`));
  }
});

test('plan framing makes expenses primary while preserving pending planning', () => {
  const partySource = extractFunction(scripts[0], 'partyView');
  const listSource = extractFunction(scripts[0], 'listView');
  const createSource = extractFunction(scripts[0], 'createPartySheet');

  assert.match(html, /Una fiesta, un viaje o lo que se tercie/);
  assert.match(html, /data-tab="party"[\s\S]*?Plan<\/button>/);
  assert.match(html, /data-tab="list"[\s\S]*?Gastos<\/button>/);
  assert.match(createSource, /Nombre del plan/);
  assert.match(createSource, /Fecha de inicio \(opcional\)/);
  assert.match(listSource, /Pendiente por comprar o llevar/);
  assert.match(listSource, /Gastos apuntados/);
  assert.match(html, /Mandar lo que falta al grupo/);
  assert.doesNotMatch(html,
    /Mandar la lista|Quitar de la lista|no está en la lista|Quitada de la lista|añadió .* a la lista/);
  assert.doesNotMatch(html, /Ya está apuntada como gasto/);
  assert.ok(listSource.indexOf('id="directExpenseButton"') <
    listSource.indexOf('Pendiente por comprar o llevar'),
    'The direct expense action should come before pending planning');
  assert.doesNotMatch(listSource, /Ya compradas|Todo comprado/);
  assert.match(partySource, /Todo cuadrado\. Vaya máquinas\./);
  assert.match(partySource, /\$\{boughtCount\} gasto/);
});

test('global party switching stays separate from active-party management', () => {
  const partySource = extractFunction(scripts[0], 'partyView');
  const partyOptionsSource = extractFunction(scripts[0], 'partyOptionsHtml');
  const partySwitcherSource = extractFunction(scripts[0], 'partySwitcherSheet');
  const renderSource = extractFunction(scripts[0], 'render');
  const entrySource = extractFunction(scripts[0], 'entryView');
  const bindEntrySource = extractFunction(scripts[0], 'bindEntry');
  const bindViewSource = extractFunction(scripts[0], 'bindView');

  assert.match(html, /<body class="no-party">/);
  assert.match(html,
    /<header class="app-header" id="appHeader">[\s\S]*id="partySwitcherButton"[\s\S]*id="themeButton"[\s\S]*<\/header>/);
  assert.match(html, /id="partySwitcherButton" type="button" aria-haspopup="dialog"/);
  assert.match(html, /#themeButton\{\s*flex:none;/);
  assert.doesNotMatch(html, /#themeButton\{[^}]*position:absolute/);
  assert.match(renderSource, /classList\.toggle\('no-party', !S\)/);
  assert.doesNotMatch(renderSource, /appHeader\.hidden/);
  assert.match(renderSource, /partySwitcherName.*S\.party\.name/);
  assert.match(html, /getElementById\('partySwitcherButton'\).*partySwitcherSheet/s);
  assert.match(partySwitcherSource, /Este plan solo está en este móvil/);
  assert.match(html, /\.recent-list\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /\.recent-party-row\{[^}]*min-width:0;width:100%/);
  assert.match(partySource, /id="partyOptionsButton"/);
  assert.match(partySource, /Gestionar este plan/);
  assert.match(partySource, /aria-haspopup="dialog"/);
  assert.match(partyOptionsSource, /Gestionar este plan/);
  assert.doesNotMatch(partyOptionsSource, /switchPartyButton|Ver tus planes|Cambiar de plan/);
  assert.doesNotMatch(partySource,
    /id="(?:activity|rename|repeatParty|newParty|forgetParty|deleteParty|demo)Button"/);
  assert.match(entrySource, /id="demoButton"/);
  assert.match(bindEntrySource, /querySelector\('#demoButton'\)/);
  assert.doesNotMatch(bindViewSource, /#demoButton/);
});

test('recent-party switching keeps its sheet busy until the target has opened', async () => {
  const context = vm.createContext({});
  vm.runInContext(`
    var S = { me: 'p1' };
    var openResult = false;
    var closeCount = 0;
    var buttonFocusCount = 0;
    function render() {}
    function closeSheet() { closeCount += 1; }
    function openLiveLink() { return Promise.resolve(openResult); }
    async function withBusyButton(button, pendingText, task) { return task(); }
    function isSheetOpen() { return true; }
    function $(selector) { return sheet; }
    ${extractFunction(scripts[0], 'bindRecentPartyControls')}
    const button = {
      dataset: { recentIndex: '0' },
      isConnected: true,
      focus() { buttonFocusCount += 1; },
    };
    const sheet = {
      contains(element) { return element === button; },
      focus() {},
      hasAttribute() { return false; },
      setAttribute() {},
      removeAttribute() {},
    };
    const container = {
      querySelectorAll(selector) {
        return selector === '[data-recent-index]' ? [button] : [];
      },
    };
    bindRecentPartyControls(container, [{ id: 'abcdefghj2', key: 'abcdefghjkmnpq' }]);
    this.testExports = {
      button,
      setOpenResult(value) { openResult = value; },
      setIdentity(value) { S = { me: value }; },
      closeCount() { return closeCount; },
      buttonFocusCount() { return buttonFocusCount; },
    };
  `, context, { filename: 'public/index.html#recent-party-controls' });

  await context.testExports.button.onclick();
  assert.equal(context.testExports.closeCount(), 0, 'A failed open must leave the sheet available');
  assert.equal(context.testExports.buttonFocusCount(), 1, 'A failed open must restore focus to its button');

  context.testExports.setOpenResult(true);
  await context.testExports.button.onclick();
  assert.equal(context.testExports.closeCount(), 1, 'A successful open with identity closes the switcher');

  context.testExports.setIdentity(null);
  await context.testExports.button.onclick();
  assert.equal(context.testExports.closeCount(), 1, 'The identity sheet must remain open for a new party');
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
