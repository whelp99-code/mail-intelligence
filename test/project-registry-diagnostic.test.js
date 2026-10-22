import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseProjectRegistry } from '../src/domain/project-registry-diagnostic.js';
import { diagnoseProjectRegistryFile } from '../scripts/diagnose-project-registry.mjs';

const uuid = '11111111-2222-3333-4444-555555555555';
const key = uuid.replace(/-/g, '');
const notion = (sourceId = uuid, projectKey = 'PRJ-SYN-001') => ({ sourceId, projectKey });
const mi = (projectKey = key, id = 7, status = 'active') => ({ id, projectKey, status });

// #97 / REQ-INT-009: missing registry identity is not a candidate scoring failure.
test('registry gap diagnosis detects missing projects and preserves exact identities', () => {
  const input = { notionProjects: [notion(), notion('syn-missing', 'PRJ-SYN-002')], miProjects: [mi()] };
  const before = structuredClone(input);
  const report = diagnoseProjectRegistry(input);
  assert.deepEqual(report.counts, { notion: 2, mi: 1, matched: 1, missingInMi: 1, ambiguous: 0, matchedArchived: 0, unmatchedMi: 0 });
  assert.equal(report.projects[1].status, 'missing_in_mi');
  assert.deepEqual(input, before);
  assert.equal(report.readOnly, true);
});

test('exact business keys match but names, aliases, case and malformed UUIDs do not', () => {
  const report = diagnoseProjectRegistry({ notionProjects: [notion()], miProjects: [mi('PRJ-SYN-001')] });
  assert.equal(report.counts.matched, 1);
  for (const badKey of ['prj-syn-001', key.slice(0, 8) + '--' + key.slice(8), 'unrelated']) {
    const result = diagnoseProjectRegistry({ notionProjects: [notion()],
      miProjects: [{ ...mi(badKey), name: uuid, aliases: ['PRJ-SYN-001'] }] });
    assert.equal(result.counts.missingInMi, 1);
    assert.equal(result.counts.unmatchedMi, 1);
  }
  assert.equal(diagnoseProjectRegistry({ notionProjects: [notion()], miProjects: [mi(uuid.toUpperCase())] }).counts.matched, 1);
});

test('duplicate or conflicting identities are ambiguous, never silently chosen', () => {
  const scenarios = [
    { notionProjects: [notion()], miProjects: [mi(), mi('PRJ-SYN-001', 8)] },
    { notionProjects: [notion(), notion()], miProjects: [mi()] },
    { notionProjects: [notion(), notion('syn-other')], miProjects: [mi('PRJ-SYN-001')] },
    { notionProjects: [notion()], miProjects: [mi(), mi(key, 8)] },
    { notionProjects: [notion(), notion()], miProjects: [] },
  ];
  for (const input of scenarios) {
    const report = diagnoseProjectRegistry(input);
    assert.equal(report.counts.ambiguous, input.notionProjects.length);
    assert.equal(report.counts.missingInMi, 0);
    assert.equal(report.counts.matched, 0);
  }
});

test('duplicate business keys are ambiguous without MI matches regardless of order', () => {
  const projects = [notion('syn-one'), notion('syn-two')];
  for (const notionProjects of [projects, [...projects].reverse()]) {
    for (const miProjects of [[], [mi(key)], [mi('PRJ-SYN-001')]]) {
      const report = diagnoseProjectRegistry({ notionProjects, miProjects });
      assert.equal(report.counts.ambiguous, 2);
      assert.equal(report.counts.missingInMi, 0);
      assert.equal(report.counts.matched, 0);
      assert.deepEqual(report.projects.map(p => p.status), ['ambiguous', 'ambiguous']);
    }
  }
  const emptyKeys = diagnoseProjectRegistry({
    notionProjects: [notion('syn-one', ''), notion('syn-two', '')], miProjects: [],
  });
  assert.equal(emptyKeys.counts.missingInMi, 2);
  assert.equal(emptyKeys.counts.ambiguous, 0);
});

test('archived local projects are present, and empty scoped registries are explicit', () => {
  const report = diagnoseProjectRegistry({ notionProjects: [notion()], miProjects: [mi(key, 7, 'archived')] });
  assert.equal(report.counts.matchedArchived, 1);
  assert.equal(report.counts.missingInMi, 0);
  assert.equal(diagnoseProjectRegistry({ notionProjects: [], miProjects: [mi()] }).counts.unmatchedMi, 1);
  assert.equal(diagnoseProjectRegistry({ notionProjects: [], miProjects: [] }).counts.missingInMi, 0);
});

test('invalid projections fail closed rather than reporting false absence', () => {
  for (const input of [undefined, {}, { notionProjects: null, miProjects: [] },
    { notionProjects: [notion('')], miProjects: [] },
    { notionProjects: [notion()], miProjects: [mi('', 7)] },
    { notionProjects: [], miProjects: [mi(key, 0)] },
    { notionProjects: [], miProjects: [mi(key, 7, 'unknown')] },
    { notionProjects: [], miProjects: [mi(), mi()] },
    { notionProjects: [null], miProjects: [] }]) {
    assert.throws(() => diagnoseProjectRegistry(input), /Invalid project identity projection/);
  }
});

test('CLI reads only an explicit pinned projection, writes nothing and redacts errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-diagnostic-'));
  try {
    const input = join(root, 'project-identities.json');
    const bytes = JSON.stringify({ notionProjects: [notion()], miProjects: [] });
    writeFileSync(input, bytes, { mode: 0o600 });
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(diagnoseProjectRegistryFile({ input, expectedSha256: hash }).counts.missingInMi, 1);
    assert.equal(readFileSync(input, 'utf8'), bytes);
    assert.throws(() => diagnoseProjectRegistryFile({ input, expectedSha256: '0'.repeat(64) }), /digest mismatch/);
    assert.throws(() => diagnoseProjectRegistryFile({ input }), /SHA256 required/);
    const script = resolve('scripts/diagnose-project-registry.mjs');
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const result = run(['--input', input, '--expected-sha256', hash]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).counts.missingInMi, 1);
    for (const args of [[], ['--database', '/forbidden'], ['--apply'], ['--input', 'SECRET-PATH', '--expected-sha256', hash]]) {
      const failure = run(args);
      assert.equal(failure.status, 1);
      assert.equal(failure.stdout, '');
      assert.equal(failure.stderr.trim(), 'Project registry diagnostic failed.');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
