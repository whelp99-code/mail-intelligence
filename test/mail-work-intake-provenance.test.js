import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';
import { MailWorkIntakeService } from '../src/application/mail-work-intake.js';
import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-m2-provenance-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = new SQLiteMailStore({
    databasePath,
    now: () => '2026-10-06T00:00:00.000Z',
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'me' });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  const raw = {
    id: 'synthetic-mail',
    conversationId: 'synthetic-thread',
    internetMessageId: '<synthetic@example.invalid>',
    changeKey: 'source-v1',
    subject: 'Example Project quote request',
    from: { emailAddress: { address: 'requester@example.invalid' } },
    receivedDateTime: '2026-09-01T03:00:00.000Z',
    body: { contentType: 'text', content: 'Please send a quote for Example Project.' },
    webLink: 'https://outlook.office.com/mail/synthetic-mail',
    hasAttachments: true,
    attachments: [{
      id: 'attachment-1', name: 'requirements.pdf', contentType: 'application/pdf',
      size: 42, lastModifiedDateTime: '2026-09-01T02:00:00.000Z',
    }],
  };
  const collect = (overrides = {}) => store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }),
    pageIndex: 0,
    items: [normalizeGraphMessage({ ...raw, ...overrides })],
    deltaLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?fixture=1',
  });
  collect();
  const adapter = new CwosWorkSystemAdapter({
    db: store.db,
    cwosClient: {
      async readMasters({ workspaceId }) {
        return {
          workspaceId,
          items: [{ objectType: 'engagement', externalId: 'project-a', name: 'Example Project' }],
        };
      },
    },
  });
  const intake = new MailWorkIntakeService({ store, workSystem: adapter });
  const ingest = () => intake.ingest('me', 'synthetic-mail', { workspaceId: 'synthetic-workspace' });
  return { store, mailbox, adapter, intake, ingest, collect, databasePath };
}

test('intake persists current and prior source revisions with attachment metadata across replay and reopen', async (t) => {
  const { store, ingest, collect, databasePath } = await fixture(t);
  const first = await ingest();
  const original = first.project.candidates[0].evidence.find((item) => item.kind === 'mail_source');
  assert.ok(original);
  assert.equal(original.messageId, 'synthetic-mail');
  assert.equal(original.threadId, 'synthetic-thread');
  assert.equal(original.internetMessageId, '<synthetic@example.invalid>');
  assert.equal(original.receivedAt, '2026-09-01T03:00:00.000Z');
  assert.equal(original.revision, 'source-v1');
  assert.equal(original.attachments[0].attachmentId, 'attachment-1');
  assert.equal(original.attachments[0].revision, '2026-09-01T02:00:00.000Z');
  collect({
    changeKey: 'source-v2',
    attachments: [{
      id: 'attachment-2', name: 'revised.pdf', contentType: 'application/pdf',
      size: 43, lastModifiedDateTime: '2026-09-02T02:00:00.000Z',
    }],
  });
  const revised = await ingest();
  const replay = await ingest();
  assert.equal(revised.project.candidates[0].id, first.project.candidates[0].id);
  assert.deepEqual(replay.project.candidates[0].evidence, revised.project.candidates[0].evidence);
  const revisions = replay.project.candidates[0].evidence.filter((item) => item.kind === 'mail_source_revision');
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 'source-v1');
  assert.deepEqual(revisions[0].attachments, original.attachments);
  assert.equal(replay.project.candidates[0].evidence.find((item) => item.kind === 'mail_source').revision, 'source-v2');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  const reopened = new SQLiteMailStore({ databasePath });
  try {
    const reread = new MailWorkIntakeService({ store: reopened }).get('me', 'synthetic-mail');
    assert.deepEqual(reread.project.candidates[0].evidence, replay.project.candidates[0].evidence);
  } finally {
    reopened.close();
  }
});

test('attachment-only change during master read refuses before persisting candidates', async (t) => {
  const { store, mailbox, adapter, ingest } = await fixture(t);
  const read = adapter.cwosClient.readMasters;
  adapter.cwosClient.readMasters = async (scope) => {
    const message = store.getMessageRecord(mailbox.id, 'synthetic-mail');
    store.replaceAttachments(message.id, [{
      graphId: 'attachment-changed', name: 'changed.pdf', size: 80,
      modifiedAt: '2026-09-02T02:00:00.000Z',
    }]);
    return read(scope);
  };
  await assert.rejects(ingest(), { code: 'INTAKE_SOURCE_CHANGED' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM precision_classifications').get().n, 0);
});

test('source revision refresh preserves corrected work links and explicit project clearing', async (t) => {
  const { store, ingest, collect } = await fixture(t);
  const initial = await ingest();
  const link = initial.project.candidates[0];
  store.db.prepare('UPDATE mail_work_links SET status=\'confirmed\',corrected_by=\'session:synthetic\',name=\'Owner correction\',confidence=1 WHERE id=?')
    .run(link.id);
  const corrected = store.db.prepare('SELECT * FROM mail_work_links WHERE id=?').get(link.id);
  new PrecisionIntelligenceService({ store }).correct('me', 'synthetic-mail', {
    workState: 'reference', nextActor: 'none', clearProject: true, note: 'Explicit synthetic correction',
  });
  collect({ changeKey: 'source-v2' });
  const replay = await ingest();
  assert.deepEqual(store.db.prepare('SELECT * FROM mail_work_links WHERE id=?').get(link.id), corrected);
  assert.equal(replay.project.status, 'unassigned');
  assert.equal(replay.project.source, 'user-correction');
  assert.equal(replay.work.classification.workState, 'reference');
});
