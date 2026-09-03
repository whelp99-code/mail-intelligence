#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const databasePath = resolve(process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
if (!existsSync(databasePath)) {
  console.log(JSON.stringify({ searchQa: 'SKIPPED', reason: 'database_not_found' }, null, 2));
  process.exit(0);
}

const store = new SQLiteMailStore({
  databasePath,
  migrationsDir: resolve('migrations'),
});

try {
  const mailbox = store.db.prepare(`
    SELECT mb.mailbox_key
    FROM mailboxes mb
    JOIN messages m ON m.mailbox_id = mb.id
    WHERE m.deleted_at IS NULL
    GROUP BY mb.id
    ORDER BY COUNT(m.id) DESC, mb.id ASC
    LIMIT 1
  `).get();
  assert.ok(mailbox?.mailbox_key, 'Operational mailbox was not found.');

  const service = new PrecisionIntelligenceService({ store });
  const queries = [
    '롯데건설',
    'GS건설 라이선스',
    '부산도시가스 견적',
    '발주서',
    '세금계산서',
    'Sangfor IAG',
    '긴급 견적',
    '계약완료',
    '장애',
    '보안',
    '미국 ITAC 원격 접속 회신',
    '외부 회신 대기 라이선스',
    '완료된 패치 티켓',
    '검토 필요한 세금계산서',
    'HCI 라이선스 장애',
    '완료된 Sangfor 지원 문의',
    '대기 중인 라이선스 회신',
    '카드 한도 초과 위험',
    'Confluence 비활성화',
    '공유 폴더 이메일 인증',
  ];
  const summaries = [];

  for (const query of queries) {
    const response = service.search(mailbox.mailbox_key, query, { limit: 5 });
    const results = response.results || [];
    const folders = results.map((item) => String(item.message?.folderName || ''));
    const promotional = results.filter((item) => item.message?.isPromotional).length;
    const lifecycleGarbage = results.filter((item) => item.message?.isDeletedFolder || item.message?.isJunkFolder).length;
    const incidentNoise = ['장애', '보안'].includes(query)
      ? results.filter((item) => {
        const subject = String(item.message?.subject || '');
        const evidence = String(item.classification?.evidence?.workState?.exactText || '');
        const current = `${subject}\n${evidence}`;
        const pattern = query === '장애'
          ? /장애|오류|중단|접속\s*불가|outage|incident|ransomware|malware|breach/i
          : /보안|security|침해|해킹|랜섬웨어|ransomware|취약점|breach|malware|incident/i;
        return !pattern.test(current) && !(item.classification?.signals || []).includes('incident_security');
      }).length
      : 0;
    const genericIncidentGarbage = ['장애', '보안'].includes(query)
      ? results.filter((item) => /손해보험|보험다이렉트|청약서|계약완료\s*안내/i.test(String(item.message?.subject || ''))).length
      : 0;
    const semanticViolations = results.filter((item) => {
      const subject = String(item.message?.subject || '').toLowerCase();
      const preview = String(item.message?.bodyPreview || '').toLowerCase();
      const evidence = String(item.classification?.evidence?.workState?.exactText || '').toLowerCase();
      const state = String(item.classification?.workState || '');
      const actor = String(item.classification?.nextActor || '');
      const fieldHas = (left, right) => [subject, preview, evidence].some((value) => value.includes(left) && value.includes(right));
      if (query === 'Sangfor IAG') return !fieldHas('sangfor', 'iag');
      if (query === '검토 필요한 세금계산서') {
        return state !== 'review_required' || ![subject, evidence].some((value) => /세금계산서|tax invoice/.test(value));
      }
      if (query === '완료된 Sangfor 지원 문의') {
        return state !== 'completed'
          || ![subject, preview, evidence].some((value) => value.includes('sangfor'))
          || ![subject, preview, evidence].some((value) => /support|ticket|case|지원|문의/.test(value));
      }
      if (query === '대기 중인 라이선스 회신') {
        return state !== 'waiting' || actor !== 'external_party'
          || ![subject, preview, evidence].some((value) => /license|licence|라이선스|라이센스/.test(value));
      }
      if (query === 'Confluence 비활성화') {
        const current = `${subject} ${preview} ${evidence}`;
        return state !== 'action_required' || actor !== 'me'
          || !current.includes('confluence') || !/deactivat|inactive|suspend|비활성화|해지|중지/.test(current);
      }
      if (query === '공유 폴더 이메일 인증') {
        const current = `${subject} ${preview} ${evidence}`;
        return state !== 'action_required' || actor !== 'me'
          || !/shared folder|shared file|공유 폴더|공유 파일/.test(current)
          || !/verify|verification|인증/.test(current);
      }
      return false;
    }).length;
    summaries.push({
      query,
      count: results.length,
      residualText: response.parsedQuery.residualText,
      promotional,
      lifecycleGarbage,
      invoiceFolderResults: folders.filter((folder) => /세금계산서/i.test(folder)).length,
      incidentNoise,
      genericIncidentGarbage,
      semanticViolations,
      semanticIntent: response.parsedQuery.filters.semanticIntent || '',
    });

    assert.equal(promotional, 0, `${query}: promotional result leaked into Top-5.`);
    assert.equal(lifecycleGarbage, 0, `${query}: deleted/junk result leaked into Top-5.`);
  }

  const byQuery = Object.fromEntries(summaries.map((item) => [item.query, item]));
  assert.equal(byQuery['발주서'].residualText, '발주서');
  assert.ok(byQuery['발주서'].count >= 2, '발주서 search must return multiple relevant candidates.');
  assert.ok(byQuery['계약완료'].count >= 1, '계약완료 search must not return zero.');
  assert.ok(byQuery['긴급 견적'].count >= 1, '긴급 견적 search must return a candidate.');
  assert.equal(byQuery['긴급 견적'].invoiceFolderResults, 0, '긴급 견적 Top-5 must exclude invoice-folder garbage.');
  assert.ok(byQuery['장애'].count >= 1, '장애 search must return expanded technical candidates.');
  assert.ok(byQuery['보안'].count >= 1, '보안 search must return expanded security candidates.');
  assert.equal(byQuery['장애'].invoiceFolderResults, 0, '장애 Top-5 must exclude invoice-folder garbage.');
  assert.equal(byQuery['보안'].invoiceFolderResults, 0, '보안 Top-5 must exclude invoice-folder garbage.');
  assert.equal(byQuery['장애'].incidentNoise, 0, '장애 Top-5 must have current incident evidence or signal.');
  assert.equal(byQuery['보안'].incidentNoise, 0, '보안 Top-5 must have current security evidence or signal.');
  assert.equal(byQuery['장애'].genericIncidentGarbage, 0, '장애 Top-5 must exclude insurance and generic contract noise.');
  assert.equal(byQuery['보안'].genericIncidentGarbage, 0, '보안 Top-5 must exclude insurance and generic contract noise.');
  assert.ok(byQuery['미국 ITAC 원격 접속 회신'].count >= 1, 'ITAC remote-access query must return candidates.');
  assert.ok(byQuery['외부 회신 대기 라이선스'].count >= 1, 'External waiting license query must return candidates.');
  assert.equal(byQuery['완료된 패치 티켓'].semanticIntent, 'completed_support_ticket');
  assert.ok(byQuery['완료된 패치 티켓'].count >= 1, 'Completed patch ticket query must return a completed support result.');
  assert.ok(byQuery['검토 필요한 세금계산서'].count >= 1, 'Tax-invoice review query must return candidates.');
  assert.equal(byQuery['HCI 라이선스 장애'].semanticIntent, 'hci_license_incident');
  assert.ok(byQuery['HCI 라이선스 장애'].count >= 1, 'HCI license incident query must return a current issue result.');
  for (const query of [
    'Sangfor IAG',
    '검토 필요한 세금계산서',
    '완료된 Sangfor 지원 문의',
    '대기 중인 라이선스 회신',
    'Confluence 비활성화',
    '공유 폴더 이메일 인증',
  ]) {
    assert.ok(byQuery[query].count >= 1, `${query}: semantic query must return a directly grounded result.`);
    assert.equal(byQuery[query].semanticViolations, 0, `${query}: non-direct semantic result leaked into Top-5.`);
  }
  assert.equal(byQuery['완료된 Sangfor 지원 문의'].semanticIntent, 'completed_sangfor_support');
  assert.equal(byQuery['대기 중인 라이선스 회신'].semanticIntent, 'waiting_license_reply');
  assert.equal(byQuery['Confluence 비활성화'].semanticIntent, 'confluence_deactivation');
  assert.equal(byQuery['공유 폴더 이메일 인증'].semanticIntent, 'shared_access_verification');

  console.log(JSON.stringify({
    searchQa: 'PASS',
    queries: summaries,
    note: 'This is a deterministic smoke gate, not an independent Top-5 relevance score.',
  }, null, 2));
} finally {
  store.close();
}
