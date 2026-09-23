import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BRIEFING_MAX_ITEMS,
  NEXT_ACTION_KINDS,
  collectBriefingUniverse,
  rankTodayBriefing,
} from '../src/domain/today-briefing-contract.js';

const plan = await readFile(new URL('../docs/planning/notion-crm-collaboration-v1/00-COMPLEMENT-PLAN.md', import.meta.url), 'utf8');
const contracts = await readFile(new URL('../docs/planning/notion-crm-collaboration-v1/01-CONTRACTS.md', import.meta.url), 'utf8');

test('today briefing starts from all in-progress CRM projects, not DO NOW intersection', () => {
  assert.match(plan, /all in-progress CRM projects|모든 진행 중 CRM 프로젝트/i);
  assert.doesNotMatch(plan, /DO NOW ∩ Notion 다음 행동/);
  assert.match(plan, /union|합집합|UNION/i);
  assert.match(contracts, /internal_next_action|내부 다음 행동/);
  assert.match(contracts, /external_confirmed_commitment|외부 확정 약속/);
  assert.match(contracts, /external_expected_confirm|외부 확정 예정일/);

  const projects = [
    { id: 'p-quiet', name: 'Quiet', status: '진행', importanceScore: 0 },
    { id: 'p-risk', name: 'Risk', status: '진행', deadlineScore: 4, hasDoNow: false, nextAction: { kind: NEXT_ACTION_KINDS.INTERNAL_NEXT_ACTION, text: '내부 확인' } },
    { id: 'p-done', name: 'Done', status: '완료', deadlineScore: 9, hasDoNow: true },
    { id: 'p-donow', name: 'DoNow', status: '진행', hasDoNow: true, nextAction: { kind: NEXT_ACTION_KINDS.EXTERNAL_CONFIRMED_COMMITMENT, text: '고객 회신', confirmed: true, audience: 'external' }, stallScore: 1 },
  ];
  const universe = collectBriefingUniverse(projects);
  assert.deepEqual(universe.map((item) => item.id).sort(), ['p-donow', 'p-quiet', 'p-risk']);

  const ranked = rankTodayBriefing(projects, { 'p-risk': 3, 'p-quiet': 0 }, { max: BRIEFING_MAX_ITEMS });
  assert.equal(ranked.source, 'union_in_progress_plus_mail_risk');
  assert.ok(ranked.items.some((item) => item.id === 'p-risk' && !item.hasDoNow));
  assert.equal(ranked.items.some((item) => item.id === 'p-done'), false);
  assert.ok(ranked.excluded.some((item) => item.id === 'p-quiet' && item.reason === 'no_risk_or_deadline_signal'));
  assert.ok(ranked.items.every((item) => item.nextActionKind));
});

test('today briefing keeps max 5 and records exclusion reasons', () => {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    id: `p-${index}`,
    name: `P${index}`,
    status: 'in_progress',
    importanceScore: 8 - index,
    nextAction: { kind: NEXT_ACTION_KINDS.EXTERNAL_EXPECTED_CONFIRM, expectedConfirmAt: '2026-09-12', audience: 'external' },
  }));
  const ranked = rankTodayBriefing(projects);
  assert.equal(ranked.items.length, 5);
  assert.equal(ranked.excluded.length, 3);
  assert.ok(ranked.excluded.every((item) => item.reason === 'below_top_n'));
});
