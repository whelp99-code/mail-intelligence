#!/usr/bin/env node
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.MAIL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:3010';
const limit = Number(process.argv[2] || 5);
const force = process.argv.includes('--force');
const rounds = Number(process.argv.find((item) => item.startsWith('--rounds='))?.slice(9) || 1);

function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(180_000, () => req.destroy(new Error('classification request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function valueOf(text, key) {
  const line = text.split(/\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

const runtime = await readFile(new URL('../data/runtime.env', import.meta.url), 'utf8');
const accessKey = valueOf(runtime, 'MAIL_INTELLIGENCE_ACCESS_KEY');
if (!accessKey) throw new Error('MAIL_INTELLIGENCE_ACCESS_KEY is missing.');
const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}`;

const sessionResponse = await request(`${baseUrl}/api/session`, {
  headers: { Authorization: authorization },
});
if (sessionResponse.status !== 200) throw new Error(`Session failed: HTTP ${sessionResponse.status}`);
const setCookie = sessionResponse.headers['set-cookie'];
const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie || '').split(';')[0];
if (!cookie) throw new Error('Session cookie was not issued.');

const dbIds = String(process.argv.find((item) => item.startsWith('--db-ids='))?.slice(9) || '')
  .split(',')
  .map((item) => Number(item))
  .filter((item) => Number.isInteger(item) && item > 0);
let messageIds = [];
if (dbIds.length) {
  const database = new DatabaseSync(new URL('../data/mail-intelligence.sqlite', import.meta.url).pathname, { readOnly: true });
  const lookup = database.prepare('SELECT graph_id FROM messages WHERE id = ?');
  messageIds = dbIds.map((id) => lookup.get(id)?.graph_id).filter(Boolean);
  database.close();
  if (messageIds.length !== dbIds.length) throw new Error('One or more database ids were not found.');
}

const totals = { processed: 0, accepted: 0, rejected: 0, skipped: 0, rounds: [] };
for (let round = 1; round <= rounds; round += 1) {
  const payload = JSON.stringify({
    limit: messageIds.length || limit,
    force,
    ...(messageIds.length ? { messageIds } : {}),
  });
  const response = await request(`${baseUrl}/api/intelligence/classify-llm`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Mail-Intelligence-Request': '1',
    },
    body: payload,
  });
  const body = JSON.parse(response.text || '{}');
  if (response.status !== 200) {
    console.log(JSON.stringify({
      ok: false,
      status: response.status,
      code: body.code || '',
      message: body.message || '',
      completedRounds: totals.rounds.length,
    }));
    process.exit(1);
  }
  totals.processed += body.processed || 0;
  totals.accepted += body.accepted || 0;
  totals.rejected += body.rejected || 0;
  totals.skipped += body.skipped || 0;
  totals.rounds.push({
    round,
    provider: body.provider,
    model: body.model,
    promptVersion: body.promptVersion,
    analyzedAt: body.analyzedAt,
    processed: body.processed,
    accepted: body.accepted,
    rejected: body.rejected,
    rejectedCodes: body.rejectedCodes || [],
  });
  if (!body.processed) break;
}
console.log(JSON.stringify({ ok: true, ...totals }));
