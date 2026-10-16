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

test('handled records retain actor, time and undo in the real card and detail controls', () => {
  const node = () => ({
    dataset: {}, children: [], fields: new Map(), events: new Map(), textContent: '',
    classList: { add() {} },
    setAttribute() {},
    addEventListener(name, callback) { this.events.set(name, callback); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      if (!this.fields.has(selector)) this.fields.set(selector, node());
      return this.fields.get(selector);
    },
  });
  const calls = [];
  const context = createContext({
    document: { createElement: node }, operationalLaneLabel,
    insightFor: () => null,
    precisionFor: () => ({ workState: 'completed', operational: { lane: 'archive' } }),
    precisionSummaryLine: () => '',
    selectedMessageId: null,
    saveHandledElsewhere: (...args) => calls.push(args),
  });
  runInContext(app.match(/const HANDLED_CHANNELS = \[[\s\S]*?\n\];/)[0], context);
  for (const name of ['handledChannelLabel', 'handledElsewhereControls', 'precisionStateLabel', 'messageCard']) {
    const source = app.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `real ${name} source is required`);
    runInContext(source, context);
  }
  for (const channel of ['kakao', 'phone', 'in_person', 'other']) {
    const marker = {
      channel, note: 'Synthetic handling note', actor: 'session:fixture-operator',
      markedAt: '2026-10-16T00:00:00Z',
    };
    context.message = { id: `handled-${channel}`, replyGap: false, handledElsewhere: marker };
    const card = runInContext('messageCard(message)', context);
    const compact = card.children.find(child => child.className === 'handled-elsewhere');
    assert.ok(compact, 'a saved record stays accessible after leaving the reply gap');
    const detail = runInContext('handledElsewhereControls(message)', context);
    for (const controls of [compact, detail]) {
      const note = controls.children.find(child => child.className === 'handled-note');
      assert.ok(note.textContent.includes(marker.actor));
      assert.ok(note.textContent.includes(new Date(marker.markedAt).toLocaleString('ko-KR')));
      assert.ok(note.textContent.includes(marker.note));
      const undo = controls.children.find(child => child.events.has('click'));
      undo.events.get('click')();
      assert.equal(calls.at(-1)[0], context.message.id);
      assert.equal(calls.at(-1)[1].undo, true);
    }
    assert.equal(card.children.some(child => child.className === 'reply-gap'), false);
  }
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
      insightFor: () => ({ nextActions: [{ id: 'cached-reply' }] }),
      operationalLaneLabel,
      precisionSummaryLine: value => `${value.operational.lane}:${value.workState}`,
      legacyToPrecisionState: () => 'review', effectiveStatus: () => 'review',
      statusLabel: value => value, priorityLabel: value => value,
      escapeHtml: value => String(value ?? ''), safeExternalUrl: () => null,
      operationalDetail: () => '', precisionCorrectionPanel: () => '',
      assistantToolPanel: () => '', detailBlock: () => '', feedbackPanel: () => '',
      handledElsewhereControls: node, loadReceivedAttachments() {},
      savePrecisionCorrection() {},
      currentResult: { calendar: [], reminders: [] },
      actionList: node(), calendarList: node(), reminderList: node(),
      actionCount: node(), calendarCount: node(), reminderCount: node(),
      clear: element => { element.innerHTML = ''; }, empty: node,
      actionVisible: () => true, scenarioActionCard: node, simpleCard: node,
    });
    for (const name of ['precisionStateLabel', 'precisionFor', 'messageCard', 'selectMessage', 'renderActionPanel']) {
      const source = app.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
      assert.ok(source, `real ${name} source is required`);
      runInContext(source, context);
    }
    const check = () => {
      const card = runInContext('messageCard(message)', context);
      assert.match(card.className, /precision-completed operational-archive/);
      assert.equal(card.querySelector('.status-pill').textContent, `처리 상태 ${DISPLAY_LABELS.archive}`);
      runInContext('selectMessage(message.id)', context);
      assert.ok(detail.innerHTML.includes('class="status-pill">archive:completed'));
      assert.equal(Number.parseInt(context.actionCount.textContent, 10), 0);
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
    runInContext('renderActionPanel()', context);
    assert.equal(Number.parseInt(context.actionCount.textContent, 10), 1);
  });
}
