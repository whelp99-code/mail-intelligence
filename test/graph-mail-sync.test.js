import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MailSyncService } from '../src/application/mail-sync.js';
import { GraphMailClient, GraphMailError } from '../src/adapters/microsoft-graph-mail.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function message(id, overrides = {}) {
  return {
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    subject: `프로젝트 메일 ${id}`,
    from: { emailAddress: { address: `${id}@example.com`, name: id } },
    receivedDateTime: `2026-08-28T0${id.endsWith('2') ? '2' : '1'}:00:00.000Z`,
    isRead: false,
    hasAttachments: false,
    bodyPreview: `${id} 본문`,
    body: { contentType: 'text', content: `${id} 본문` },
    parentFolderId: 'inbox',
    ...overrides,
  };
}

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-sync-test-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test('Graph client follows nextLink then deltaLink without rebuilding continuation URLs', async () => {
  const calls = [];
  const pages = new Map([
    ['https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?%24select=' + encodeURIComponent('id'), null],
  ]);
  let requestCount = 0;
  const client = new GraphMailClient({
    accessToken: 'token',
    pageSize: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      requestCount += 1;
      if (requestCount === 1) {
        return response(200, {
          value: [message('m1')],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next?opaque=one',
        });
      }
      return response(200, {
        value: [message('m2')],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?opaque=final',
      });
    },
  });

  const received = [];
  for await (const page of client.iterateDelta({ folderId: 'inbox' })) received.push(page);
  assert.equal(received.length, 2);
  assert.equal(received[0].nextLink, 'https://graph.microsoft.com/v1.0/next?opaque=one');
  assert.equal(received[1].deltaLink, 'https://graph.microsoft.com/v1.0/delta?opaque=final');
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/next?opaque=one');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.match(calls[0].options.headers.Prefer, /body-content-type="text"/);
  assert.equal(pages.size, 1);
});

test('Graph client discovers paged root folders and nested child folders', async () => {
  const calls = [];
  const client = new GraphMailClient({
    accessToken: 'token',
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/childFolders')) {
        return response(200, { value: [{ id: 'child-1', displayName: '고객 프로젝트', parentFolderId: 'root-1' }] });
      }
      if (url.includes('page=2')) {
        return response(200, { value: [{ id: 'root-2', displayName: 'Sent Items' }] });
      }
      return response(200, {
        value: [{ id: 'root-1', displayName: 'Inbox', childFolderCount: 1 }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders?page=2',
      });
    },
  });
  const folders = await client.listMailFolders();
  assert.deepEqual(folders.map((folder) => folder.id), ['root-1', 'root-2', 'child-1']);
  assert.equal(folders.find((folder) => folder.id === 'child-1').parentFolderId, 'root-1');
  assert.equal(calls.some((url) => url.includes('/childFolders')), true);
});

test('Graph client rejects continuation links outside the configured Graph origin', async () => {
  const client = new GraphMailClient({
    accessToken: 'token',
    fetchImpl: async () => response(200, {
      value: [],
      '@odata.nextLink': 'https://attacker.invalid/steal?token=secret',
    }),
  });
  await assert.rejects(
    async () => {
      for await (const page of client.iterateDelta()) void page;
    },
    (error) => error.code === 'GRAPH_CONTINUATION_REJECTED',
  );
});

test('Graph error is safe, typed and does not expose remote response content', async () => {
  const client = new GraphMailClient({
    accessToken: 'token',
    fetchImpl: async () => response(503, { error: { message: 'sensitive remote body' } }),
  });
  await assert.rejects(
    client.requestJson('https://graph.microsoft.com/v1.0/me/messages'),
    (error) => {
      assert.equal(error.code, 'GRAPH_TRANSIENT_ERROR');
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes('sensitive remote body'), false);
      return true;
    },
  );
});

test('Graph 410 is mapped to DELTA_CURSOR_EXPIRED', async () => {
  const client = new GraphMailClient({
    accessToken: 'token',
    fetchImpl: async () => response(410, {}),
  });
  await assert.rejects(
    client.requestJson('https://graph.microsoft.com/v1.0/delta?expired=1'),
    (error) => error.code === 'DELTA_CURSOR_EXPIRED' && error.statusCode === 410,
  );
});

test('attachment metadata query selects metadata and never requests contentBytes', async () => {
  const calls = [];
  const client = new GraphMailClient({
    accessToken: 'token',
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, {
        value: [{ id: 'a1', name: '견적서.pdf', size: 100 }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/unused-delta',
      });
    },
  });
  const attachments = await client.fetchAttachmentMetadata({ messageId: 'm1' });
  assert.equal(attachments[0].name, '견적서.pdf');
  assert.match(calls[0], /attachments/);
  assert.equal(decodeURIComponent(calls[0]).includes('contentBytes'), false);
});

test('sync service commits each page and resumes from persisted nextLink after interruption', async (t) => {
  const store = await withStore(t);
  let phase = 1;
  const seenStartUrls = [];
  const service = new MailSyncService({
    store,
    graphClientFactory: () => ({
      async *iterateDelta({ startUrl }) {
        seenStartUrls.push(startUrl);
        if (phase === 1) {
          yield {
            pageIndex: 0,
            requestUrl: 'https://graph.microsoft.com/v1.0/initial',
            items: [message('m1')],
            nextLink: 'https://graph.microsoft.com/v1.0/resume-token',
            deltaLink: '',
          };
          throw new GraphMailError('temporary outage', { code: 'GRAPH_NETWORK_ERROR', retryable: true });
        }
        assert.equal(startUrl, 'https://graph.microsoft.com/v1.0/resume-token');
        yield {
          pageIndex: 0,
          requestUrl: startUrl,
          items: [message('m2')],
          nextLink: '',
          deltaLink: 'https://graph.microsoft.com/v1.0/delta-token',
        };
      },
      async fetchAttachmentMetadata() { return []; },
    }),
  });

  await assert.rejects(
    service.syncFolder({ accessToken: 'token' }),
    (error) => error.code === 'GRAPH_NETWORK_ERROR',
  );
  const mailbox = store.getMailbox('me');
  assert.equal(store.getRecentMessages(mailbox.id).length, 1);
  let status = store.getSyncStatus(mailbox.id);
  assert.equal(status.folders[0].has_resume_cursor, 1);
  assert.equal(status.folders[0].sync_state, 'interrupted');

  phase = 2;
  const result = await service.syncFolder({ accessToken: 'token' });
  assert.equal(result.runType, 'resume');
  assert.equal(store.getRecentMessages(mailbox.id).length, 2);
  status = store.getSyncStatus(mailbox.id);
  assert.equal(status.folders[0].has_resume_cursor, 0);
  assert.equal(status.folders[0].has_delta_cursor, 1);
  assert.deepEqual(seenStartUrls, ['', 'https://graph.microsoft.com/v1.0/resume-token']);
});

test('expired delta cursor is cleared and followed by a fresh cursor-reset sync', async (t) => {
  const store = await withStore(t);
  let call = 0;
  const client = {
    async *iterateDelta({ startUrl }) {
      call += 1;
      if (call === 1) {
        yield {
          pageIndex: 0,
          requestUrl: 'https://graph.microsoft.com/v1.0/initial',
          items: [message('m1')],
          nextLink: '',
          deltaLink: 'https://graph.microsoft.com/v1.0/delta-old',
        };
        return;
      }
      if (call === 2) {
        assert.equal(startUrl, 'https://graph.microsoft.com/v1.0/delta-old');
        throw new GraphMailError('expired', { code: 'DELTA_CURSOR_EXPIRED', statusCode: 410 });
      }
      assert.equal(startUrl, '');
      yield {
        pageIndex: 0,
        requestUrl: 'https://graph.microsoft.com/v1.0/fresh',
        items: [message('m1', { changeKey: 'change-new', isRead: true })],
        nextLink: '',
        deltaLink: 'https://graph.microsoft.com/v1.0/delta-new',
      };
    },
    async fetchAttachmentMetadata() { return []; },
  };
  const service = new MailSyncService({ store, graphClientFactory: () => client });

  await service.syncFolder({ accessToken: 'token' });
  const reset = await service.syncFolder({ accessToken: 'token' });
  assert.equal(reset.cursorReset, true);
  assert.equal(reset.runType, 'cursor-reset');
  assert.equal(reset.messages[0].isRead, true);
  const mailbox = store.getMailbox('me');
  const status = store.getSyncStatus(mailbox.id);
  assert.equal(status.folders[0].has_delta_cursor, 1);
  assert.equal(status.latestRuns.some((run) => run.error_code === 'DELTA_CURSOR_EXPIRED'), true);
});

test('syncMailbox synchronizes every discovered folder and preserves partial failures', async (t) => {
  const store = await withStore(t);
  const clients = [];
  const service = new MailSyncService({
    store,
    graphClientFactory: () => {
      const client = {
        async listMailFolders() {
          return [
            { id: 'folder-inbox', displayName: 'Inbox', parentFolderId: '' },
            { id: 'folder-project', displayName: '고객 프로젝트', parentFolderId: 'folder-inbox' },
            { id: 'folder-broken', displayName: '손상 폴더', parentFolderId: '' },
          ];
        },
        async *iterateDelta({ folderId }) {
          if (folderId === 'folder-broken') {
            throw new GraphMailError('forbidden folder', { code: 'GRAPH_REQUEST_FAILED', statusCode: 403 });
          }
          yield {
            pageIndex: 0,
            requestUrl: `https://graph.microsoft.com/v1.0/${folderId}`,
            items: [message(`mail-${folderId}`, { parentFolderId: folderId })],
            nextLink: '',
            deltaLink: `https://graph.microsoft.com/v1.0/delta-${folderId}`,
          };
        },
        async fetchAttachmentMetadata() { return []; },
      };
      clients.push(client);
      return client;
    },
  });
  const result = await service.syncMailbox({ accessToken: 'token', recentLimit: 20 });
  assert.equal(result.discoveredFolders, 3);
  assert.equal(result.completedFolders, 2);
  assert.equal(result.failedFolders, 1);
  assert.equal(result.messages.length, 2);
  assert.equal(result.errors[0].code, 'GRAPH_REQUEST_FAILED');
  const mailbox = store.getMailbox('me');
  const status = store.getSyncStatus(mailbox.id);
  assert.equal(status.folders.length, 3);
  assert.equal(status.folders.some((folder) => folder.sync_state === 'failed'), true);
  assert.ok(clients.length >= 4);
});

test('delta removal is persisted and attachment metadata failure does not abort mail sync', async (t) => {
  const store = await withStore(t);
  let syncNumber = 0;
  const client = {
    async *iterateDelta() {
      syncNumber += 1;
      if (syncNumber === 1) {
        yield {
          pageIndex: 0,
          requestUrl: 'https://graph.microsoft.com/v1.0/initial',
          items: [message('m1', { hasAttachments: true })],
          nextLink: '',
          deltaLink: 'https://graph.microsoft.com/v1.0/delta-1',
        };
      } else {
        yield {
          pageIndex: 0,
          requestUrl: 'https://graph.microsoft.com/v1.0/delta-1',
          items: [{ id: 'm1', '@removed': { reason: 'deleted' } }],
          nextLink: '',
          deltaLink: 'https://graph.microsoft.com/v1.0/delta-2',
        };
      }
    },
    async fetchAttachmentMetadata() {
      throw new GraphMailError('metadata unavailable', { code: 'GRAPH_TRANSIENT_ERROR', retryable: true });
    },
  };
  const service = new MailSyncService({ store, graphClientFactory: () => client, attachmentMetadataLimit: 2 });
  const first = await service.syncFolder({ accessToken: 'token' });
  assert.equal(first.attachmentErrors, 1);
  const second = await service.syncFolder({ accessToken: 'token' });
  assert.equal(second.deletions, 1);
  const mailbox = store.getMailbox('me');
  assert.equal(store.getRecentMessages(mailbox.id).length, 0);
  assert.equal(store.getRecentMessages(mailbox.id, { includeDeleted: true }).length, 1);
});
