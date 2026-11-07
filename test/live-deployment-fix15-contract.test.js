import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('live deployment verifier fails closed if the fix15 search assertion is removed', async () => {
  const source = await readFile(new URL('../scripts/verify-live-deployment.mjs', import.meta.url), 'utf8');
  const assertions = source.match(/assert\.equal\(health\.body\.intelligentSearchVersion,\s*'intelligent-search-v1\.2\.2-fix15'\)/g) || [];
  assert.equal(assertions.length, 1);
  assert.equal(source.includes("intelligent-search-v1.2.2-fix14"), false);
  assert.equal(source.includes("intelligent-search-v1.2.2-fix16"), false);
});
