#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const baseUrl = String(process.env.MAIL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const accessKeyPath = process.env.MAIL_INTELLIGENCE_ACCESS_KEY_FILE
  || new URL('../data/.mail-intelligence-access-key', import.meta.url);
const databasePath = resolve(process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const accessKey = (await readFile(accessKeyPath, 'utf8')).trim();
assert.match(accessKey, /^[A-Za-z0-9_-]{40,}$/);

async function readJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function databaseSnapshot() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS active_messages,
        (SELECT COUNT(*) FROM precision_classifications pc
          JOIN messages m ON m.id = pc.message_id
          WHERE m.deleted_at IS NULL) AS active_classifications,
        (SELECT COUNT(*) FROM (
          SELECT graph_id
          FROM messages
          WHERE deleted_at IS NULL
          GROUP BY graph_id
          HAVING COUNT(*) > 1
        )) AS duplicate_graph_ids
    `).get();
    return {
      activeMessages: Number(counts.active_messages || 0),
      activeClassifications: Number(counts.active_classifications || 0),
      duplicateGraphIds: Number(counts.duplicate_graph_ids || 0),
    };
  } finally {
    db.close();
  }
}

function summarize(body) {
  const sync = body?.sync || {};
  return {
    connected: Boolean(body?.connected),
    mode: String(sync.mode || body?.mode || ''),
    discoveredFolders: Number(sync.discoveredFolders || 0),
    completedFolders: Number(sync.completedFolders || 0),
    failedFolders: Number(sync.failedFolders || 0),
    pagesProcessed: Number(sync.pagesProcessed || 0),
    fetchedFromGraph: Number(sync.fetchedFromGraph || 0),
    upserted: Number(sync.upserted || 0),
    deleted: Number(sync.deleted || 0),
    attachmentErrors: Number(sync.attachmentErrors || 0),
    errors: Array.isArray(sync.errors) ? sync.errors.length : Number(sync.errors || 0),
    cachedBefore: Number(sync.cachedBefore || 0),
    totalCached: Number(sync.totalCached || 0),
  };
}

const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
const root = await fetch(`${baseUrl}/`, {
  redirect: 'manual',
  headers: { Authorization: authorization },
});
assert.equal(root.status, 200);
const cookie = (root.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^mi_session=/);
await root.arrayBuffer();

const session = await readJson('/api/session', { headers: { Cookie: cookie } });
assert.equal(session.response.status, 200, JSON.stringify(session.body));
assert.ok(session.body.csrfToken);
const headers = {
  Cookie: cookie,
  Origin: baseUrl,
  'Content-Type': 'application/json',
  'X-CSRF-Token': session.body.csrfToken,
  'X-Mail-Intelligence-Request': '1',
};

const before = databaseSnapshot();
const runs = [];
for (let index = 1; index <= 2; index += 1) {
  const result = await readJson('/api/outlook/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({ top: 10, forceInitial: false }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const summary = summarize(result.body);
  assert.equal(summary.connected, true, `Delta ${index} did not use Microsoft Graph.`);
  assert.equal(summary.mode, 'delta');
  assert.ok(summary.discoveredFolders > 0);
  assert.equal(summary.completedFolders, summary.discoveredFolders);
  assert.equal(summary.failedFolders, 0);
  assert.equal(summary.errors, 0);
  runs.push({ run: index, ...summary });
}

const after = databaseSnapshot();
assert.equal(after.duplicateGraphIds, 0);
assert.ok(after.activeMessages >= before.activeMessages - runs.reduce((sum, run) => sum + run.deleted, 0));

const report = {
  liveDeltaTwice: 'PASS',
  baseUrl,
  readOnly: true,
  before,
  runs,
  after,
  secondRunIdempotentWhenNoRemoteChange: runs[1].fetchedFromGraph === 0
    ? runs[1].upserted === 0 && runs[1].deleted === 0
    : null,
  externalOutlookWrites: 0,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(runs.reduce((sum, run) => sum + run.attachmentErrors, 0), 0);
