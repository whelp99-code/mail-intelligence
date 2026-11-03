import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CalendarTodayError,
  assertLoopbackHost,
  calendarViewUrl,
  readCalendarToday,
  requireCalendarRead,
} from '../src/calendar-today.js';
import { exportCalendarFile } from '../scripts/calendar-today.mjs';

const DAY = '2026-11-03';

function event(id, start) {
  return { id, subject: id, start: { dateTime: start, timeZone: 'Asia/Seoul' }, end: { dateTime: start, timeZone: 'Asia/Seoul' } };
}

test('calendar view uses the Seoul day and rejects a non-loopback host', () => {
  const url = calendarViewUrl(DAY);
  assert.equal(url.searchParams.get('startDateTime'), '2026-11-03T00:00:00+09:00');
  assert.equal(url.searchParams.get('endDateTime'), '2026-11-04T00:00:00+09:00');
  assert.equal(assertLoopbackHost('127.0.0.1:3010'), undefined);
  assert.throws(() => assertLoopbackHost('100.64.0.2:3010'), /CALENDAR_HOST_REJECTED/);
});

test('fake calendar pages keep zero, one, and many events', async () => {
  const cases = [
    { value: [] },
    { value: [event('one', '2026-11-03T09:00:00+09:00')] },
    { value: [event('a', '2026-11-03T09:00:00+09:00')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=2' },
  ];
  const second = { value: [event('b', '2026-11-03T11:00:00+09:00')] };
  for (const page of cases) {
    const seen = [];
    const document = await readCalendarToday({
      day: DAY,
      token: 'synthetic-access',
      scopes: ['Mail.Read', 'Calendars.Read'],
      fetchImpl: async (url) => {
        seen.push(url.toString());
        return url.searchParams.get('page') === '2' ? second : page;
      },
    });
    assert.equal(document.value.length, page['@odata.nextLink'] ? 2 : page.value.length);
    assert.equal(seen[0].includes('calendarView'), true);
  }
});

test('missing token or scope does not call Graph', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { value: [] };
  };
  for (const input of [
    { token: '', scopes: ['Calendars.Read'] },
    { token: 'synthetic-access', scopes: ['Mail.Read'] },
  ]) {
    await assert.rejects(
      readCalendarToday({ day: DAY, ...input, fetchImpl }),
      (error) => error instanceof CalendarTodayError && error.code === 'CONSENT_REQUIRED',
    );
  }
  assert.equal(called, false);
  assert.throws(() => requireCalendarRead({ token: 'synthetic-access', scopes: ['Calendars.Read', 'Calendars.ReadWrite'] }), /CALENDAR_WRITE_SCOPE/);
});

test('cli writes the endpoint file and prints consent without a secret store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-today-'));
  const out = join(dir, 'calendar.json');
  const written = await exportCalendarFile({
    out,
    day: DAY,
    accessKey: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ value: [event('one', '2026-11-03T09:00:00+09:00')] }) }),
  });
  assert.equal(written.events, 1);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).value[0].subject, 'one');
  const consent = await exportCalendarFile({
    out,
    day: DAY,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ code: 'CONSENT_REQUIRED' }) }),
  });
  assert.equal(consent.code, 2);
  assert.equal(consent.message, '동의 필요');
});
