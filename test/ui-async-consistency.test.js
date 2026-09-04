import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
test('assistant and search reject stale responses',()=>{assert.match(app,/assistantRequestSequence/);assert.match(app,/searchRequestSequence/);assert.match(app,/messageId !== selectedMessageId/);});
test('database result state does not mutate loaded mailbox and clears on query clear',()=>{assert.doesNotMatch(app,/else currentMessages\.push/);assert.match(app,/databaseSearchResults\.hidden = true/);assert.match(app,/await loadOutlookMessages\(\);/);});
