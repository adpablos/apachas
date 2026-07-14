'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = path.join(ROOT, 'scripts', 'deploy.sh');
const SCRIPT = fs.readFileSync(DEPLOY, 'utf8');
const UPTIME = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'uptime.yml'), 'utf8');

test('production release requires a valid beta version before any remote action', () => {
  const missing = spawnSync('bash', [DEPLOY], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /Usage: scripts\/deploy\.sh v0\.MINOR\.0-beta\.N/);

  const invalid = spawnSync('bash', [DEPLOY, 'v1.0.0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /Invalid beta version/);
  assert.doesNotMatch(invalid.stderr, /Deploying|Releasing/);
});

test('a missing version tag is not mistaken for an existing commit', () => {
  const missingTag = 'v0.999.0-beta.999^{commit}';
  const probe = spawnSync('git', ['rev-parse', '--verify', missingTag], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(probe.status, 0);
  assert.equal(probe.stdout, '');
});

test('production release is guarded by repository, changelog, runtime, and recording checks', () => {
  assert.match(SCRIPT, /git branch --show-current/);
  assert.match(SCRIPT, /git status --porcelain/);
  assert.match(SCRIPT, /git rev-parse origin\/main/);
  assert.match(SCRIPT, /Unreleased still contains release notes/);
  assert.match(SCRIPT, /CHANGELOG\.md has no dated section/);
  assert.match(SCRIPT, /is not the next beta after/);
  assert.match(SCRIPT, /git rev-parse --verify "\$\{VERSION\}\^\{commit\}"/);
  assert.match(SCRIPT, /scripts\/check\.sh/);
  assert.match(SCRIPT, /APP_VERSION='\$\{VERSION\}' APP_RELEASE/);
  assert.match(SCRIPT, /HEALTH_VERSION/);
  assert.match(SCRIPT, /HEALTH_RELEASE/);
  assert.match(SCRIPT, /JSON\.parse/);
  assert.match(SCRIPT, /git tag "\$VERSION" "\$DEPLOYED_SHA"/);
  assert.match(SCRIPT, /REMOTE_TAG_SHA/);
  assert.match(SCRIPT, /gh release create "\$VERSION"/);
  assert.match(UPTIME, /refs\/tags\/\$\{health_version\}/);
  assert.match(UPTIME, /tag_release/);
});
