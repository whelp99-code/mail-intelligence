#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { classifyMessage, PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';

const fixtureUrl = new URL('../test/fixtures/precision-evaluation.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, 'utf8'));
assert.ok(Array.isArray(fixtures) && fixtures.length >= 20, 'precision evaluation requires at least 20 fixtures');

const fieldTotals = new Map();
const fieldPasses = new Map();
const failures = [];

function record(field, passed) {
  fieldTotals.set(field, (fieldTotals.get(field) || 0) + 1);
  if (passed) fieldPasses.set(field, (fieldPasses.get(field) || 0) + 1);
}

for (const fixture of fixtures) {
  const context = {
    ...fixture.context,
    now: fixture.context?.now ? new Date(fixture.context.now) : new Date('2026-08-30T01:00:00.000Z'),
  };
  const actual = classifyMessage(fixture.message, context);
  for (const [field, expected] of Object.entries(fixture.expected || {})) {
    if (field === 'signalsIncludes') {
      const missing = expected.filter((signal) => !actual.signals.includes(signal));
      const passed = missing.length === 0;
      record(field, passed);
      if (!passed) failures.push({ id: fixture.id, field, expected, actual: actual.signals, missing });
      continue;
    }
    const passed = Object.is(actual[field], expected);
    record(field, passed);
    if (!passed) failures.push({ id: fixture.id, field, expected, actual: actual[field] });
  }
}

const fields = Object.fromEntries([...fieldTotals].map(([field, total]) => {
  const passed = fieldPasses.get(field) || 0;
  return [field, {
    passed,
    total,
    accuracy: Number((passed / total).toFixed(4)),
  }];
}));
const totalAssertions = [...fieldTotals.values()].reduce((sum, value) => sum + value, 0);
const passedAssertions = [...fieldPasses.values()].reduce((sum, value) => sum + value, 0);
const summary = {
  evaluation: 'precision-classification-fixture-v1',
  classifierVersion: PRECISION_CLASSIFICATION_VERSION,
  fixtures: fixtures.length,
  assertions: totalAssertions,
  passed: passedAssertions,
  failed: failures.length,
  accuracy: Number((passedAssertions / totalAssertions).toFixed(4)),
  fields,
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
