import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyJarvisMailReader } from '../scripts/verify-jarvis-mail-reader.mjs';

test('reader fixture tolerates parallel ephemeral port binding', { timeout: 120_000 }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => verifyJarvisMailReader()));
  for (const result of results) {
    assert.equal(result.result, 'PASS');
    assert.equal(result.cleanup, 'PASS');
  }
});
