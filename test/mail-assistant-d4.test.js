import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { MailAssistantService } from '../src/application/mail-assistant.js';
import { prepareReplyDraft } from '../src/application/reply-draft-pipeline.js';

test('UI generation uses the actual normalized recipient and stored owner Sent Items', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'd4-assistant-'));
  const store = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), migrationsDir: resolve('migrations') });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = 'owner@example.test';
  const mailbox = store.ensureMailbox({ key: 'me', address: owner });
  for (const [folderName, sender, id, body, conversation] of [
    ['inbox', 'buyer@nexias.co.kr', 'incoming', '자료를 회신 부탁드립니다.', 'new-work'],
    ['sentitems', owner, 'owner-sent', '안녕하십니까.\n자료 보내드립니다.\n고맙습니다.', 'prior-work'],
  ]) {
    const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: folderName, displayName: folderName, wellKnownName: folderName });
    const run = store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'initial' });
    store.applyDeltaPage({
      mailboxId: mailbox.id, folderId: folder.id, syncRunId: run, pageIndex: 0,
      requestUrl: 'https://graph.example.test/messages/delta',
      items: [normalizeGraphMessage({
        id, subject: '자료 회신 요청', parentFolderId: folderName, conversationId: conversation,
        from: { emailAddress: { address: sender, name: 'Synthetic Person' } },
        toRecipients: [{ emailAddress: { address: sender === owner ? 'buyer@example.test' : owner } }],
        receivedDateTime: '2026-10-01T01:00:00Z', sentDateTime: '2026-10-01T01:00:00Z',
        body: { contentType: 'text', content: body },
      })],
      deltaLink: 'https://graph.example.test/delta',
    });
  }
  const assistant = new MailAssistantService({ store, precision: new PrecisionIntelligenceService({ store }) });
  const draft = assistant.draft('', 'incoming', { mode: 'rapid_reply' });
  assert.match(draft.body, /양해광 상무님/);
  assert.match(draft.body, /안녕하십니까/);
  assert.match(draft.body, /고맙습니다/);
  assert.ok(draft.voiceEvidence.length > 0);
  assert.equal(draft.sendAllowed, false);
});

test('guardrail-created confirmation slots block drafts even when the generator reports no missing slots', () => {
  const draft = prepareReplyDraft({ body: '수량 확인 부탁드립니다.' }, {
    body: '수량은 123개입니다.', to: 'buyer@example.test', unfilled: [], sendAllowed: false,
  }, { recipients: ['buyer@example.test'], sentRows: [] });
  assert.match(draft.body, /\{확인 필요\}/);
  assert.equal(draft.needsClarification, true);
});
