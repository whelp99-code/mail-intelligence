import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import {
  LEARNING_MATCH_THRESHOLD,
  learningScore,
  policyMatches,
} from '../src/domain/correction-generalization.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function graphMessage({
  id,
  subject,
  body,
  from = 'vendor@example.com',
  conversationId = `conversation-${id}`,
} = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { address: from, name: '발신자' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    receivedDateTime: '2026-09-27T00:00:00.000Z',
    sentDateTime: '2026-09-27T00:00:00.000Z',
    createdDateTime: '2026-09-27T00:00:00.000Z',
    lastModifiedDateTime: '2026-09-27T00:00:00.000Z',
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
    parentFolderId: 'inbox',
  });
}

function openStore(databasePath) {
  return new SQLiteMailStore({
    databasePath,
    migrationsDir: resolve('migrations'),
    now: () => '2026-09-28T01:00:00.000Z',
  });
}

test('sender and template similarity is stricter than a shared sender alone', () => {
  const policy = {
    active: true,
    senderEmail: 'vendor@example.com',
    conversationId: 'thread-a',
    subjectTokens: ['gs인증', '기능정리'],
  };
  const similar = {
    from: 'vendor@example.com',
    conversationId: 'thread-b',
    subject: '재송부 GS인증 기능정리 요청',
  };
  const sameThread = {
    from: 'vendor@example.com',
    conversationId: 'thread-a',
    subject: '다른 제목',
  };
  const unrelatedSubject = {
    from: 'vendor@example.com',
    conversationId: 'thread-c',
    subject: '추석 인사',
  };
  const otherSender = {
    from: 'other@example.com',
    conversationId: 'thread-a',
    subject: 'GS인증 기능정리 요청',
  };
  assert.equal(policyMatches(similar, policy), true);
  assert.ok(learningScore(similar, policy) >= LEARNING_MATCH_THRESHOLD);
  assert.equal(policyMatches(sameThread, policy), true);
  assert.equal(policyMatches(unrelatedSubject, policy), false);
  assert.equal(policyMatches(otherSender, policy), false);
});

test('a precision correction is recorded as feedback and applied to similar mail only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-learning-'));
  const store = openStore(join(directory, 'mail.sqlite'));
  try {
    const mailbox = store.ensureMailbox({ key: 'jm@example.com', address: 'jm@example.com' });
    const folder = store.ensureFolder({
      mailboxId: mailbox.id,
      graphId: 'inbox',
      wellKnownName: 'inbox',
      displayName: 'Inbox',
    });
    const messages = [
      graphMessage({
        id: 'source-mail',
        subject: 'GS인증 기능정리 요청',
        body: '핵심 기능과 옵션을 구분해서 전달 부탁드립니다.',
        conversationId: 'thread-source',
      }),
      graphMessage({
        id: 'similar-mail',
        subject: '재송부 GS인증 기능정리 요청',
        body: '지난 요청과 같이 기능정리를 다시 부탁드립니다.',
        conversationId: 'thread-similar',
      }),
      graphMessage({
        id: 'thread-mail',
        subject: '참고 전달',
        body: '위 스레드를 이어서 보냅니다.',
        conversationId: 'thread-source',
      }),
      graphMessage({
        id: 'other-sender',
        subject: 'GS인증 기능정리 요청',
        body: '핵심 기능과 옵션을 구분해서 전달 부탁드립니다.',
        from: 'other@example.com',
      }),
      graphMessage({
        id: 'greeting-mail',
        subject: '추석 인사',
        body: '즐거운 명절 보내세요.',
      }),
      graphMessage({
        id: 'already-corrected',
        subject: 'GS인증 기능정리 추가 요청',
        body: '기능정리 자료를 추가로 부탁드립니다.',
      }),
    ];
    for (const message of messages) {
      store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message });
    }
    const service = new PrecisionIntelligenceService({
      store,
      now: () => new Date('2026-09-28T01:00:00.000Z'),
    });
    service.correct('jm@example.com', 'already-corrected', {
      workState: 'waiting',
      nextActor: 'external_party',
      priority: 'low',
      reasonCode: 'already-set',
      note: '이 메일은 직접 보정이 있다',
    });
    const result = service.correct('jm@example.com', 'source-mail', {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'high',
      reasonCode: 'my-action',
      note: '현재 메일의 명시적 요청이다',
    });
    assert.equal(result.classification.workState, 'action_required');
    assert.equal(result.classification.reviewStatus, 'corrected');
    assert.equal(result.feedback.userStatus, 'urgent');
    assert.ok(result.learningPolicy.policyVersion >= 1);
    assert.ok(result.generalized.applied.includes('similar-mail'));
    assert.ok(result.generalized.applied.includes('thread-mail'));
    assert.equal(result.generalized.applied.includes('other-sender'), false);
    assert.equal(result.generalized.applied.includes('greeting-mail'), false);
    assert.equal(result.generalized.applied.includes('already-corrected'), false);
    assert.ok(result.generalized.skippedExplicit.includes('already-corrected'));

    const similar = store.getPrecisionClassification(mailbox.id, 'similar-mail');
    assert.equal(similar.workState, 'action_required');
    assert.equal(similar.nextActor, 'me');
    assert.equal(similar.priority, 'high');
    assert.equal(similar.source, 'hybrid');
    assert.equal(similar.reviewStatus, 'auto');
    assert.ok(similar.reviewReasons.some((reason) => reason.startsWith('learned-policy:')));

    const greeting = service.classifyOne('jm@example.com', 'greeting-mail').classification;
    assert.notEqual(greeting.workState, 'action_required');
    assert.equal(greeting.source === 'hybrid', false);
    const other = service.classifyOne('jm@example.com', 'other-sender').classification;
    assert.equal(other.source === 'hybrid', false);
    const preserved = store.getPrecisionClassification(mailbox.id, 'already-corrected');
    assert.equal(preserved.workState, 'waiting');
    assert.equal(preserved.reviewStatus, 'corrected');

    store.close();
    const reopened = openStore(join(directory, 'mail.sqlite'));
    const again = new PrecisionIntelligenceService({
      store: reopened,
      now: () => new Date('2026-09-28T02:00:00.000Z'),
    });
    reopened.upsertNormalizedMessage({
      mailboxId: mailbox.id,
      folderId: folder.id,
      message: graphMessage({
        id: 'future-similar',
        subject: 'GS인증 기능정리 재요청',
        body: '기능정리 파일을 다시 보내 주세요.',
      }),
    });
    const future = again.classifyOne('jm@example.com', 'future-similar');
    assert.equal(future.classification.workState, 'action_required');
    assert.equal(future.classification.nextActor, 'me');
    assert.equal(future.classification.source, 'hybrid');
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
