import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_FIELDS,
  UNLINKED_PROJECT,
  analysisLine,
  analysisValues,
  registeredProjectName,
  threadKey,
} from '../src/domain/analysis-display.js';

const waiting = {
  operational: { lane: 'waiting' },
  nextActor: 'external_party',
  priority: 'normal',
  workState: 'waiting',
  projectResolution: 'candidate',
  projectCandidate: { label: '합성 후보' },
};

test('the analysis table has one slot for each visible value', () => {
  assert.deepEqual(ANALYSIS_FIELDS.map((field) => field.name), [
    '처리 상태',
    '다음 행동',
    '긴급도',
    '분류',
    '연결 프로젝트',
  ]);
});

test('a card line names each field and does not say 대기 twice', () => {
  const line = analysisLine(waiting);
  assert.equal(line, `처리 상태 대기 · 다음 행동 고객·외부 차례 · 긴급도 보통 · 프로젝트 ${UNLINKED_PROJECT}`);
  assert.equal(line.split('대기').length - 1, 1);
  assert.equal(line.includes('프로젝트 후보'), false);
  assert.equal(analysisValues(waiting).kind, '');
});

test('a different classification stays beside the status', () => {
  const line = analysisLine({
    ...waiting,
    operational: { lane: 'archive' },
    workState: 'reference',
    nextActor: 'none',
    priority: 'low',
  });
  assert.equal(line, `처리 상태 보관 · 다음 행동 다음 행동 없음 · 긴급도 낮음 · 분류 참고 · 프로젝트 ${UNLINKED_PROJECT}`);
});

test('a registered CRM project name replaces the candidate label', () => {
  const links = [{ objectType: 'engagement', status: 'linked', name: '합성 프로젝트' }];
  assert.equal(registeredProjectName(waiting, links), '합성 프로젝트');
  assert.equal(analysisLine(waiting, links).includes('합성 프로젝트'), true);
  assert.equal(registeredProjectName({
    projectResolution: 'confirmed',
    projectName: '확정 이름',
  }), '확정 이름');
  assert.equal(registeredProjectName({
    projectResolution: 'candidate',
    projectCandidate: { label: '후보만' },
  }, [{ objectType: 'engagement', status: 'candidate', name: '후보만' }]), UNLINKED_PROJECT);
});

test('the same project and conversation share a thread key', () => {
  const first = threadKey({ conversationId: 'thread-1' }, waiting, [
    { objectType: 'engagement', status: 'active', name: '합성 프로젝트' },
  ]);
  const second = threadKey({ conversationId: 'thread-1', subject: 'Re: 다른 제목' }, waiting, [
    { objectType: 'engagement', status: 'active', name: '합성 프로젝트' },
  ]);
  const other = threadKey({ conversationId: 'thread-2' }, waiting, [
    { objectType: 'engagement', status: 'active', name: '합성 프로젝트' },
  ]);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(threadKey({ subject: '대화 없음' }, waiting), '');
});
