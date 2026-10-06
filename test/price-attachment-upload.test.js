import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { MailWorkIntakeService } from '../src/application/mail-work-intake.js';
import { AttachmentPipeline } from '../src/application/attachment-pipeline.js';
import { canonicalCompanyMemoryBytes } from '../src/application/company-memory-donor.js';
import { PriceAttachmentUploader, PRICE_ATTACHMENT_APPROVAL_DOMAIN } from '../src/adapters/price-attachment-upload.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mail-price-boundary-'));
  const store = new SQLiteMailStore({ databasePath: join(root, 'mail.sqlite') });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const mailboxUser = 'fixture@example.invalid';
  const mailbox = store.ensureMailbox({ key: mailboxUser });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  store.applyDeltaPage({
    mailboxId: mailbox.id, folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }), pageIndex: 0,
    items: [normalizeGraphMessage({
      id: 'm', changeKey: 'v1', subject: 'Fixture', receivedDateTime: '2026-09-01T00:00:00.000Z',
      attachments: [{ id: 'a', name: 'source.csv', contentType: 'text/csv', size: 3, lastModifiedDateTime: '2026-09-01T00:00:00.000Z' }],
    })], deltaLink: 'https://graph.microsoft.com/fixture',
  });
  const attachment = store.getAttachmentsForMessage(mailbox.id, 'm')[0];
  const pipeline = new AttachmentPipeline({ db: store.db });
  pipeline.quarantine({ attachmentId: attachment.databaseId, mailboxId: mailbox.id, bytes: Buffer.from('abc') });
  pipeline.recordScan({ attachmentId: attachment.databaseId, mailboxId: mailbox.id, state: 'clean', scanner: 'fixture', version: '1' });
  pipeline.authorizeExtraction({ attachmentId: attachment.databaseId, mailboxId: mailbox.id, parser: 'fixture', version: '1' });
  const key = generateKeyPairSync('ed25519');
  const calls = [];
  const uploader = new PriceAttachmentUploader({
    intake: new MailWorkIntakeService({ store }), companyId: 'company_fixture', origin: 'http://127.0.0.1',
    csrfToken: 'fixture-csrf', approvalKey: key.publicKey, now: () => Date.parse('2026-10-06T00:00:00.000Z'),
    readBytes: async () => Buffer.from('abc'),
    fetchImpl: async (...args) => { calls.push(args); throw new Error('Unexpected HTTP'); },
  });
  const input = { mailboxUser, messageId: 'm', attachmentId: 'a' };
  const grant = (overrides = {}) => {
    const claim = {
      ...uploader.proposal(mailboxUser, 'm', 'a'), approvedBy: 'fixture-human', nonce: 'fixture-nonce',
      expiresAt: '2026-10-07T00:00:00.000Z', ...overrides,
    };
    return { claim, signature: sign(null, Buffer.concat([PRICE_ATTACHMENT_APPROVAL_DOMAIN, canonicalCompanyMemoryBytes(claim)]),
      key.privateKey).toString('base64url') };
  };
  return { uploader, input, grant, calls, store, attachment };
}

test('scope, purpose, expiry and invalid signatures refuse before native transport', async (t) => {
  const { uploader, input, grant, calls } = await fixture(t);
  await assert.rejects(uploader.upload({ ...input, approval: grant({ companyId: 'foreign' }) }), { code: 'PRICE_APPROVAL_SCOPE_MISMATCH' });
  await assert.rejects(uploader.upload({ ...input, approval: grant({ purpose: 'mail.send' }) }), { code: 'PRICE_APPROVAL_SCOPE_MISMATCH' });
  await assert.rejects(uploader.upload({ ...input, approval: grant({ expiresAt: '2000-01-01T00:00:00.000Z' }) }), { code: 'PRICE_APPROVAL_EXPIRED' });
  await assert.rejects(uploader.upload({ ...input, approval: { ...grant(), signature: 'a'.repeat(86) } }), { code: 'PRICE_APPROVAL_SIGNATURE_INVALID' });
  assert.equal(calls.length, 0);
});

test('attachment change during byte read refuses before manifest creation', async (t) => {
  const { uploader, input, grant, calls, store, attachment } = await fixture(t);
  const approval = grant();
  uploader.readBytes = async () => {
    store.db.prepare('UPDATE attachments SET last_modified_at=? WHERE id=?').run('2026-09-02T00:00:00.000Z', attachment.databaseId);
    return Buffer.from('abc');
  };
  await assert.rejects(uploader.upload({ ...input, approval }), { code: 'PRICE_ATTACHMENT_STALE' });
  assert.equal(calls.length, 0);
});

test('byte digest drift refuses before manifest creation', async (t) => {
  const { uploader, input, grant, calls } = await fixture(t);
  uploader.readBytes = async () => Buffer.from('def');
  await assert.rejects(uploader.upload({ ...input, approval: grant() }), { code: 'PRICE_ATTACHMENT_BYTES_CHANGED' });
  assert.equal(calls.length, 0);
});
