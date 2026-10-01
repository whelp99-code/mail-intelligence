import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  containsForbiddenVisibleLabel,
  operationalLaneLabel,
  renderDetailMetaImportance,
  renderLaneFilterLabels,
  renderOperationalDetail,
  renderPrecisionStayNote,
  renderStoredPrecisionStatus,
} from '../src/ui-labels.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

function visibleText(source) {
  return String(source)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

test('rendered operational chrome has no listed English labels', () => {
  const rendered = [
    renderLaneFilterLabels(),
    renderOperationalDetail('do_now'),
    renderOperationalDetail('waiting'),
    renderOperationalDetail('review'),
    renderOperationalDetail('archive'),
    renderOperationalDetail('unknown-lane'),
    `중요도 ${renderDetailMetaImportance('normal')}`,
    renderStoredPrecisionStatus({
      total: 4,
      lanes: { do_now: 1, waiting: 1, review: 1, archive: 1 },
      review: 1,
    }),
    renderPrecisionStayNote(),
    visibleText(html),
  ].join('\n');

  assert.equal(containsForbiddenVisibleLabel(rendered), false, rendered);
  assert.equal(operationalLaneLabel('do_now'), '지금 처리');
  assert.equal(operationalLaneLabel('waiting'), '대기');
  assert.equal(operationalLaneLabel('review'), '검토');
  assert.equal(operationalLaneLabel('archive'), '보관');
  assert.equal(renderDetailMetaImportance('normal'), '보통');
  assert.match(html, /data-filter="op:do_now"/);
  assert.match(visibleText(html), /지금 처리/);
  assert.match(visibleText(html), /정밀 분류/);
});
