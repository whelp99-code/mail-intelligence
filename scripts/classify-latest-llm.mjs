#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.MAIL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:3010';
const limit = Number(process.argv[2] || 30);
const force = process.argv.includes('--force');

function valueOf(text, key) {
  const line = text.split(/\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

const runtime = await readFile(new URL('../data/runtime.env', import.meta.url), 'utf8');
const accessKey = valueOf(runtime, 'MAIL_INTELLIGENCE_ACCESS_KEY');
if (!accessKey) throw new Error('MAIL_INTELLIGENCE_ACCESS_KEY is missing.');
const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}`;

const sessionResponse = await fetch(`${baseUrl}/api/session`, {
  headers: { Authorization: authorization },
});
if (!sessionResponse.ok) throw new Error(`Session failed: HTTP ${sessionResponse.status}`);
const cookie = String(sessionResponse.headers.get('set-cookie') || '').split(';')[0];
if (!cookie) throw new Error('Session cookie was not issued.');

const response = await fetch(`${baseUrl}/api/intelligence/classify-llm`, {
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
  }));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  provider: body.provider,
  model: body.model,
  promptVersion: body.promptVersion,
  analyzedAt: body.analyzedAt,
  processed: body.processed,
  accepted: body.accepted,
  rejected: body.rejected,
  skipped: body.skipped,
  acceptedIds: body.acceptedIds,
  rejectedCodes: body.rejectedCodes,
}));
