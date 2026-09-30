import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replyDraftsEnabled } from '../src/application/reply-draft-pipeline.js';
import { PersistentMailMemoryRuntime } from '../src/application/persistent-mail-memory.js';

function withEnv(value) {
  const previous = process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS;
  if (value == null) delete process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS;
  else process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS = value;
  return () => {
    if (previous == null) delete process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS;
    else process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS = previous;
  };
}

test('reply draft sync hook is off unless MAIL_INTELLIGENCE_REPLY_DRAFTS is 1', () => {
  const restore = withEnv(undefined);
  try {
    assert.equal(replyDraftsEnabled(), false);
    process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS = '0';
    assert.equal(replyDraftsEnabled(), false);
    process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS = 'true';
    assert.equal(replyDraftsEnabled(), false);
    process.env.MAIL_INTELLIGENCE_REPLY_DRAFTS = '1';
    assert.equal(replyDraftsEnabled(), true);
    assert.notEqual(process.env.MAIL_INTELLIGENCE_ALLOW_SEND, '1');
  } finally {
    restore();
  }
});

test('only the outlook sync POST passes the env hook; send routes do not', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const syncPost = server.slice(server.indexOf("url.pathname === '/api/outlook/sync'"));
  const nextRoute = syncPost.indexOf("url.pathname === '/api/mail/search'");
  const syncBlock = syncPost.slice(0, nextRoute);
  assert.match(syncBlock, /replyDrafts:\s*replyDraftsEnabled\(\)/);
  assert.doesNotMatch(server, /\/api\/mail\/send[\s\S]{0,400}replyDraftsEnabled/);
  assert.equal(server.split('replyDraftsEnabled()').length - 1, 1);
});

async function withRuntime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-reply-flag-'));
  const runtime = new PersistentMailMemoryRuntime({
    databasePath: join(directory, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
    backupDirectory: join(directory, 'backups'),
    attachmentMetadataLimit: 0,
  });
  await runtime.initialize();
  t.after(async () => {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  runtime.syncService = {
    async syncMailbox() {
      return {
        mailbox: runtime.ensureMailbox(''),
        discoveredFolders: 1,
        completedFolders: 1,
        failedFolders: 0,
        folderResults: [],
        errors: [],
        pages: 0,
        received: 0,
        upserts: 0,
        deletions: 0,
        attachmentErrors: 0,
        messages: [],
      };
    },
  };
  return runtime;
}

test('sync hook off leaves the pipeline uncalled and creates no sendable draft', async (t) => {
  const runtime = await withRuntime(t);
  const off = await runtime.syncMailbox({ accessToken: 'token', replyDrafts: replyDraftsEnabled({}) });
  assert.equal(off.replyDraftPipeline, null);
  const sent = runtime.store.db.prepare(
    "SELECT COUNT(*) AS n FROM mail_send_drafts WHERE status IN ('approved', 'sending', 'sent')",
  ).get();
  assert.equal(sent.n, 0);
});

test('sync hook on runs the pipeline without a send path', async (t) => {
  const runtime = await withRuntime(t);
  const on = await runtime.syncMailbox({ accessToken: 'token', replyDrafts: replyDraftsEnabled({ MAIL_INTELLIGENCE_REPLY_DRAFTS: '1' }) });
  assert.equal(on.replyDraftPipeline.dryRun, false);
  assert.equal(on.replyDraftPipeline.drafted, 0);
  const sent = runtime.store.db.prepare(
    "SELECT COUNT(*) AS n FROM mail_send_drafts WHERE status IN ('approved', 'sending', 'sent')",
  ).get();
  assert.equal(sent.n, 0);
});
