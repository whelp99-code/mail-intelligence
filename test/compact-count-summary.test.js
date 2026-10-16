import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compactCountSummary } from '../src/ui-labels.js';

test('a group status line keeps the total and hides zero counts', () => {
  const line = compactCountSummary(2, [
    { label: '지금 처리', count: 0 },
    { label: '대기', count: 0 },
    { label: '검토', count: 1 },
    { label: '보관', count: 1 },
    { label: '내 행동 필요', count: 0 },
    { label: '완료', count: 1 },
  ]);
  assert.equal(line, '2건 · 검토 1 · 보관 1 · 완료 1');
  assert.equal(line.includes('0'), false);
});

test('a group with only zeros keeps the total', () => {
  assert.equal(compactCountSummary(1, [{ label: '대기', count: 0 }]), '1건');
});

test('the mail list uses the compact status line', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /compactCountSummary\(items\.length, summaryEntries\)/);
});
