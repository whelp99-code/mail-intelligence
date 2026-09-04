import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_NAME, APP_VERSION, BLIND_ACCEPTANCE_RUBRIC_VERSION, CLASSIFICATION_POLICY_VERSION } from '../src/version.js';

test('runtime version matches package metadata', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(APP_NAME, 'mail-intelligence');
  assert.equal(APP_VERSION, packageJson.version);
});


test('classification policy and blind rubric versions are fixed', () => {
  assert.equal(CLASSIFICATION_POLICY_VERSION, 'classification-policy-v1.2.2-o01-o06');
  assert.equal(BLIND_ACCEPTANCE_RUBRIC_VERSION, 'blind-acceptance-rubric-v2');
});
