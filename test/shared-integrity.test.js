import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SHARED_INTEGRITY_MAX_AGE_MS,
  createReadonlyIntegrityCheck,
  createSharedIntegrity,
  jarvisReaderStatus,
} from '../src/storage/shared-integrity.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('status reads share one check and do not wait on the request', async () => {
  const pending = deferred();
  let now = 1_000;
  const integrity = createSharedIntegrity({
    check: () => pending.promise,
    now: () => now,
    maxAgeMs: SHARED_INTEGRITY_MAX_AGE_MS,
  });
  const counts = () => ({ messages: 4, threads: 2 });
  const first = jarvisReaderStatus(integrity, counts);
  const second = jarvisReaderStatus(integrity, counts);
  assert.equal(integrity.started(), 1);
  assert.deepEqual(first, { ready: false, counts: { messages: 4, threads: 2 } });
  assert.deepEqual(second, first);
  pending.resolve({ ok: true });
  await integrity.settled();
  assert.equal(jarvisReaderStatus(integrity, counts).ready, true);
  assert.equal(integrity.started(), 1);
  now += SHARED_INTEGRITY_MAX_AGE_MS;
  const expired = jarvisReaderStatus(integrity, counts);
  assert.equal(expired.ready, false);
  assert.equal(integrity.started(), 2);
  await integrity.settled();
  assert.equal(jarvisReaderStatus(integrity, counts).ready, true);
  assert.equal(integrity.started(), 2);
});

test('a failed shared check stays refused without a second scan', async () => {
  const pending = deferred();
  const integrity = createSharedIntegrity({ check: () => pending.promise, now: () => 5, maxAgeMs: 30_000 });
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 9, threads: 1 })).ready, false);
  pending.resolve({ ok: false });
  await pending.promise;
  await Promise.resolve();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 9, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 1);
});

test('a check rejection is refused and a readonly worker reports a real database', async () => {
  const integrity = createSharedIntegrity({
    check: () => Promise.reject(new Error('worker down')),
    now: () => 5,
    maxAgeMs: 30_000,
  });
  integrity.read();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);

  const root = mkdtempSync(join(tmpdir(), 'mail-integrity-'));
  const databasePath = join(root, 'fixture.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY); INSERT INTO messages (id) VALUES (1);');
  db.close();
  const check = createReadonlyIntegrityCheck(databasePath);
  try {
    const checked = await check();
    assert.deepEqual(checked, { ok: true });
  } finally {
    await check.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('an unfinished recheck is expired but not rejected before its deadline', async () => {
  const first = deferred();
  const second = deferred();
  const checks = [first, second];
  let now = 1_000;
  const integrity = createSharedIntegrity({
    check: () => checks.shift().promise,
    now: () => now,
    maxAgeMs: SHARED_INTEGRITY_MAX_AGE_MS,
  });
  integrity.read();
  first.resolve({ ok: true });
  await integrity.settled();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, true);
  now += SHARED_INTEGRITY_MAX_AGE_MS;
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
  now += SHARED_INTEGRITY_MAX_AGE_MS - 1;
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
  second.resolve({ ok: true });
  await integrity.settled();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, true);
  assert.equal(integrity.started(), 2);
});

test('a recheck that misses its deadline stays refused after a late success', async () => {
  const first = deferred();
  const second = deferred();
  const checks = [first, second];
  let now = 1_000;
  const integrity = createSharedIntegrity({
    check: () => checks.shift().promise,
    now: () => now,
    maxAgeMs: SHARED_INTEGRITY_MAX_AGE_MS,
  });
  integrity.read();
  first.resolve({ ok: true });
  await integrity.settled();
  now += SHARED_INTEGRITY_MAX_AGE_MS;
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  now += SHARED_INTEGRITY_MAX_AGE_MS;
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
  second.resolve({ ok: true });
  await integrity.settled();
  await Promise.resolve();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
});

test('a late success without an intervening status read is refused', async () => {
  const first = deferred();
  const second = deferred();
  const checks = [first, second];
  let now = 1_000;
  const integrity = createSharedIntegrity({
    check: () => checks.shift().promise,
    now: () => now,
    maxAgeMs: SHARED_INTEGRITY_MAX_AGE_MS,
  });
  integrity.read();
  first.resolve({ ok: true });
  await integrity.settled();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, true);
  now = 1_000 + SHARED_INTEGRITY_MAX_AGE_MS;
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
  now = 1_000 + (SHARED_INTEGRITY_MAX_AGE_MS * 2) + 1;
  second.resolve({ ok: true });
  await integrity.settled();
  await Promise.resolve();
  assert.equal(jarvisReaderStatus(integrity, () => ({ messages: 1, threads: 1 })).ready, false);
  assert.equal(integrity.started(), 2);
});
