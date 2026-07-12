'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check_backup_freshness.sh');
const JQ_SKIP = spawnSync('jq', ['--version']).status === 0 ? false : 'jq is not installed';

function run(directory, extraEnv = {}) {
  return spawnSync(SCRIPT, [], {
    cwd: ROOT,
    env: { ...process.env, APACHAS_BACKUP_DIR: directory, ...extraEnv },
    encoding: 'utf8',
  });
}

test('backup freshness requires a recent complete encrypted pair', { skip: JQ_SKIP }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apachas-backup-monitor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const encryptedFile = 'apachas-20260712T120000Z.tar.gz.age';
  const manifest = path.join(directory, 'apachas-20260712T120000Z.manifest.json');
  const encryptedPath = path.join(directory, encryptedFile);
  const encryptedData = 'encrypted-test-data';
  fs.writeFileSync(encryptedPath, encryptedData);
  fs.writeFileSync(manifest, JSON.stringify({
    encryptedFile,
    encryptedSizeBytes: Buffer.byteLength(encryptedData),
    encryptedSha256: crypto.createHash('sha256').update(encryptedData).digest('hex'),
  }));

  const fresh = run(directory, { APACHAS_BACKUP_MAX_AGE_HOURS: '36' });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Backup is fresh/);

  fs.unlinkSync(encryptedPath);
  const incomplete = run(directory);
  assert.equal(incomplete.status, 65);
  assert.match(incomplete.stderr, /missing or empty/);

  fs.writeFileSync(encryptedPath, encryptedData);
  fs.writeFileSync(encryptedPath, 'truncated');
  const truncated = run(directory);
  assert.equal(truncated.status, 65);
  assert.match(truncated.stderr, /size does not match/);

  fs.writeFileSync(encryptedPath, 'corrupted-test-data');
  const corrupted = run(directory);
  assert.equal(corrupted.status, 65);
  assert.match(corrupted.stderr, /checksum does not match/);

  fs.writeFileSync(encryptedPath, encryptedData);
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(manifest, old, old);
  const stale = run(directory, { APACHAS_BACKUP_MAX_AGE_HOURS: '36' });
  assert.equal(stale.status, 75);
  assert.match(stale.stderr, /older than 36 hours/);
});

test('heartbeat transport is isolated from the no-network backup service', () => {
  const backupService = fs.readFileSync(
    path.join(ROOT, 'deployment', 'systemd', 'apachas-backup.service'), 'utf8');
  const monitorService = fs.readFileSync(
    path.join(ROOT, 'deployment', 'systemd', 'apachas-backup-monitor.service'), 'utf8');
  const monitorScript = fs.readFileSync(SCRIPT, 'utf8');
  const deployScript = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');

  assert.match(backupService, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.doesNotMatch(backupService, /check_backup_freshness|HEARTBEAT/);
  assert.match(monitorService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(monitorService, /^ExecStart=\/usr\/local\/libexec\/apachas-check-backup-freshness$/m);
  assert.match(monitorService, /^ReadOnlyPaths=\/var\/backups\/apachas$/m);
  assert.match(monitorService, /^InaccessiblePaths=\/etc\/apachas \/opt\/apachas \/var\/lib\/docker$/m);
  assert.match(monitorScript, /curl --config -/);
  assert.doesNotMatch(monitorScript, /curl[^\n]*\$HEARTBEAT_URL/);
  assert.match(deployScript,
    /install -o root -g root -m 0755 scripts\/check_backup_freshness\.sh/);
  assert.match(deployScript, /\/usr\/local\/libexec\/apachas-check-backup-freshness/);
});
