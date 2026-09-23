#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const EXPECTED = Object.freeze({
  evaluation: 'precision-classification-fixture-v2',
  classifierVersion: 'precision-classification-v1.2.2-fix11',
  fixtures: 20,
  assertions: 77,
  passed: 77,
  failed: 0,
});

function fail(message, strictExitCode = null, failures = []) {
  console.error(JSON.stringify({
    precisionDiagnostic: 'FAIL',
    message,
    strictExitCode,
    failures,
  }, null, 2));
  process.exit(1);
}

const child = spawnSync(process.execPath, ['scripts/evaluate-precision-classification.mjs'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (child.error) fail('Strict precision evaluator could not be started.');
let report;
try {
  report = JSON.parse(child.stdout);
} catch {
  fail('Strict precision evaluator output is malformed.');
}
if (child.status !== 0
  || report.evaluation !== EXPECTED.evaluation
  || report.classifierVersion !== EXPECTED.classifierVersion
  || report.fixtures !== EXPECTED.fixtures
  || report.assertions !== EXPECTED.assertions
  || report.passed !== EXPECTED.passed
  || report.failed !== EXPECTED.failed
  || !Array.isArray(report.failures)
  || report.failures.length !== 0) {
  fail('Strict precision evaluation must pass every current fixture assertion.', child.status, report.failures);
}

console.log(JSON.stringify({
  precisionDiagnostic: 'PASS',
  strictExitCode: child.status,
  blocking: 0,
  reportOnly: 0,
  evaluation: report.evaluation,
  classifierVersion: report.classifierVersion,
  fixtureSummary: {
    fixtures: report.fixtures,
    assertions: report.assertions,
    passed: report.passed,
    failed: report.failed,
  },
}, null, 2));
