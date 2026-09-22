import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { AttachmentPipeline } from '../src/application/attachment-pipeline.js';

test('attachment remains quarantined until clean scan and authorized extraction', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE attachments(id INTEGER PRIMARY KEY); INSERT INTO attachments VALUES(2);');
  db.exec(readFileSync(new URL('../migrations/011_mail_attachment_processing.sql', import.meta.url), 'utf8'));
  const pipeline = new AttachmentPipeline({ db, now: () => '2026-09-22T00:00:00Z' });
  pipeline.quarantine({ attachmentId: 2, mailboxId: 1, bytes: Buffer.from('fixture') });
  assert.equal(pipeline.canExpose(2, 1), false);
  pipeline.recordScan({ attachmentId: 2, mailboxId: 1, state: 'unavailable', scanner: 'clamav' });
  assert.equal(pipeline.canExpose(2, 1), false);
  pipeline.recordScan({ attachmentId: 2, mailboxId: 1, state: 'clean', scanner: 'clamav', version: 'fixture' });
  pipeline.authorizeExtraction({ attachmentId: 2, mailboxId: 1, parser: 'native', version: '1' });
  assert.equal(pipeline.canExpose(2, 1), true);
});
