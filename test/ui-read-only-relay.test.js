import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
test('read-only relay is typed only for the 405 text relay marker',()=>{assert.match(app,/code: 'READ_ONLY_RELAY_BLOCKED'/);assert.match(app,/text\\\/plain/);assert.match(app,/MAIL_BROWSER_RELAY_READ_ONLY/);});
