import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function portAvailable() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close(); await once(server, 'close');
  return port;
}

for (const allowSend of [false, true]) {
  test(`real server draft API, send flag ${allowSend ? 'ON' : 'OFF'}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mail-send-http-'));
    const port = await portAvailable();
    const base = `http://127.0.0.1:${port}`;
    const operatorKey = 'fixture-operator-key-012345678901234567890123';
    const draftKey = 'fixture-service-key-012345678901234567890123';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), MAIL_INTELLIGENCE_HOST: '127.0.0.1', MAIL_INTELLIGENCE_DATA_DIR: directory,
        MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey, MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: draftKey,
        MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE: '', MAIL_INTELLIGENCE_ALLOW_SEND: allowSend ? '1' : '0',
        MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0', OUTLOOK_GRAPH_ACCESS_TOKEN: 'opaque-fixture-without-send-scope', MAIL_INTELLIGENCE_PERSIST_SECRETS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(base + '/api/health')).ok) { healthy = true; break; } } catch { /* Startup race only. */ }
      await delay(50);
    }
    assert.equal(healthy, true, 'Isolated server should start');
    const root = await fetch(base, { headers: { Authorization: 'Basic ' + Buffer.from('mailintelligence:' + operatorKey).toString('base64') } });
    const Cookie = root.headers.get('set-cookie').split(';')[0]; await root.arrayBuffer();
    const session = await (await fetch(base + '/api/session', { headers: { Cookie } })).json();
    assert.equal(session.capabilities.sendMail, allowSend);
    assert.equal(session.capabilities.markRead, false);
    assert.equal(session.capabilities.dataPlane, false);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + draftKey };
    const created = await fetch(base + '/api/mail/send-drafts', { method: 'POST', headers, body: JSON.stringify({ request_id: 'http-fixture-001', to: ['self@example.com'], subject: 'HTTP fixture', body_text: 'Never sent by this test.' }) });
    assert.equal(created.status, 201);
    const { draft } = await created.json();
    assert.equal(draft.status, 'needs_approval');
    const approval = { confirm: true, payload_digest: draft.payload_digest };
    const url = base + '/api/mail/send-drafts/' + draft.draft_id + '/approve';
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Cookie, Origin: base, 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(approval) })).status, 403);
    const human = { Cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
    const rejected = await fetch(url, { method: 'POST', headers: human, body: JSON.stringify(approval) });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, allowSend ? 'MAIL_SEND_SCOPE_REQUIRED' : 'MAIL_SEND_DISABLED');
    const missingCsrf = await fetch(url, { method: 'POST', headers: { ...human, 'X-CSRF-Token': '' }, body: JSON.stringify(approval) });
    assert.equal(missingCsrf.status, 403);
    const state = await (await fetch(base + '/api/mail/send-drafts/' + draft.draft_id, { headers })).json();
    assert.equal(state.draft.status, 'needs_approval');
    assert.equal(state.draft.sent_at, null);
    assert.equal(logs.join('').includes(draftKey), false);
    assert.equal(logs.join('').includes(operatorKey), false);
  });
}
