import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifier = resolve('scripts/verify-v1.2.2-precision-diagnostic.mjs');

function run(cwd = process.cwd()) {
  return spawnSync(process.execPath, [verifier], {
    cwd,
    encoding: 'utf8',
  });
}

test('precision diagnostic requires a clean strict evaluation without report-only failures', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.precisionDiagnostic, 'PASS');
  assert.equal(report.strictExitCode, 0);
  assert.equal(report.blocking, 0);
  assert.equal(report.reportOnly, 0);
  assert.equal(report.fixtureSummary.passed, 77);
  assert.equal(report.fixtureSummary.failed, 0);
});

test('precision diagnostic rejects a classification mismatch instead of allowing an exception', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'precision-diagnostic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'test/fixtures'), { recursive: true });
  symlinkSync(resolve('src'), join(directory, 'src'), 'dir');
  copyFileSync(resolve('scripts/evaluate-precision-classification.mjs'), join(directory, 'scripts/evaluate-precision-classification.mjs'));
  const fixtures = JSON.parse(readFileSync('test/fixtures/precision-evaluation-v2.json', 'utf8'));
  fixtures[0].expected.workState = 'reference';
  writeFileSync(join(directory, 'test/fixtures/precision-evaluation-v2.json'), JSON.stringify(fixtures));
  const result = run(directory);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr);
  assert.equal(report.precisionDiagnostic, 'FAIL');
  assert.equal(report.strictExitCode, 1);
  assert.equal(report.failures[0].id, 'incoming-due-today-request');
  assert.equal(report.failures[0].field, 'workState');
});

test('strict precision evaluator independently passes every current fixture assertion', () => {
  const result = spawnSync(process.execPath, [
    'scripts/evaluate-precision-classification.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evaluation, 'precision-classification-fixture-v2');
  assert.equal(report.fixtures, 20);
  assert.equal(report.assertions, 77);
  assert.equal(report.passed, 77);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.failures, []);
});

test('v2 retains every historical input and assertion except the policy-corrected priority', () => {
  const historical = JSON.parse(readFileSync('test/fixtures/precision-evaluation.json', 'utf8'));
  const current = JSON.parse(readFileSync('test/fixtures/precision-evaluation-v2.json', 'utf8'));
  const prior = historical.find((fixture) => fixture.id === 'high-importance-reference');
  const corrected = current.find((fixture) => fixture.id === prior.id);
  assert.equal(prior.expected.priority, 'high');
  assert.equal(corrected.expected.priority, 'normal');
  const restored = structuredClone(current);
  restored.find((fixture) => fixture.id === prior.id).expected.priority = prior.expected.priority;
  assert.deepEqual(restored, historical);
});
