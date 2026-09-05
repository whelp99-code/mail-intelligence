#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED = Object.freeze({
  classifierVersion: 'precision-classification-v1.2.2-fix11',
  fixtures: 20,
  assertions: 77,
  passed: 76,
  failed: 1,
  conflict: {
    fixtureId: 'high-importance-reference',
    field: 'priority',
    expected: 'high',
    actual: 'normal',
    policy: ['O-04', 'O-06'],
    disposition: 'report_only',
  },
});

function fail(message) {
  console.error(JSON.stringify({
    precisionDiagnostic: 'FAIL',
    message,
  }, null, 2));
  process.exit(1);
}

function sameConflict(value) {
  return value
    && value.fixtureId === EXPECTED.conflict.fixtureId
    && value.field === EXPECTED.conflict.field
    && value.expected === EXPECTED.conflict.expected
    && value.actual === EXPECTED.conflict.actual
    && value.disposition === EXPECTED.conflict.disposition
    && Array.isArray(value.policy)
    && value.policy.length === EXPECTED.conflict.policy.length
    && value.policy.every((item, index) => item === EXPECTED.conflict.policy[index]);
}

const manifestPath = resolve(process.argv.includes('--manifest')
  ? process.argv[process.argv.indexOf('--manifest') + 1]
  : 'test/fixtures/precision-report-only-conflicts-v1.2.2.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('Precision report-only conflict manifest is unreadable.');
}
if (manifest.version !== 'precision-report-only-conflicts-v1.2.2'
  || !Array.isArray(manifest.conflicts)
  || manifest.conflicts.length !== 1
  || !sameConflict(manifest.conflicts[0])) {
  fail('Precision report-only conflict manifest must contain exactly the approved canonical conflict.');
}

const child = spawnSync(process.execPath, ['scripts/evaluate-precision-classification.mjs'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (child.error) fail('Strict precision evaluator could not be started.');
if (child.status !== 1) fail(`Strict precision evaluator must exit 1, received ${child.status}.`);
let report;
try {
  report = JSON.parse(child.stdout);
} catch {
  fail('Strict precision evaluator output is malformed.');
}
if (report.classifierVersion !== EXPECTED.classifierVersion
  || report.fixtures !== EXPECTED.fixtures
  || report.assertions !== EXPECTED.assertions
  || report.passed !== EXPECTED.passed
  || report.failed !== EXPECTED.failed
  || !Array.isArray(report.failures)
  || report.failures.length !== 1) {
  fail('Strict precision evaluator summary differs from the approved canonical diagnostic.');
}
const failure = report.failures[0];
if (failure.id !== EXPECTED.conflict.fixtureId
  || failure.field !== EXPECTED.conflict.field
  || failure.expected !== EXPECTED.conflict.expected
  || failure.actual !== EXPECTED.conflict.actual) {
  fail('Strict precision evaluator failure differs from the approved canonical conflict.');
}

console.log(JSON.stringify({
  precisionDiagnostic: 'PASS_WITH_REPORT_ONLY_CANONICAL_CONFLICT',
  strictExitCode: child.status,
  blocking: 0,
  reportOnly: 1,
  policy: EXPECTED.conflict.policy,
  classifierVersion: report.classifierVersion,
  fixtureSummary: {
    fixtures: report.fixtures,
    assertions: report.assertions,
    passed: report.passed,
    failed: report.failed,
  },
}, null, 2));
