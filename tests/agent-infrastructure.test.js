'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Claude imports the canonical agent instructions without duplicating them', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const normalizedAgents = agents.replace(/\s+/g, ' ');
  assert.match(claude, /^@AGENTS\.md$/m);
  assert.doesNotMatch(claude, /^## (Repository Map|Language Policy|Rules|Testing)$/m);
  assert.match(agents, /Read `REVIEW\.md` before reviewing a pull request/);

  for (const invariant of [
    'write keys stay in the hash so they do not reach logs',
    'Do not mention sync, revisions, or conflicts in user-facing copy',
    'Shared-party data lives in the `api-data` volume and must not be logged',
    'demo data and must never upload it to the server',
  ]) {
    assert.ok(normalizedAgents.includes(invariant), `AGENTS.md is missing ${invariant}`);
  }
});

test('the review contract and pull request template preserve the guardrail ratchet', () => {
  const review = read('REVIEW.md');
  const template = read('.github/pull_request_template.md');

  for (const required of [
    'Product and data',
    'Security and privacy',
    'Frontend and accessibility',
    'Operations and release',
    'ready to merge',
    'scripts/check.sh',
  ]) {
    assert.ok(review.includes(required), `REVIEW.md is missing ${required}`);
  }

  assert.match(template, /Reusable guardrail/);
  assert.match(template, /test\/CI, script, AGENTS\.md, REVIEW\.md, or a project skill/);
  assert.match(template, /Merge only by default/);
});

test('project skills are complete, discoverable, and tied to repository contracts', () => {
  const skills = {
    'review-apachas-change': ['REVIEW.md', 'scripts/check.sh', 'ready to merge'],
    'verify-apachas-mobile': ['390 px', 'temporary `DATA_DIR`', 'read-only'],
    'release-apachas': ['scripts/deploy.sh', 'origin/main', '/api/health'],
  };

  for (const [name, required] of Object.entries(skills)) {
    const skill = read(`.claude/skills/${name}/SKILL.md`);
    const metadata = read(`.claude/skills/${name}/agents/openai.yaml`);

    assert.match(skill, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(skill, /^description: .{40,}$/m);
    assert.doesNotMatch(skill, /\[TODO|Structuring This Skill|Resources \(optional\)/);
    for (const value of required) {
      assert.ok(skill.includes(value), `${name} is missing ${value}`);
    }
    assert.ok(metadata.includes(`$${name}`), `${name} metadata lacks its invocation`);
  }
});
