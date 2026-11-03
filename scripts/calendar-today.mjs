#!/usr/bin/env node
/** Write today's graph-calendar JSON from the loopback Mail endpoint. Does not read the secret store. */
import { writeFileSync } from 'node:fs';
import { CalendarTodayError, CONSENT_MESSAGE, seoulToday } from '../src/calendar-today.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

export async function exportCalendarFile({
  out,
  day = seoulToday(),
  baseUrl = 'http://127.0.0.1:3010',
  fetchImpl = globalThis.fetch,
  accessUser = process.env.MAIL_INTELLIGENCE_ACCESS_USER || 'mailintelligence',
  accessKey = process.env.MAIL_INTELLIGENCE_ACCESS_KEY || '',
}) {
  if (!out) throw new CalendarTodayError('CALENDAR_OUT_REQUIRED');
  const headers = { Accept: 'application/json', Host: '127.0.0.1:3010' };
  if (accessKey) headers.Authorization = `Basic ${Buffer.from(`${accessUser}:${accessKey}`).toString('base64')}`;
  const response = await fetchImpl(`${baseUrl}/api/calendar/today?day=${encodeURIComponent(day)}`, { headers });
  const body = await response.json();
  if (response.status === 403 && body?.code === 'CONSENT_REQUIRED') {
    return { code: 2, message: CONSENT_MESSAGE };
  }
  if (!response.ok || !Array.isArray(body?.value)) throw new CalendarTodayError('CALENDAR_EXPORT_INVALID');
  writeFileSync(out, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  return { code: 0, events: body.value.length, out };
}

if (process.argv[1] && process.argv[1].endsWith('calendar-today.mjs')) {
  const result = await exportCalendarFile({ out: arg('--out'), day: arg('--day') || seoulToday() });
  if (result.code === 2) {
    process.stdout.write(`${result.message}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`wrote ${result.out} events=${result.events}\n`);
  }
}
