import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectNotionReadonlySnapshot,
  createLiveShapedRecordedScript,
  createNotionReadonlyFetch,
  createRecordedNotionFetch,
  flattenNotionPageProperties,
  isNotionReadonlyEnabled,
  loadNotionDatabaseMap,
  notionDatabaseToDeidentifiedSchema,
  resolveNotionReadonlyConfig,
} from '../src/adapters/notion-readonly-collect.js';
import { createNotionWorkSystem } from '../src/adapters/notion-work-system.js';
import { loadDeidentifiedSchema } from '../src/adapters/notion-schema-contract.js';

const ROOT = join(import.meta.dirname, '..');
const SCHEMA = join(ROOT, 'test/fixtures/notion-activity-schema.deidentified.json');

function livePages() {
  return {
    accounts: [
      {
        object: 'page',
        id: 'syn-live-account-1',
        url: 'https://example.invalid/notion/syn-live-account-1',
        properties: {
          '회사/조직명': {
            type: 'title',
            title: [{ plain_text: '합성고객A' }],
          },
          '대표 이메일': { type: 'email', email: 'a@example.com' },
        },
      },
    ],
    projects: [
      {
        object: 'page',
        id: 'syn-live-project-1',
        url: 'https://example.invalid/notion/syn-live-project-1',
        properties: {
          '프로젝트명(Title)': {
            type: 'title',
            title: [{ plain_text: '합성 프로젝트' }],
          },
          '프로젝트ID': {
            type: 'rich_text',
            rich_text: [{ plain_text: 'PRJ-SYN-1' }],
          },
          '다음 행동': {
            type: 'rich_text',
            rich_text: [{ plain_text: '문서 확인' }],
          },
          '고객·파트너': {
            type: 'relation',
            relation: [{ id: 'syn-live-account-1' }],
          },
        },
      },
    ],
  };
}

test('readonly flag defaults OFF and reports BLOCKED_ON_SECRET without inventing tokens', () => {
  assert.equal(isNotionReadonlyEnabled({}), false);
  const disabled = resolveNotionReadonlyConfig({ MAIL_INTELLIGENCE_NOTION_READONLY: '0' }, { cwd: ROOT });
  assert.equal(disabled.code, 'READONLY_DISABLED');

  const blocked = resolveNotionReadonlyConfig({
    MAIL_INTELLIGENCE_NOTION_READONLY: '1',
  }, { cwd: ROOT });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'BLOCKED_ON_SECRET');
  assert.equal(blocked.discovery.tokenEnvPresent, false);
  assert.equal(blocked.discovery.tokenFileReadable, false);
  assert.ok(!JSON.stringify(blocked).includes('secret_'));
});

test('flattenNotionPageProperties maps live-shaped Notion property bags', () => {
  const flat = flattenNotionPageProperties({
    '회사/조직명': { type: 'title', title: [{ plain_text: 'Acme' }] },
    '대표 이메일': { type: 'email', email: 'ops@example.com' },
    '별칭': { type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] },
    '고객·파트너': { type: 'relation', relation: [{ id: 'rel-1' }] },
  });
  assert.equal(flat['회사/조직명'], 'Acme');
  assert.equal(flat['대표 이메일'], 'ops@example.com');
  assert.deepEqual(flat['별칭'], ['A', 'B']);
  assert.deepEqual(flat['고객·파트너'], ['rel-1']);
});

test('createNotionReadonlyFetch blocks page create / PATCH / DELETE', async () => {
  const calls = [];
  const http = createNotionReadonlyFetch({
    token: 'test-token-not-a-secret',
    calls,
    fetchImpl: async () => {
      throw new Error('network should not run for blocked methods');
    },
  });
  await assert.rejects(
    () => http('https://api.notion.com/v1/pages', { method: 'POST', body: '{}' }),
    { code: 'NOTION_WRITE_HTTP_FORBIDDEN' },
  );
  await assert.rejects(
    () => http('https://api.notion.com/v1/pages/syn-1', { method: 'PATCH', body: '{}' }),
    { code: 'NOTION_WRITE_HTTP_FORBIDDEN' },
  );
  await assert.rejects(
    () => http('https://api.notion.com/v1/blocks/syn-1', { method: 'DELETE' }),
    { code: 'NOTION_WRITE_HTTP_FORBIDDEN' },
  );
});

test('recorded harness collects snapshot, validates schema, writes untracked out path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-notion-p1b-'));
  const outPath = join(dir, 'live-snapshot.json');
  const mapPath = join(dir, 'database-map.json');
  writeFileSync(mapPath, JSON.stringify({
    workspaceId: 'syn-workspace-live-shaped',
    accountsDatabaseId: 'syn-db-accounts',
    projectsDatabaseId: 'syn-db-projects',
    activitiesDatabaseId: 'syn-db-activities',
  }), 'utf8');

  const pages = livePages();
  const calls = [];
  const http = createRecordedNotionFetch(
    createLiveShapedRecordedScript({
      accountPages: pages.accounts,
      projectPages: pages.projects,
    }),
    { calls },
  );

  const result = await collectNotionReadonlySnapshot({
    skipCredentialGate: true,
    http,
    databaseMap: mapPath,
    expectedActivitySchema: loadDeidentifiedSchema(SCHEMA),
    outPath,
    cwd: ROOT,
    env: { MAIL_INTELLIGENCE_NOTION_READONLY: '1' },
    now: () => '2026-09-11T12:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'COLLECTED');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.stale, false);
  assert.equal(result.watermarks.source, '2026-09-11T12:00:00.000Z');
  assert.equal(result.watermarks.analysisComplete, '2026-09-11T12:00:00.000Z');
  assert.equal(result.metrics.accountCount, 1);
  assert.equal(result.metrics.projectCount, 1);
  assert.ok(String(result.metrics.schemaHash || '').startsWith('sha256:'));
  assert.ok(!JSON.stringify(result.metrics).includes('합성고객'));

  const saved = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(saved.workspaceId, 'syn-workspace-live-shaped');
  assert.equal(saved.accounts[0].sourceId, 'syn-live-account-1');
  assert.equal(saved.projects[0].properties['프로젝트ID'], 'PRJ-SYN-1');
  assert.ok(calls.every((call) => call.method === 'GET' || call.kind === 'database_query'));

  rmSync(dir, { recursive: true, force: true });
});

test('schema type mismatch keeps last-known-good and marks partial/stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-notion-p1b-lkg-'));
  const outPath = join(dir, 'live-snapshot.json');
  const mapPath = join(dir, 'database-map.json');
  writeFileSync(mapPath, JSON.stringify({
    workspaceId: 'syn-workspace-live-shaped',
    accountsDatabaseId: 'syn-db-accounts',
    projectsDatabaseId: 'syn-db-projects',
    activitiesDatabaseId: 'syn-db-activities',
  }), 'utf8');

  const good = await collectNotionReadonlySnapshot({
    skipCredentialGate: true,
    http: createRecordedNotionFetch(createLiveShapedRecordedScript({
      accountPages: livePages().accounts,
      projectPages: livePages().projects,
    })),
    databaseMap: mapPath,
    expectedActivitySchema: loadDeidentifiedSchema(SCHEMA),
    outPath,
    cwd: ROOT,
    env: { MAIL_INTELLIGENCE_NOTION_READONLY: '1' },
    now: () => '2026-09-11T12:00:00.000Z',
  });
  assert.equal(good.ok, true);

  const badProps = {
    '활동명': { type: 'title', title: {} },
    '유형': { type: 'select', select: { options: [{ name: '메일 수신' }] } },
    '활동일': { type: 'date', date: {} },
    '요약': { type: 'rich_text', rich_text: {} },
    // Fail closed: mapped evidence pointer must remain rich_text
    '출처 ID/경로': { type: 'number', number: {} },
    '근거등급': {
      type: 'select',
      select: { options: [{ name: '확인된 사실' }, { name: 'AI 추론' }, { name: '사용자 제안' }, { name: '가정' }, { name: '기각' }, { name: '이전 버전' }] },
    },
    '확신도': { type: 'select', select: { options: [{ name: '높음' }, { name: '보통' }, { name: '낮음' }] } },
    '검토상태': { type: 'select', select: { options: [{ name: '검증완료' }, { name: '연결검토' }, { name: '제외' }] } },
    '자연키': { type: 'rich_text', rich_text: {} },
    '프로젝트': { type: 'relation', relation: {} },
    '고객·파트너': { type: 'relation', relation: {} },
  };

  const failed = await collectNotionReadonlySnapshot({
    skipCredentialGate: true,
    http: createRecordedNotionFetch(createLiveShapedRecordedScript({
      accountPages: livePages().accounts,
      projectPages: livePages().projects,
      activityDatabaseProperties: badProps,
    })),
    databaseMap: mapPath,
    expectedActivitySchema: loadDeidentifiedSchema(SCHEMA),
    outPath,
    cwd: ROOT,
    env: { MAIL_INTELLIGENCE_NOTION_READONLY: '1' },
    now: () => '2026-09-11T13:00:00.000Z',
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SCHEMA_TYPE_MISMATCH');
  assert.equal(failed.stale, true);
  assert.equal(failed.completeness, 'partial');
  assert.equal(failed.lastKnownGood, true);
  assert.equal(failed.watermarks.source, '2026-09-11T12:00:00.000Z');
  assert.equal(failed.watermarks.analysisComplete, '2026-09-11T12:00:00.000Z');
  assert.equal(failed.metrics.fromLastKnownGood, true);

  const stillGood = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(stillGood.capturedAt, '2026-09-11T12:00:00.000Z');

  rmSync(dir, { recursive: true, force: true });
});

test('WorkSystem listMasters uses readonly collect and proposeActivity stays disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-notion-p1b-port-'));
  const outPath = join(dir, 'live-snapshot.json');
  const mapPath = join(dir, 'database-map.json');
  writeFileSync(mapPath, JSON.stringify({
    workspaceId: 'syn-workspace-live-shaped',
    accountsDatabaseId: 'syn-db-accounts',
    projectsDatabaseId: 'syn-db-projects',
    activitiesDatabaseId: 'syn-db-activities',
  }), 'utf8');

  const http = createRecordedNotionFetch(createLiveShapedRecordedScript({
    accountPages: livePages().accounts,
    projectPages: livePages().projects,
  }));

  const port = createNotionWorkSystem({
    readonlyCollect: () => collectNotionReadonlySnapshot({
      skipCredentialGate: true,
      http,
      databaseMap: mapPath,
      expectedActivitySchema: loadDeidentifiedSchema(SCHEMA),
      outPath,
      cwd: ROOT,
      env: { MAIL_INTELLIGENCE_NOTION_READONLY: '1' },
      now: () => '2026-09-11T14:00:00.000Z',
    }),
  });

  const masters = await port.listMasters();
  assert.ok(masters.some((item) => item.externalId === 'syn-live-project-1'));
  assert.ok(masters.some((item) => item.externalId === 'syn-live-account-1'));
  await assert.rejects(() => port.proposeActivity({ summary: 'nope' }), { code: 'NOTION_WRITE_DISABLED' });

  rmSync(dir, { recursive: true, force: true });
});

test('collect without flag returns READONLY_DISABLED; live-shaped schema helper hashes', () => {
  return collectNotionReadonlySnapshot({
    env: {},
    cwd: ROOT,
  }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'READONLY_DISABLED');
  }).then(() => {
    const schema = notionDatabaseToDeidentifiedSchema({
      properties: {
        '확신도': { type: 'select', select: { options: [{ name: '높음' }, { name: '보통' }, { name: '낮음' }] } },
      },
    }, { capturedAt: '2026-09-11T00:00:00Z' });
    assert.ok(schema.schemaHash.startsWith('sha256:'));
    assert.equal(loadNotionDatabaseMap({
      workspaceId: 'ws',
      accountsDatabaseId: 'a',
      projectsDatabaseId: 'p',
    }).accountsDatabaseId, 'a');
  });
});
