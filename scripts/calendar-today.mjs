#!/usr/bin/env node
/** Write today's graph-calendar JSON from the Mail process socket. Does not open TCP or the secret store. */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { CalendarTodayError, CONSENT_MESSAGE, seoulToday } from '../src/calendar-today.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

function requestSocket(socketPath, day) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: `/api/calendar/today?day=${encodeURIComponent(day)}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function exportCalendarFile({
  out,
  day = seoulToday(),
  socketPath = process.env.MAIL_INTELLIGENCE_CALENDAR_SOCKET || '',
  requestImpl = requestSocket,
}) {
  if (!out) throw new CalendarTodayError('CALENDAR_OUT_REQUIRED');
  if (!socketPath) throw new CalendarTodayError('CALENDAR_SOCKET_REQUIRED');
  const response = await requestImpl(socketPath, day);
  if (response.status === 403 && response.body?.code === 'CONSENT_REQUIRED') {
    return { code: 2, message: CONSENT_MESSAGE };
  }
  if (response.status !== 200 || !Array.isArray(response.body?.value)) {
    throw new CalendarTodayError('CALENDAR_EXPORT_INVALID');
  }
  writeFileSync(out, `${JSON.stringify(response.body)}\n`, { mode: 0o600 });
  return { code: 0, events: response.body.value.length, out };
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
