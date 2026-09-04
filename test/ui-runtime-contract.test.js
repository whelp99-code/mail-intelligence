import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
test('UI decodes relay and canonical empty state safely',()=>{assert.match(app,/async function readApiPayload/);assert.match(app,/READ_ONLY_RELAY_BLOCKED/);assert.match(app,/function emptyResult/);assert.match(app,/response.status === 204/);});
test('pre-load UI state is canonical before asynchronous analyze completes',()=>{assert.match(app,/let currentResult = emptyResult\(\);/);assert.match(app,/let currentMessages = \[\];/);assert.match(app,/let visibleMessages = \[\];/);assert.match(app,/let selectedMessageId = '';/);});
test('UI keys selection panels and card highlight by message identity',()=>{assert.match(app,/selectedMessageId = ''/);assert.match(app,/action.messageId === selectedMessageId/);assert.match(app,/dataset\.messageId/);assert.match(app,/node\.dataset\.messageId === String\(messageId\)/);});
test('Clear Config changes local fields only after DELETE succeeds',()=>{assert.match(app,/if \(!response\.ok\) throw new Error/);assert.doesNotMatch(app,/previousConfig/);});
test('domain profile is loaded and saved with server-supported config',()=>{assert.match(app,/const domainProfile = document\.querySelector\('#domainProfile'\)/);assert.match(app,/domainProfile\.value = status\.domainProfile/);assert.match(app,/domainProfile: domainProfile\.value/);});
