import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createAllowlistedTcpProxy, parseIpv4Cidr } from '../src/security/tcp-allowlist-proxy.js';
import {
  CalendarTodayError,
  calendarViewUrl,
  createCalendarSocketServer,
  readCalendarToday,
  refuseCalendarOnTcp,
  requireCalendarRead,
} from '../src/calendar-today.js';
import { exportCalendarFile } from '../scripts/calendar-today.mjs';

const DAY = '2026-11-03';

function event(id, start) {
  return { id, subject: id, start: { dateTime: start, timeZone: 'Asia/Seoul' }, end: { dateTime: start, timeZone: 'Asia/Seoul' } };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

test('calendar view uses the Seoul day', () => {
  const url = calendarViewUrl(DAY);
  assert.equal(url.searchParams.get('startDateTime'), '2026-11-03T00:00:00+09:00');
  assert.equal(url.searchParams.get('endDateTime'), '2026-11-04T00:00:00+09:00');
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

test('tailnet proxy Host forgery cannot read the calendar', async (t) => {
  let graphCalled = false;
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, remoteAddress: req.socket.remoteAddress });
    const denied = refuseCalendarOnTcp();
    res.writeHead(denied.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(denied.body));
  });
  const backendAddress = await listen(backend);
  t.after(() => backend.close());
  const proxy = createAllowlistedTcpProxy({
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: backendAddress.port,
    allowedCidrs: [parseIpv4Cidr('127.0.0.0/8')],
    maxConnections: 4,
    idleTimeoutMs: 5_000,
  });
  const proxyAddress = await proxy.listen();
  t.after(() => proxy.close());

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyAddress.port,
      path: '/api/calendar/today',
      headers: { Host: '127.0.0.1:3010', Accept: 'application/json' },
    }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(seen[0].host, '127.0.0.1:3010');
  assert.match(String(seen[0].remoteAddress), /127\.0\.0\.1/);
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'NOT_FOUND');
  assert.equal(response.body.value, undefined);
  assert.equal(graphCalled, false);
  const serverSource = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  assert.equal(serverSource.includes('assertLoopbackHost'), false);
  assert.match(serverSource, /pathname === '\/api\/calendar\/today'[\s\S]{0,180}refuseCalendarOnTcp\(\)/);
  assert.match(serverSource, /\[calendar\] socket not opened: \$\{error\?\.code \|\| 'LISTEN_FAILED'\}/);
});

test('calendar socket is mode 600 and the cli does not open a secret store', async () => {
  // GitHub's workspace makes tmpdir() longer than the 108-byte unix socket limit.
  // Node still emits listening, then chmod sees ENOENT. Keep this path short.
  const dir = mkdtempSync(join('/tmp', 'cal-'));
  const socketPath = join(dir, 'calendar.sock');
  const out = join(dir, 'calendar.json');
  const socketServer = createCalendarSocketServer({
    readToday: async () => ({ value: [event('one', '2026-11-03T09:00:00+09:00')] }),
  });
  try {
    const listening = once(socketServer, 'listening');
    socketServer.listen(socketPath);
    await listening;
    await new Promise((resolve, reject) => chmod(socketPath, 0o600, (error) => error ? reject(error) : resolve()));
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    const written = await exportCalendarFile({ out, day: DAY, socketPath });
    assert.equal(written.events, 1);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).value[0].subject, 'one');
    const consent = await exportCalendarFile({
      out,
      day: DAY,
      socketPath,
      requestImpl: async () => ({ status: 403, body: { code: 'CONSENT_REQUIRED' } }),
    });
    assert.equal(consent.code, 2);
    assert.equal(consent.message, '동의 필요');
  } finally {
    await new Promise((resolve) => socketServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
