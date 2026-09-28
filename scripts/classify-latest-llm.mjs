#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';

const baseUrl = process.env.MAIL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:3010';
const limit = Number(process.argv[2] || 5);
const force = process.argv.includes('--force');
const rounds = Number(process.argv.find((item) => item.startsWith('--rounds='))?.slice(9) || 1);
const dispatcher = new Agent({
  connectTimeout: 30_000,
  headersTimeout: 180_000,
  bodyTimeout: 180_000,
});

function valueOf(text, key) {
  const line = text.split(/\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

const runtime = await readFile(new URL('../data/runtime.env', import.meta.url), 'utf8');
const accessKey = valueOf(runtime, 'MAIL_INTELLIGENCE_ACCESS_KEY');
if (!accessKey) throw new Error('MAIL_INTELLIGENCE_ACCESS_KEY is missing.');
const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}`;

const sessionResponse = await undiciFetch(`${baseUrl}/api/session`, {
  dispatcher,
  headers: { Authorization: authorization },
});
if (!sessionResponse.ok) throw new Error(`Session failed: HTTP ${sessionResponse.status}`);
const cookie = String(sessionResponse.headers.get('set-cookie') || '').split(';')[0];
if (!cookie) throw new Error('Session cookie was not issued.');

const totals = { processed: 0, accepted: 0, rejected: 0, skipped: 0, rounds: [] };
for (let round = 1; round <= rounds; round += 1) {
  const response = await undiciFetch(`${baseUrl}/api/intelligence/classify-llm`, {
    dispatcher,
    method: 'POST',
    headers: {
      Authorization: authorization,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Mail-Intelligence-Request': '1',
    },
    body: JSON.stringify({ limit, force }),
  });
  const body = await response.json();
  if (!response.ok) {
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
