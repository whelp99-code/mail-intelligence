import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PersistentMailMemoryRuntime } from '../src/application/persistent-mail-memory.js';

async function withRuntime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-jobs-'));
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
  return runtime;
}

test('operator job lifecycle and dead letter records remain queryable', async (t) => {
  const runtime = await withRuntime(t);
  const job = runtime.store.createOperatorJob({
    jobKey: 'job-1',
    jobType: 'integrity-check',
    input: { source: 'test' },
    maxAttempts: 2,
  });
  assert.equal(job.status, 'queued');
  runtime.store.markOperatorJobRunning('job-1', 1);
  runtime.store.failOperatorJob('job-1', Object.assign(new Error('verification failed'), {
    code: 'VERIFY_FAILED',
  }), { deadLetter: true });
  const failed = runtime.store.getOperatorJob('job-1');
  assert.equal(failed.status, 'dead-letter');
  assert.equal(failed.attemptCount, 1);
  assert.equal(failed.errorCode, 'VERIFY_FAILED');

  runtime.store.recordDeadLetter({
    jobId: failed.id,
    eventType: 'integrity-check.failed',
    entityType: 'database',
    entityId: 'mail-intelligence.sqlite',
    errorCode: failed.errorCode,
    errorMessage: failed.errorMessage,
    payload: { source: 'test' },
  });
  const deadLetters = runtime.store.listDeadLetters();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].jobId, failed.id);
  assert.equal(deadLetters[0].payload.source, 'test');
});

test('runtime retries a retryable mailbox failure and stores a completed job', async (t) => {
  const runtime = await withRuntime(t);
  let attempts = 0;
  runtime.syncService = {
    async syncMailbox() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary discovery failure');
        error.code = 'GRAPH_TRANSIENT_ERROR';
        error.retryable = true;
        throw error;
      }
      return {
        mailbox: runtime.ensureMailbox(''),
        discoveredFolders: 1,
        completedFolders: 1,
        failedFolders: 0,
        folderResults: [],
        errors: [],
        pages: 1,
        received: 1,
        upserts: 1,
        deletions: 0,
        attachmentErrors: 0,
        messages: [],
      };
    },
  };

  const result = await runtime.syncMailbox({ accessToken: 'token' });
  assert.equal(attempts, 2);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.attemptCount, 2);
  assert.equal(runtime.store.listDeadLetters().length, 0);
});

test('partial folder failures complete the mailbox job and create dead letters', async (t) => {
  const runtime = await withRuntime(t);
  runtime.syncService = {
    async syncMailbox() {
      return {
        mailbox: runtime.ensureMailbox(''),
        discoveredFolders: 2,
        completedFolders: 1,
        failedFolders: 1,
        folderResults: [],
        errors: [{
          folderId: 'archive',
          displayName: 'Archive',
          code: 'GRAPH_REQUEST_FAILED',
          message: 'Folder access denied.',
        }],
        pages: 1,
        received: 1,
        upserts: 1,
        deletions: 0,
        attachmentErrors: 0,
        messages: [],
      };
    },
  };

  const result = await runtime.syncMailbox({ accessToken: 'token' });
  assert.equal(result.job.status, 'completed');
  assert.equal(result.failedFolders, 1);
  const deadLetters = runtime.store.listDeadLetters();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].entityId, 'archive');
  assert.equal(deadLetters[0].errorCode, 'GRAPH_REQUEST_FAILED');
});
