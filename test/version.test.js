import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_NAME, APP_VERSION } from '../src/version.js';

test('runtime version matches package metadata', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(APP_NAME, 'mail-intelligence');
  assert.equal(APP_VERSION, packageJson.version);
});
