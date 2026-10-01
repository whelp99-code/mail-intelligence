import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { messageIdFromHash, messageMatchesHash } from '../src/message-hash.js';

test('reads a message id from the #m= hash and ignores other hashes', () => {
  assert.equal(messageIdFromHash('#m=536'), '536');
  assert.equal(messageIdFromHash('#m=abc%2F1'), 'abc/1');
  assert.equal(messageIdFromHash('#sentMail'), '');
  assert.equal(messageIdFromHash(''), '');
});

test('matches the stored database id and the graph id', () => {
  const message = { id: 'AAMkAGZh', databaseId: 536 };
  assert.equal(messageMatchesHash(message, '536'), true);
  assert.equal(messageMatchesHash(message, 'AAMkAGZh'), true);
  assert.equal(messageMatchesHash(message, '537'), false);
});

test('the mailbox UI selects the hashed message when it is loaded', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ messageIdFromHash, messageMatchesHash \} from '\.\/message-hash\.js'/);
  assert.match(app, /messageIdFromHash\(location\.hash\)/);
  assert.match(app, /messageMatchesHash\(message, fromHash\)/);
  assert.match(app, /selectedMessageId = hashed.id/);
  assert.match(app, /hashchange/);
});
