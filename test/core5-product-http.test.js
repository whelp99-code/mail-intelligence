import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startIsolatedProductServer } from './helpers/core5-isolated-product-server.js';

test('Core5 actual Mail HTTP: draft, denial, cancellation and restart persistence', { timeout: 20000 }, async () => {
  const product = await startIsolatedProductServer();
  const request = (path, headers, data) => fetch(product.base + '/api/mail/send-drafts' + path, {
    method: data === undefined ? 'GET' : 'POST', headers,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(3000),
  });
  try {
    let operator = await product.login();
    assert.equal(operator.session.capabilities.sendMail, false);
    const input = { request_id: 'core5-http-restart-001', to: ['synthetic@example.com'], subject: 'Core5 isolated product', body_text: 'Synthetic record. No external send.' };
    const created = await request('', product.bot, input);
    assert.equal(created.status, 201);
    const { draft } = await created.json();
    assert.equal(draft.status, 'needs_approval');
    const replay = await request('', product.bot, input);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).draft.draft_id, draft.draft_id);
    const path = '/' + draft.draft_id;
    const approval = { confirm: true, payload_digest: draft.payload_digest };
    assert.equal((await request(path + '/approve', { ...operator.human, ...product.bot }, approval)).status, 403);
    assert.equal((await request(path + '/cancel', { ...operator.human, 'X-CSRF-Token': '' }, {})).status, 403);
    assert.equal((await request(path + '/cancel', { ...operator.human, Origin: 'https://invalid.example' }, {})).status, 403);
    const deniedSend = await request(path + '/approve', operator.human, approval);
    assert.equal(deniedSend.status, 403);
    assert.equal((await deniedSend.json()).code, 'MAIL_SEND_DISABLED');
    assert.equal((await (await request(path, product.bot)).json()).draft.status, 'needs_approval');
    const cancelled = await request(path + '/cancel', operator.human, {});
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).draft.status, 'cancelled');
    await product.restart();
    operator = await product.login();
    const restored = await request(path, product.bot);
    assert.equal(restored.status, 200);
    const persisted = (await restored.json()).draft;
    assert.equal(persisted.status, 'cancelled');
    assert.equal(persisted.sent_at, null);
    const list = await request('', operator.human);
    assert.equal((await list.json()).drafts.filter(row => row.draft_id === draft.draft_id).length, 1);
    const db = new DatabaseSync(join(product.directory, 'mail-intelligence.sqlite'), { readOnly: true });
    try {
      const countByStatus = db.prepare('SELECT count(*) AS n FROM mail_send_draft_events WHERE status = ?');
      assert.equal(countByStatus.get('cancelled').n, 1);
      assert.equal(countByStatus.get('sent').n, 0);
    } finally { db.close(); }
    assert.equal(product.secretsLeaked(), false);
  } finally { await product.close(); }
});
