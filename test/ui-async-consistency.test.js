import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { operationalLaneLabel, DISPLAY_LABELS } from '../src/ui-labels.js';
const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
test('assistant and search reject stale success, rejection, and finally writes',()=>{assert.match(app,/assistantRequestSequence/);assert.match(app,/searchRequestSequence/);assert.match(app,/messageId !== selectedMessageId/);assert.match(app,/if \(requestSequence !== assistantRequestSequence \|\| messageId !== selectedMessageId\) return;\n {4}renderAssistantOutput\(error/);assert.match(app,/if \(requestSequence !== searchRequestSequence\) return;\n {4}fetchStatus/);assert.match(app,/if \(requestSequence === searchRequestSequence\) searchDatabase\.disabled = false;/);});
test('database result state does not mutate loaded mailbox and clears on query clear',()=>{assert.doesNotMatch(app,/else currentMessages\.push/);assert.match(app,/databaseSearchResults\.hidden = true/);assert.match(app,/await loadOutlookMessages\(\);/);});

test('handled messages leave both action lanes and undo restores their classification', () => {
  const messages = [{ id: 'handled-fixture', handledElsewhere: { channel: 'phone', markedAt: '2026-10-01T01:00:00Z' } }];
  const context = createContext({
    currentMessages: messages,
    precisionFor: () => ({ workState: 'action_required', operational: { lane: 'do_now' } }),
  });
  for (const name of ['laneForMessage', 'operationalLaneForMessage']) {
    const source = app.match(new RegExp(`function ${name}\\(messageId\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source);
    runInContext(source, context);
  }
  assert.equal(runInContext('laneForMessage("handled-fixture")', context), 'completed');
  assert.equal(runInContext('operationalLaneForMessage("handled-fixture")', context), 'archive');
  assert.equal(operationalLaneLabel(runInContext('operationalLaneForMessage("handled-fixture")', context)), DISPLAY_LABELS.archive);
  messages[0].handledElsewhere = null;
  assert.equal(runInContext('laneForMessage("handled-fixture")', context), 'action_required');
  assert.equal(runInContext('operationalLaneForMessage("handled-fixture")', context), 'do_now');
});

for (const channel of ['phone', 'kakao']) {
  test(`handled ${channel} state reaches actual card and detail despite cached classification`, () => {
    const message = {
      id: `handled-${channel}`,
      subject: 'Synthetic handled mail',
      precision: {
        workState: 'action_required', nextActor: 'me',
        operational: { lane: 'do_now', autoConfirmed: true },
      },
      handledElsewhere: { channel, markedAt: '2026-10-01T01:00:00Z' },
    };
    const raw = JSON.stringify(message.precision);
    const node = () => {
      const fields = new Map();
      return {
        dataset: {}, className: '', innerHTML: '', textContent: '',
        classList: { add() {}, remove() {} },
        setAttribute() {}, addEventListener() {}, appendChild() {},
        querySelector(selector) {
          if (!fields.has(selector)) fields.set(selector, node());
          return fields.get(selector);
        },
        querySelectorAll: () => [],
      };
    };
    const detail = node();
    const context = createContext({
      currentMessages: [message], message, selectedMessageId: null,
      document: { createElement: node }, messageDetail: detail, messageList: node(),
      insightFor: () => null,
      operationalLaneLabel,
      precisionSummaryLine: value => `${value.operational.lane}:${value.workState}`,
      legacyToPrecisionState: () => 'review', effectiveStatus: () => 'review',
      statusLabel: value => value, priorityLabel: value => value,
      escapeHtml: value => String(value ?? ''), safeExternalUrl: () => null,
      operationalDetail: () => '', precisionCorrectionPanel: () => '',
      assistantToolPanel: () => '', detailBlock: () => '',
      handledElsewhereControls: node, loadReceivedAttachments() {}, renderActionPanel() {},
      savePrecisionCorrection() {},
    });
    for (const name of ['precisionStateLabel', 'precisionFor', 'messageCard', 'selectMessage']) {
      const source = app.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
      assert.ok(source, `real ${name} source is required`);
      runInContext(source, context);
    }
    const check = () => {
      const card = runInContext('messageCard(message)', context);
      assert.match(card.className, /precision-completed operational-archive/);
      assert.equal(card.querySelector('.status-pill').textContent, `${DISPLAY_LABELS.archive} · 완료`);
      runInContext('selectMessage(message.id)', context);
      assert.ok(detail.innerHTML.includes(`class="status-pill">${DISPLAY_LABELS.archive} · 완료</span>`));
      assert.equal(JSON.stringify(message.precision), raw, 'model provenance is not overwritten');
      assert.equal(JSON.stringify(context.message.precision), raw);
    };
    check();
    // Re-fetch carries the stored marker with the same older classification.
    context.currentMessages = [structuredClone(message)];
    context.message = context.currentMessages[0];
    check();
    context.currentMessages = [];
    assert.match(runInContext('messageCard(message)', context).className, /operational-archive/);
    context.currentMessages = [context.message];
    context.message.handledElsewhere = null;
    const restored = runInContext('messageCard(message)', context);
    assert.match(restored.className, /precision-action-required operational-do-now/);
  });
}
