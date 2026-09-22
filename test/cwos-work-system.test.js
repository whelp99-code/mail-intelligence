import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';

test('CWOS adapter stores candidate links and keeps Notion read-only', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY); INSERT INTO messages VALUES(2);');
  db.exec(readFileSync(new URL('../migrations/012_mail_work_links.sql', import.meta.url), 'utf8'));
  const adapter = new CwosWorkSystemAdapter({ db, now: () => '2026-09-22T00:00:00Z' });
  const link = adapter.candidate({ mailboxId: 1, messageId: 2, graphId: 'graph-2', objectType: 'engagement', externalId: 'cwos-1', confidence: 0.8 });
  assert.equal(link.status, 'candidate');
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  await assert.rejects(adapter.write(), { code: 'CWOS_WRITE_DISABLED' });
});
