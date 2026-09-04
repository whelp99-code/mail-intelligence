import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachmentSummaryCandidate,
  extractMeetingCandidate,
  generateSafeDraft,
  improveDraftText,
  normalizeAssistantPersonality,
  summarizeMessage,
  summarizeThread,
} from '../src/domain/mail-assistant-tools.js';

const baseMessage = {
  id: 'message-1',
  subject: '견적 검토 요청',
  from: 'partner@example.com',
  receivedAt: '2026-09-03T01:00:00Z',
  body: '견적서를 전달드립니다. 내일까지 검토 후 회신 부탁드립니다.\n\n---------- Forwarded message ----------\n과거 요청입니다.',
};

const classification = {
  workState: 'action_required',
  nextActor: 'me',
  priority: 'high',
  operational: { lane: 'do_now' },
};

test('message summary uses current content only', () => {
  const result = summarizeMessage(baseMessage, classification);
  assert.match(result.oneLine, /견적서를 전달/);
  assert.doesNotMatch(JSON.stringify(result), /과거 요청/);
  assert.equal(result.currentContentOnly, true);
  assert.equal(result.externalAiUsed, false);
});

test('thread summary presents recent current-content summaries and lane', () => {
  const messages = [
    { ...baseMessage, id: 'm1', conversationId: 'thread-1', body: '견적서를 요청드립니다.', receivedAt: '2026-09-01T01:00:00Z' },
    { ...baseMessage, id: 'm2', conversationId: 'thread-1', body: '견적서를 전달드립니다.', receivedAt: '2026-09-02T01:00:00Z' },
  ];
  const map = new Map([
    ['m1', { workState: 'waiting', nextActor: 'external_party', priority: 'normal', operational: { lane: 'waiting' } }],
    ['m2', { workState: 'completed', nextActor: 'none', priority: 'normal', operational: { lane: 'archive' } }],
  ]);
  const result = summarizeThread(messages, map);
  assert.equal(result.messageCount, 2);
  assert.equal(result.currentLane, 'waiting');
  assert.equal(result.detailed.length, 2);
});

test('meeting intent returns candidates but never guesses availability or writes calendar', () => {
  const result = extractMeetingCandidate({
    ...baseMessage,
    subject: '원격지원 일정 확인',
    body: '내일 오후 3시에 Teams 미팅으로 진행 가능하신지 확인 부탁드립니다.',
  });
  assert.equal(result.detected, true);
  assert.ok(result.candidateTimes.some((item) => /내일|오후 3시/.test(item)));
  assert.equal(result.availability, 'unknown');
  assert.equal(result.calendarWriteAllowed, false);
  assert.equal(result.confirmationDraftAllowed, true);
});

test('meeting candidate rejects invalid, URL, tracking, and newsletter numeric dates', () => {
  for (const body of [
    'Teams 미팅은 2026/0/24 오후 3시입니다.',
    '회의 일정은 2026/9/73 30:18입니다.',
    '미팅 링크 https://example.test/schedule/2026/09/12?utm_source=newsletter',
    '뉴스레터 campaign 2026-09-12 일정 안내',
  ]) {
    const result = extractMeetingCandidate({ subject: '미팅 안내', body });
    assert.deepEqual(result.candidateTimes, []);
  }
});

test('meeting candidate retains valid calendar dates without treating the year as a clock', () => {
  const result = extractMeetingCandidate({ subject: '회의 일정', body: '2026-09-12에 회의가 있습니다.' });
  assert.ok(result.candidateTimes.includes('2026-09-12'));
});

test('AI personality is local bounded configuration', () => {
  const result = normalizeAssistantPersonality({
    role: '기술 엔지니어',
    tone: '간결하고 전문적인 말투',
    opening: '안녕하세요, 기술지원팀입니다.',
  });
  assert.equal(result.role, '기술 엔지니어');
  assert.match(result.opening, /기술지원팀/);
});

test('improve draft normalizes a local draft without sending', () => {
  const result = improveDraftText('자료 확인했습니다\n내일 회신드리겠습니다', {
    role: '담당자', tone: '정중', opening: '안녕하세요.',
  });
  assert.match(result.text, /^안녕하세요\./);
  assert.match(result.text, /자료 확인했습니다\./);
  assert.match(result.text, /감사합니다\./);
});

test('rapid reply and meeting confirmation are copy-only drafts', () => {
  const rapid = generateSafeDraft({ message: baseMessage, classification, mode: 'rapid_reply' });
  assert.equal(rapid.sendAllowed, false);
  assert.equal(rapid.requiresHumanApproval, true);
  assert.equal(rapid.action, 'copy_only');
  assert.match(rapid.body, /최종 내용은 발송 전에 직접 검토/);

  const meeting = generateSafeDraft({
    message: baseMessage,
    classification,
    mode: 'meeting_confirmation',
    meetingCandidate: { candidateTimes: ['내일 오후 3시'] },
  });
  assert.equal(meeting.calendarWriteAllowed, false);
  assert.match(meeting.body, /내일 오후 3시/);
});

test('attachment summary remains metadata-only when Graph has no content', () => {
  const result = attachmentSummaryCandidate({
    id: 'a1',
    name: 'proposal.pdf',
    contentType: 'application/pdf',
    size: 1200,
  });
  assert.equal(result.supported, true);
  assert.equal(result.contentAvailable, false);
  assert.equal(result.summaryStatus, 'metadata_only');
  assert.equal(result.affectsClassification, false);
  assert.equal(result.requiresReview, true);
});

test('provided extracted attachment text can be summarized with source hash', () => {
  const result = attachmentSummaryCandidate({
    id: 'a2',
    name: 'guide.txt',
    contentType: 'text/plain',
  }, {
    extractedText: '첫 번째 핵심 내용입니다. 두 번째 확인 항목입니다. 세 번째 참고 사항입니다.',
  });
  assert.equal(result.summaryStatus, 'summarized_from_provided_text');
  assert.ok(result.sourceHash);
  assert.equal(result.affectsClassification, false);
  assert.equal(result.externalAiUsed, false);
});

test('unsupported attachment does not invent content', () => {
  const result = attachmentSummaryCandidate({ name: 'archive.zip', contentType: 'application/zip' });
  assert.equal(result.supported, false);
  assert.equal(result.summaryStatus, 'unsupported');
  assert.equal(result.contentAvailable, false);
});
