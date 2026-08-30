import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importLegacyMailCache } from '../src/storage/legacy-import.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-legacy-import-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('legacy JSON messages, feedback and analysis import once without deleting source', async (t) => {
  const { directory, store } = await fixture(t);
  const sourcePath = join(directory, '.mail-cache.json');
  const cacheKey = 'legacy-message-1::change-1::lmstudio';
  const payload = {
    version: 1,
    mailboxes: {
      me: {
        messages: [{
          id: 'legacy-message-1',
          changeKey: 'change-1',
          subject: '기존 프로젝트 일정',
          from: 'customer@example.com',
          fromName: '고객 담당자',
          receivedAt: '2026-08-20T01:00:00.000Z',
          bodyPreview: '다음 주까지 일정 회신 부탁드립니다.',
          body: '다음 주까지 일정 회신 부탁드립니다.',
          isRead: false,
          importance: 'high',
        }],
        feedback: {
          'legacy-message-1': {
            userStatus: 'urgent',
            reasonCode: 'urgent',
            reasonLabel: '마감 임박',
            note: '사용자 보정',
            sender: 'customer@example.com',
            subject: '기존 프로젝트 일정',
            subjectTokens: ['기존', '프로젝트', '일정'],
            savedAt: '2026-08-21T01:00:00.000Z',
          },
        },
        analysis: {
          [cacheKey]: {
            status: 'urgent',
            summary: ['다음 주까지 일정 회신 요청'],
            evidenceItems: ['다음 주까지 일정 회신 부탁드립니다.'],
            nextActions: [{ actionType: 'draft_reply', recommendedAction: '일정 회신' }],
            aiRationale: '명시적 기한',
          },
        },
      },
    },
  };
  await writeFile(sourcePath, JSON.stringify(payload, null, 2));

  const first = await importLegacyMailCache({ store, sourcePath });
  assert.equal(first.imported, true);
  assert.equal(first.mailboxCount, 1);
  assert.equal(first.messageCount, 1);
  assert.equal(first.feedbackCount, 1);
  assert.equal(first.analysisCount, 1);
  assert.ok((await readFile(sourcePath, 'utf8')).includes('legacy-message-1'));

  const mailbox = store.getMailbox('me');
  assert.equal(store.getRecentMessages(mailbox.id)[0].subject, '기존 프로젝트 일정');
  assert.equal(store.getFeedbackMap(mailbox.id)['legacy-message-1'].note, '사용자 보정');
  assert.equal(store.getAnalysis(mailbox.id, 'legacy-message-1', `legacy:${cacheKey}`).status, 'urgent');

  const second = await importLegacyMailCache({ store, sourcePath });
  assert.equal(second.imported, false);
  assert.equal(second.reason, 'already-imported');
  assert.equal(store.counts().messages, 1);
});

test('invalid legacy JSON fails closed without recording an import', async (t) => {
  const { directory, store } = await fixture(t);
  const sourcePath = join(directory, '.mail-cache.json');
  await writeFile(sourcePath, '{invalid');
  await assert.rejects(
    importLegacyMailCache({ store, sourcePath }),
    (error) => error.code === 'LEGACY_CACHE_INVALID',
  );
  assert.equal(store.counts().messages, 0);
});
