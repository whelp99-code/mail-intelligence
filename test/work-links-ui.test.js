import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const contracts = await readFile(new URL('../docs/planning/notion-crm-collaboration-v1/01-CONTRACTS.md', import.meta.url), 'utf8');

test('UI shows Notion candidate WorkLinks and rates without chat', () => {
  assert.match(html, /workLinkLinkedCount/);
  assert.match(html, /workLinkUnassignedCount/);
  assert.match(html, /후보 프로젝트 \(Notion\)|Notion 후보 링크/);
  assert.match(app, /loadWorkLinks/);
  assert.match(app, /후보 프로젝트 \(Notion\)/);
  assert.match(app, /자동 확정 없음/);
  assert.doesNotMatch(app, /\/api\/chat/);
});

test('Phase 0 contract names Grokbot investigation and Codex verification', () => {
  assert.match(contracts, /Grokbot investigates/);
  assert.match(contracts, /Codex contrasts\/verifies/);
  assert.match(contracts, /Do \*\*not\*\* add Copilot-style free chat/);
  assert.match(contracts, /syn-mail-quote/);
  assert.match(contracts, /NOTION_WRITE_DISABLED/);
});
