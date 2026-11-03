import { createServer } from 'node:http';

/** Today's Outlook calendar as graph-calendar JSON. No secret printing. */

export const CONSENT_MESSAGE = '동의 필요';
export const CALENDAR_READ = 'Calendars.Read';

export class CalendarTodayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function seoulToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function nextDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CalendarTodayError('CALENDAR_DAY_INVALID');
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, date));
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== day) {
    throw new CalendarTodayError('CALENDAR_DAY_INVALID');
  }
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function calendarViewUrl(day, graphBaseUrl = 'https://graph.microsoft.com/v1.0') {
  const start = `${day}T00:00:00+09:00`;
  const end = `${nextDay(day)}T00:00:00+09:00`;
  const url = new URL(`${graphBaseUrl.replace(/\/$/, '')}/me/calendarView`);
  url.searchParams.set('startDateTime', start);
  url.searchParams.set('endDateTime', end);
  url.searchParams.set('$top', '100');
  return url;
}

export function refuseCalendarOnTcp() {
  return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found.' } };
}

export function createCalendarSocketServer({ readToday }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/calendar/today' || req.method !== 'GET') {
      const denied = refuseCalendarOnTcp();
      res.writeHead(denied.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(denied.body));
      return;
    }
    try {
      const body = await readToday(url.searchParams.get('day') || seoulToday());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (error) {
      const consent = error instanceof CalendarTodayError && error.code === 'CONSENT_REQUIRED';
      res.writeHead(consent ? 403 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(consent
        ? { code: 'CONSENT_REQUIRED', message: CONSENT_MESSAGE }
        : { code: error instanceof CalendarTodayError ? error.code : 'CALENDAR_READ_FAILED' }));
    }
  });
}

export function requireCalendarRead({ token, scopes }) {
  if (!token || !Array.isArray(scopes) || !scopes.includes(CALENDAR_READ)) {
    throw new CalendarTodayError('CONSENT_REQUIRED');
  }
  if (scopes.includes('Calendars.ReadWrite')) throw new CalendarTodayError('CALENDAR_WRITE_SCOPE');
}

async function graphFetch(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Prefer: 'outlook.timezone="Asia/Seoul"',
    },
  });
  if (!response.ok) throw new CalendarTodayError('GRAPH_CALENDAR_FAILED');
  return response.json();
}

export async function readCalendarToday({
  day,
  token,
  scopes,
  graphBaseUrl = 'https://graph.microsoft.com/v1.0',
  fetchImpl = graphFetch,
}) {
  requireCalendarRead({ token, scopes });
  const base = new URL(graphBaseUrl);
  let nextUrl = calendarViewUrl(day, graphBaseUrl).toString();
  const rows = [];
  for (let page = 0; page < 10 && nextUrl; page += 1) {
    const target = new URL(nextUrl);
    if (target.origin !== base.origin) throw new CalendarTodayError('CALENDAR_LINK_REJECTED');
    const response = await fetchImpl(target, token);
    if (!response || !Array.isArray(response.value)) throw new CalendarTodayError('CALENDAR_EXPORT_INVALID');
    rows.push(...response.value);
    nextUrl = typeof response['@odata.nextLink'] === 'string' ? response['@odata.nextLink'] : '';
  }
  if (nextUrl) throw new CalendarTodayError('CALENDAR_PAGE_LIMIT');
  return { value: rows };
}
