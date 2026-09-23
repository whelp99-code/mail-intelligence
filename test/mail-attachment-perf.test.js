import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAttachmentAssetService, createSyntheticPassScanner } from '../src/application/mail-attachment-assets.js';

const KEY = Buffer.alloc(32, 17);
const TWO_MIB = 2_097_152;

function service(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return createAttachmentAssetService({
    db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
}

test('twenty synthetic 2MiB uploads stay within the local p95 and concurrent RSS budgets', async (t) => {
  const assets = service(t);
  const durations = [];
  for (let index = 0; index < 20; index += 1) {
    const bytes = Buffer.alloc(TWO_MIB, index + 1);
    const started = process.hrtime.bigint();
    const uploaded = await assets.upload({
      mailboxId: 1,
      source: 'ui',
      requestId: randomUUID(),
      displayName: `perf-${index}.txt`,
      origin: 'local',
      contentLength: bytes.length,
      body: Readable.from(bytes),
    });
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.equal(uploaded.asset.size, TWO_MIB);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const beforeRss = process.memoryUsage().rss;
  await Promise.all([0, 1].map(async (index) => {
    const bytes = Buffer.alloc(TWO_MIB, 80 + index);
    await assets.upload({
      mailboxId: 1,
      source: 'ui',
      requestId: randomUUID(),
      displayName: `rss-${index}.txt`,
      origin: 'local',
      contentLength: bytes.length,
      body: Readable.from(bytes),
    });
  }));
  const rssDelta = process.memoryUsage().rss - beforeRss;
  assert.ok(p95 <= 5000, `p95 ${p95.toFixed(1)}ms exceeds 5s; env=${process.platform} ${process.version}`);
  assert.ok(rssDelta <= 64 * 1024 * 1024, `concurrent RSS grew ${rssDelta} bytes`);
});
