import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { planAttachmentRetention } from '../src/application/attachment-retention.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return db;
}

function insertAsset(db, { id, state = 'ready', expiresAt = '2026-01-01T00:00:00.000Z' }) {
  db.prepare(`
    INSERT INTO mail_attachment_assets(
      id,mailbox_id,source,request_id,display_name,mime_type,byte_length,sha256,
      ciphertext,nonce,auth_tag,key_version,encryption_aad_version,encryption_policy_version,
      scan_policy_version,state,origin,created_at,expires_at
    ) VALUES (?,?, 'ui', ?, 'note.txt','text/plain',4,'abcd', x'00', x'00', x'00','k1','aad-v1','policy-v1','scan-policy-v1',?,'local',?,?)
  `).run(id, 1, id, state, '2026-01-01T00:00:00.000Z', expiresAt);
}

test('dry-run lists expired unlinked assets and apply clears ciphertext only', (t) => {
  const db = fixture(t);
  insertAsset(db, { id: '11111111-1111-4111-8111-111111111111' });
  const dry = planAttachmentRetention(db, { now: '2026-09-10T00:00:00.000Z', apply: false });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.count, 1);
  assert.equal(db.prepare('SELECT state FROM mail_attachment_assets').get().state, 'ready');
  planAttachmentRetention(db, { now: '2026-09-10T00:00:00.000Z', apply: true });
  const row = db.prepare('SELECT state, ciphertext FROM mail_attachment_assets').get();
  assert.equal(row.state, 'expired');
  assert.equal(row.ciphertext, null);
});

test('approved and sending drafts are never retention candidates', (t) => {
  const db = fixture(t);
  const drafts = new MailSendDrafts(db, { now: () => '2026-01-01T00:00:00.000Z' });
  insertAsset(db, { id: '11111111-1111-4111-8111-111111111111' });
  const created = drafts.create(1, 'ui', {
    request_id: 'retain-001',
    to: ['a@example.com'],
    subject: 'Keep',
    body_text: 'Keep',
    attachment_ids: ['11111111-1111-4111-8111-111111111111'],
  }).draft;
  drafts.approve(1, created.draft_id, {
    actor: 'session:owner',
    digest: created.payload_digest,
    allowSend: true,
    hasSendScope: true,
  });
  const plan = planAttachmentRetention(db, { now: '2026-09-10T00:00:00.000Z' });
  assert.equal(plan.count, 0);
  drafts.claim(1, created.draft_id);
  assert.equal(planAttachmentRetention(db, { now: '2026-09-10T00:00:00.000Z' }).count, 0);
});
