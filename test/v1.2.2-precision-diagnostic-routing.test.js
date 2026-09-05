import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const verifier = resolve('scripts/verify-v1.2.2-precision-diagnostic.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('precision diagnostic routes only the approved strict report-only conflict', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.precisionDiagnostic, 'PASS_WITH_REPORT_ONLY_CANONICAL_CONFLICT');
  assert.equal(report.strictExitCode, 1);
  assert.equal(report.blocking, 0);
  assert.equal(report.reportOnly, 1);
  assert.deepEqual(report.policy, ['O-04', 'O-06']);
});

test('precision diagnostic rejects a manifest that adds a second conflict', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'precision-diagnostic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'conflicts.json');
  writeFileSync(manifest, JSON.stringify({
    version: 'precision-report-only-conflicts-v1.2.2',
    conflicts: [
      {
        fixtureId: 'high-importance-reference',
        field: 'priority',
        expected: 'high',
        actual: 'normal',
        policy: ['O-04', 'O-06'],
        disposition: 'report_only',
      },
      {
        fixtureId: 'unexpected',
        field: 'priority',
        expected: 'high',
        actual: 'normal',
        policy: ['O-04', 'O-06'],
        disposition: 'report_only',
      },
    ],
  }), 'utf8');
  const result = run(['--manifest', manifest]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly the approved canonical conflict/);
});

test('strict precision evaluator remains independently failing', () => {
  assert.throws(() => execFileSync(process.execPath, [
    'scripts/evaluate-precision-classification.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }), (error) => {
    assert.equal(error.status, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.failed, 1);
    assert.equal(report.failures[0].id, 'high-importance-reference');
    return true;
  });
});
