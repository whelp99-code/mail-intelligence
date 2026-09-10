import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SendDraftError, SendDraftService } from '../src/application/send-drafts.js';
import { buildGraphSendPayload } from '../src/adapters/microsoft-graph-send.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-send-draft-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test('send drafts stay needs_approval until a successful approved Graph receipt', async (t) => {
  const store = await withStore(t);
  const receipts = [];
  const service = new SendDraftService({
    store,
    submitApprovedMail: async ({ draft }) => {
      receipts.push(draft);
      return {
        adapter: 'microsoft-graph',
        httpStatus: 202,
        requestId: 'req-1',
        submittedAt: '2026-09-10T00:00:00.000Z',
        saveToSentItems: true,
        mailboxPath: '/me',
      };
    },
  });

  const created = service.create({
    to: 'person@example.com',
    subject: '견적 회신 초안',
    body: '사람 승인 후 발송합니다.',
    notes: '윤비서',
  }, { source: 'grok-bot' });
  assert.equal(created.status, 'needs_approval');
  assert.equal(created.source, 'grok-bot');
  assert.equal(created.approvalRequired, true);
  assert.equal(service.get(created.id).status, 'needs_approval');

  const sent = await service.approve(created.id, { accessToken: 'token', approvalId: 'human-1' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.adapter, 'microsoft-graph');
  assert.equal(sent.receipt.httpStatus, 202);
  assert.equal(receipts.length, 1);
});

test('invalid recipients are rejected and Graph failures keep a failed draft', async (t) => {
  const store = await withStore(t);
  const service = new SendDraftService({
    store,
    submitApprovedMail: async () => {
      const error = new Error('Graph rejected the approved send.');
      error.code = 'GRAPH_SEND_FAILED';
      error.statusCode = 502;
      throw error;
    },
  });
  assert.throws(
    () => service.create({ to: 'not-an-email', subject: 'x', body: 'y' }),
    (error) => error instanceof SendDraftError && error.code === 'DRAFT_RECIPIENT_INVALID',
  );
  const created = service.create({
    to: ['ok@example.com'],
    subject: '실패 초안',
    body: '본문',
  });
  await assert.rejects(
    () => service.approve(created.id, { accessToken: 'token' }),
    (error) => error instanceof SendDraftError && error.code === 'GRAPH_SEND_FAILED' && error.draft.status === 'failed',
  );
});

test('Graph payload maps recipients and resolved attachments', () => {
  const payload = buildGraphSendPayload({
    to: ['a@example.com'],
    cc: ['b@example.com'],
    subject: 'Hello',
    body: 'Body',
    resolvedAttachments: [{
      name: 'quote.pdf',
      contentType: 'application/pdf',
      contentBytes: 'cXVvdGU=',
    }],
  });
  assert.equal(payload.message.toRecipients[0].emailAddress.address, 'a@example.com');
  assert.equal(payload.message.attachments[0].name, 'quote.pdf');
  assert.equal(payload.saveToSentItems, true);
});
