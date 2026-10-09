import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
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
  assert.equal(runInContext('operationalLaneForMessage("handled-fixture")', context), 'reference');
  messages[0].handledElsewhere = null;
  assert.equal(runInContext('laneForMessage("handled-fixture")', context), 'action_required');
  assert.equal(runInContext('operationalLaneForMessage("handled-fixture")', context), 'do_now');
});
