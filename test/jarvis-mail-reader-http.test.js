import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyJarvisMailReader } from '../scripts/verify-jarvis-mail-reader.mjs';

test('dedicated reader admits only summary GET without writes or session authority', { timeout: 40000 }, async () => {
  const result = await verifyJarvisMailReader();
  assert.equal(result.result, 'PASS');
  assert.equal(result.cleanup, 'PASS');
  assert.ok(result.checks > 80);
});
