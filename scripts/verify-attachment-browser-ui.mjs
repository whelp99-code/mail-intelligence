import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { access, constants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessAuthorizationHeader } from '../src/security/access-user.js';

const ARTIFACT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../artifacts/attachments-acceptance');
const CJK_NAME = '검토용-첨부-파일.txt';
const OVERSIZE_NAME = '초과파일.txt';
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

async function resolveChrome(env = process.env) {
  const candidates = env.MAIL_INTELLIGENCE_CHROME
    ? [env.MAIL_INTELLIGENCE_CHROME]
    : ['google-chrome', 'google-chrome-stable'].flatMap((name) => (
      (env.PATH || '').split(delimiter).filter(Boolean).map((directory) => join(directory, name))
    )).concat('/opt/google/chrome/chrome');
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; }
    catch { /* Try the next installed executable; an explicit override never falls back. */ }
  }
  throw new Error(`No executable Chrome found; set MAIL_INTELLIGENCE_CHROME. Tried: ${candidates.join(', ')}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForOutput(child, stream, marker, timeoutMs = 10_000) {
  await new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`${marker}: process exited ${signal || code}`)); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(new Error(`${marker}: startup timeout`)); };
    const timer = setTimeout(onAbort, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    stream.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

function collectOutput(child, limit = 12_000) {
  let text = '';
  const append = (chunk) => {
    text += chunk;
    if (text.length > limit) text = text.slice(-limit);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (code, signal) => append(`\nprocess exited: code=${code} signal=${signal}\n`));
  return () => text;
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2_000) });
    child.kill('SIGTERM');
    try { await exited; }
    catch {
      if (child.exitCode === null && child.signalCode === null) {
        const killed = once(child, 'exit', { signal: AbortSignal.timeout(2_000) });
        child.kill('SIGKILL');
        await killed;
      }
    }
  }
}

function attachCdp(ws, timeoutMs = 12_000) {
  const pending = new Map();
  const events = [];
  let nextId = 0;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result || {});
    } else if (message.method) {
      events.push(message);
    }
  });
  const failPending = () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('DevTools connection closed or failed'));
    }
    pending.clear();
  };
  ws.addEventListener('close', failPending);
  ws.addEventListener('error', failPending);
  const send = async (method, params = {}) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('DevTools connection is not open');
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools command timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  };
  send.events = events;
  return send;
}

async function evaluate(cdp, expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 8_000) {
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const check = () => { try { return (${expression}); } catch (error) { reject(error); return null; } };
    const current = check();
    if (current) { resolve(current); return; }
    const observer = new MutationObserver(() => {
      const value = check();
      if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('UI state timeout')); }, ${timeoutMs});
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
}

async function setInputFiles(cdp, selector, files) {
  const document = await cdp('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector });
  assert.ok(nodeId, `missing ${selector}`);
  await cdp('DOM.setFileInputFiles', { nodeId, files });
}

function fontsConf(cacheDir) {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <!-- Scan system fonts recursively, including Arch's noto-cjk and Debian's noto directories.
       Never include the user's font configuration or home font directories. -->
  <dir>/usr/share/fonts</dir>
  <cachedir>${cacheDir}</cachedir>
  <alias>
    <family>sans-serif</family>
    <prefer><family>Noto Sans CJK KR</family></prefer>
  </alias>
</fontconfig>
`;
}

test('cleanup completes for an already signal-terminated child', { timeout: 4_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGTERM');
  await stopChild(child);
});

test('browser discovery honors explicit override and executable PATH order', async (t) => {
  const directory = await mkdtemp('/var/tmp/mi-chrome-path-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stable = join(directory, 'google-chrome-stable');
  const chrome = join(directory, 'google-chrome');
  const override = join(directory, 'chromium');
  await writeFile(stable, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(await resolveChrome({ PATH: directory }), stable);
  await writeFile(chrome, '#!/bin/sh\n', { mode: 0o600 });
  assert.equal(await resolveChrome({ PATH: directory }), stable, 'non-executable files are not browsers');
  await rm(chrome);
  await writeFile(chrome, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(await resolveChrome({ PATH: directory }), chrome);
  await writeFile(override, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(await resolveChrome({ PATH: directory, MAIL_INTELLIGENCE_CHROME: override }), override);
  await assert.rejects(resolveChrome({ PATH: directory, MAIL_INTELLIGENCE_CHROME: join(directory, 'missing') }), /No executable Chrome found/);
});

test('startup rejects spawn errors, early exit, and missing readiness markers', async (t) => {
  const missing = spawn('/nonexistent/mi-fixture-browser', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  await assert.rejects(waitForOutput(missing, missing.stderr, 'ready'), /ENOENT/);
  const exited = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(exited, 'exit');
  await assert.rejects(waitForOutput(exited, exited.stderr, 'ready'), /process exited 7/);
  const silent = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => stopChild(silent));
  await assert.rejects(waitForOutput(silent, silent.stderr, 'ready', 20), /startup timeout/);
  assert.equal(silent.stderr.listenerCount('data'), 0);
  assert.equal(silent.listenerCount('error'), 0);
});

test('DevTools settles replies, protocol errors, disconnects, and stalled commands', async () => {
  class FixtureSocket extends EventTarget {
    readyState = WebSocket.OPEN;
    send(message) { this.last = JSON.parse(message); }
    reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  }
  const ws = new FixtureSocket();
  const cdp = attachCdp(ws, 20);
  const success = cdp('Page.enable');
  ws.reply({ id: ws.last.id, result: { enabled: true } });
  assert.deepEqual(await success, { enabled: true });
  const failure = cdp('Invalid.command');
  ws.reply({ id: ws.last.id, error: { message: 'unsupported' } });
  await assert.rejects(failure, /unsupported/);
  const closed = cdp('Runtime.evaluate');
  ws.dispatchEvent(new Event('close'));
  await assert.rejects(closed, /connection closed/);
  const errored = cdp('Page.navigate');
  ws.dispatchEvent(new Event('error'));
  await assert.rejects(errored, /connection closed or failed/);
  await assert.rejects(cdp('Page.captureScreenshot'), /DevTools command timeout: Page.captureScreenshot/);
  ws.readyState = WebSocket.CLOSED;
  await assert.rejects(cdp('Page.enable'), /not open/);
});

test('isolated Chrome drives file input, errors, download, keyboard, and CJK labels', { timeout: 60_000 }, async (t) => {
  const chromePath = await resolveChrome();
  const directory = await mkdtemp(join('/var/tmp', 'mi-g8-'));
  const children = [];
  t.after(async () => {
    for (const child of children) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  });
  const profile = join(directory, 'chrome');
  const downloads = join(directory, 'downloads');
  const fontCache = join(directory, 'fontconfig-cache');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  await mkdir(fontCache, { recursive: true, mode: 0o700 });
  const fontConfig = join(directory, 'fonts.conf');
  await writeFile(fontConfig, fontsConf(fontCache));
  const fontEnv = {
    ...process.env,
    HOME: directory,
    FONTCONFIG_FILE: fontConfig,
    FONTCONFIG_PATH: directory,
    XDG_CACHE_HOME: join(directory, 'cache'),
  };
  const matchedFont = execFileSync('fc-match', ['-f', '%{family}\n%{file}', 'Noto Sans CJK KR'], { env: fontEnv, encoding: 'utf8' });
  assert.match(matchedFont.split('\n')[0], /\bNoto Sans CJK KR\b/, 'install system Noto Sans CJK KR fonts before running this gate');
  await access(matchedFont.split('\n')[1], constants.R_OK);
  t.diagnostic(`browser=${chromePath}; font=${matchedFont}`);
  const cjkPath = join(directory, CJK_NAME);
  const oversizePath = join(directory, OVERSIZE_NAME);
  const scannerPath = join(directory, 'gated-scan.sh');
  const scanGate = join(directory, 'scan-gate');
  await writeFile(cjkPath, 'synthetic-g8-cjk\n');
  await writeFile(oversizePath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61));
  execFileSync('mkfifo', [scanGate]);
  await writeFile(scannerPath, `#!/bin/sh\nread -r answer < "${scanGate}"\nexit 0\n`, { mode: 0o700 });

  const appPort = await freePort();
  const debugPort = await freePort();
  const operatorKey = 'fixture-operator-key-012345678901234567890123';
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: directory,
      MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: 'fixture-service-key-012345678901234567890123',
      MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE: '',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_ATTACHMENTS_ENABLED: '1',
      MAIL_DRIVE_ENABLED: '0',
      MAIL_ATTACHMENT_KEY: '11'.repeat(32),
      MAIL_ATTACHMENT_SCANNER_COMMAND: scannerPath,
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'opaque-fixture-without-send-scope',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(app);
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--font-render-hinting=none',
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
  ], {
    env: {
      ...fontEnv,
      // Chrome's SingletonSocket must fit a Unix socket path; release TMPDIRs
      // can exceed that limit. Keep its sockets in this short owned fixture.
      TMPDIR: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.unshift(chrome);
  const appReady = waitForOutput(app, app.stdout, `app running at http://127.0.0.1:${appPort}`);
  const chromeReady = waitForOutput(chrome, chrome.stderr, 'DevTools listening on');
  const appLog = collectOutput(app);
  const chromeLog = collectOutput(chrome);
  t.after(() => {
    t.diagnostic(`app=${appLog()}\nchrome=${chromeLog()}`);
  });

  try {
    await Promise.all([appReady, chromeReady]);
  } catch (error) {
    throw new Error(`${error.message}\napp=${appLog()}\nchrome=${chromeLog()}`);
  }

  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
    method: 'PUT', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.status, 200, 'DevTools must create a page target');
  const created = await response.json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  t.after(() => { try { ws.close(); } catch { /* closed */ } });
  await once(ws, 'open', { signal: AbortSignal.timeout(8_000) });
  const cdp = attachCdp(ws);
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('DOM.enable');
  await cdp('Network.setExtraHTTPHeaders', {
    headers: { Authorization: accessAuthorizationHeader(operatorKey) },
  });
  try {
    await cdp('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true,
    });
  } catch {
    await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  }

  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/#sendDraftReview` });
  await waitFor(cdp, `(() => {
    const summary = document.querySelector('.send-compose summary');
    const compose = document.querySelector('.send-compose');
    if (summary && compose && !compose.open) summary.click();
    return Boolean(document.getElementById('attachLocalFiles') && document.getElementById('attachmentFileInput'));
  })()`);

  await evaluate(cdp, 'document.fonts.load(\'16px "Noto Sans CJK KR"\', \'발송초안검토첨부파일\')');
  const fonts = await evaluate(cdp, `({
    check: document.fonts.check('16px "Noto Sans CJK KR"', '첨부'),
    family: getComputedStyle(document.body).fontFamily,
  })`);
  assert.match(fonts.family, /Noto Sans CJK KR/);
  assert.equal(fonts.check, true, 'headless Chrome must resolve Noto Sans CJK KR for Korean labels');

  await evaluate(cdp, 'document.getElementById("sendDraftTo").focus()');
  let reachedAttach = false;
  for (let step = 0; step < 16; step += 1) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focused = await evaluate(cdp, 'document.activeElement?.id || ""');
    if (focused === 'attachLocalFiles') {
      reachedAttach = true;
      break;
    }
  }
  assert.equal(reachedAttach, true, 'Tab order must reach PC 파일 첨부');

  await waitFor(cdp, 'document.getElementById(\'attachmentLive\')?.dataset.attachmentState === \'none\'');
  await evaluate(cdp, `(() => {
    if (document.getElementById('driveLinkComposer')?.hidden !== false) document.getElementById('attachDriveLink')?.click();
    document.getElementById('confirmDriveLink')?.click();
  })()`);
  const warningState = await waitFor(cdp, 'document.getElementById(\'attachmentLive\')?.dataset.attachmentState === \'drive-link-ack-required\' ? \'drive-link-ack-required\' : null');
  assert.equal(warningState, 'drive-link-ack-required');
  await evaluate(cdp, `(() => {
    document.getElementById('driveLinkUrl').value = 'https://drive.google.com/file/d/abcDEF123/view';
    document.getElementById('driveLinkAck').checked = true;
    document.getElementById('confirmDriveLink')?.click();
  })()`);
  const linkRow = await evaluate(cdp, 'document.querySelector(".drive-link-row")?.textContent || ""');
  assert.match(linkRow, /파일 첨부가 아닌 링크/);

  await setInputFiles(cdp, '#attachmentFileInput', [oversizePath]);
  const oversize = await waitFor(cdp, `(() => {
    const error = document.querySelector('.attachment-row-error')?.textContent || '';
    const saveDisabled = document.getElementById('saveSendDraft')?.disabled === true;
    return error.includes('허용 크기를 초과') && saveDisabled ? { error, saveDisabled } : null;
  })()`);
  assert.match(oversize.error, /허용 크기를 초과/);
  await evaluate(cdp, 'document.querySelector(\'.attachment-row button\')?.click()');

  await setInputFiles(cdp, '#attachmentFileInput', [cjkPath]);
  const progress = await waitFor(cdp, `(() => {
    const live = document.getElementById('attachmentLive')?.textContent || '';
    const meta = document.querySelector('.attachment-row-meta')?.textContent || '';
    const saveDisabled = document.getElementById('saveSendDraft')?.disabled === true;
    return /uploading|파일 검사가 끝나기 전/.test(live + ' ' + meta) && saveDisabled;
  })()`);
  assert.equal(progress, true, 'compose must block save until scanner releases the upload');
  await writeFile(scanGate, 'clean\n');
  const ready = await waitFor(cdp, `(() => {
    const name = document.querySelector('.attachment-row-name')?.textContent || '';
    const meta = document.querySelector('.attachment-row-meta')?.textContent || '';
    const live = document.getElementById('attachmentLive')?.textContent || '';
    return name === ${JSON.stringify(CJK_NAME)} && /검사: ready/.test(meta)
      ? { name, meta, live, saveDisabled: document.getElementById('saveSendDraft')?.disabled === true }
      : null;
  })()`);
  assert.equal(ready.name, CJK_NAME);
  assert.match(ready.meta, /출처: PC 파일/);
  assert.equal(ready.saveDisabled, false);

  await evaluate(cdp, `(() => {
    document.getElementById('sendDraftTo').value = 'self@example.com';
    document.getElementById('sendDraftSubject').value = 'G8 합성 첨부';
    document.getElementById('sendDraftBody').value = '합성 파일만 사용합니다.';
  })()`);
  await evaluate(cdp, 'document.getElementById(\'saveSendDraft\').click()');
  const saved = await waitFor(cdp, `(() => {
    const status = document.getElementById('sendDraftStatus')?.textContent || '';
    const detail = document.getElementById('sendDraftDetail')?.textContent || '';
    return /검토용 초안을 저장했습니다/.test(status) && /다운로드하여 검토/.test(detail)
      ? { status, detail, replace: /교체|바꾸기/.test(detail) && !/바꿀 수 없습니다/.test(status) }
      : null;
  })()`, 10_000);
  assert.match(saved.status, /저장된 초안의 파일은 바꿀 수 없습니다/);
  assert.match(saved.detail, /수신인, 본문, 첨부파일\/링크를 확인했습니다/);
  assert.equal(saved.detail.includes(CJK_NAME), true);
  assert.equal(saved.replace, false);

  cdp.events.length = 0;
  await evaluate(cdp, '[...document.querySelectorAll(\'#sendDraftDetail button\')].find((node) => node.textContent === \'다운로드하여 검토\')?.click()');
  const downloaded = await waitFor(cdp, 'document.getElementById(\'sendDraftStatus\')?.textContent?.includes(\'첨부 파일을 다운로드했습니다\') ? document.getElementById(\'sendDraftStatus\').textContent : null', 8_000);
  assert.match(downloaded, /브라우저에서 실행하지 말고 검토하세요/);
  const contentResponse = cdp.events.find((event) => (
    event.method === 'Network.responseReceived'
    && String(event.params?.response?.url || '').includes('/content')
  ));
  assert.ok(contentResponse, 'download must request attachment content');
  const headers = contentResponse.params.response.headers || {};
  const disposition = headers['Content-Disposition'] || headers['content-disposition'] || '';
  const nosniff = headers['X-Content-Type-Options'] || headers['x-content-type-options'] || '';
  assert.match(disposition, /attachment/);
  assert.match(nosniff, /nosniff/);

  await evaluate(cdp, `(() => {
    const summary = document.querySelector('.send-compose summary');
    const compose = document.querySelector('.send-compose');
    if (summary && compose && !compose.open) summary.click();
    document.getElementById('sendDraftTo').value = 'self@example.com';
    document.getElementById('sendDraftSubject').value = 'G8 새 초안';
    document.getElementById('sendDraftBody').value = '파일 교체는 새 초안이 필요합니다.';
  })()`);
  const secondPath = join(directory, '두번째-첨부.txt');
  await writeFile(secondPath, 'second-draft\n');
  await setInputFiles(cdp, '#attachmentFileInput', [secondPath]);
  await writeFile(scanGate, 'clean\n');
  await waitFor(cdp, '/검사: ready/.test(document.querySelector(\'.attachment-row-meta\')?.textContent || \'\')');
  await evaluate(cdp, 'document.getElementById(\'saveSendDraft\').click()');
  const drafts = await waitFor(cdp, `(() => {
    const buttons = [...document.querySelectorAll('#sendDraftList button')].map((node) => node.textContent);
    return buttons.length >= 2 ? buttons : null;
  })()`, 10_000);
  assert.ok(drafts.some((label) => label.includes('G8 합성 첨부')));
  assert.ok(drafts.some((label) => label.includes('G8 새 초안')));

  const chromeUi = await evaluate(cdp, `({
    local: document.getElementById('attachLocalFiles')?.textContent,
    drive: document.getElementById('attachDriveFiles')?.textContent,
    link: document.getElementById('attachDriveLink')?.textContent,
    warning: document.querySelector('.drive-link-ack')?.textContent,
    overflow: getComputedStyle(document.querySelector('.send-draft-detail')).overflowWrap,
    resendButton: !!document.querySelector('[id*="resend"], [id*="retrySend"]'),
    tabbable: [...document.querySelectorAll('#sendDraftForm button, #sendDraftForm input, #sendDraftForm textarea, #sendDraftForm select')]
      .filter((node) => !node.hidden && node.type !== 'hidden' && !node.disabled)
      .map((node) => node.id),
  })`);
  assert.equal(chromeUi.local, 'PC 파일 첨부');
  assert.equal(chromeUi.drive, 'Google Drive에서 선택');
  assert.equal(chromeUi.link, 'Drive 링크 추가');
  assert.match(chromeUi.warning, /파일 첨부가 아닌 링크이며 수신자의 접근 권한은 확인되지 않았습니다/);
  assert.equal(chromeUi.overflow, 'anywhere');
  assert.equal(chromeUi.resendButton, false);
  assert.ok(chromeUi.tabbable.includes('sendDraftTo'));
  assert.ok(chromeUi.tabbable.includes('attachLocalFiles'));

  await evaluate(cdp, 'document.getElementById("sendDraftReview")?.scrollIntoView({ block: "start" })');
  const ink = await evaluate(cdp, `(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 420, 64);
    ctx.fillStyle = '#111111';
    ctx.font = '28px "Noto Sans CJK KR"';
    ctx.fillText('발송 초안 검토', 8, 44);
    const { data } = ctx.getImageData(0, 0, 420, 64);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 80 && data[index + 1] < 80 && data[index + 2] < 80) dark += 1;
    }
    return { dark, check: document.fonts.check('28px "Noto Sans CJK KR"', '발송') };
  })()`);
  assert.equal(ink.check, true);
  assert.ok(ink.dark > 400, `Korean glyphs should paint real strokes, not tofu boxes (dark=${ink.dark})`);

  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await evaluate(cdp, 'document.getElementById("sendDraftReview")?.scrollIntoView({ block: "start" })');
  const desktop = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(join(ARTIFACT_DIR, 'g8-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await evaluate(cdp, 'document.getElementById("sendDraftReview")?.scrollIntoView({ block: "start" })');
  const mobile = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(ARTIFACT_DIR, 'g8-mobile.png'), Buffer.from(mobile.data, 'base64'));
  await evaluate(cdp, 'document.getElementById("sendDraftDetail")?.scrollIntoView({ block: "end" })');
  const mobileControls = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(ARTIFACT_DIR, 'g8-mobile-controls.png'), Buffer.from(mobileControls.data, 'base64'));
  const overflow = await evaluate(cdp, `({
    viewport: window.innerWidth,
    bodyOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  })`);
  assert.equal(overflow.bodyOverflow, true);
});
