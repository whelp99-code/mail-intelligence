import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SQLiteMailStore } from '../../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../../src/domain/mail-normalizer.js';
import { MailSendDrafts } from '../../src/application/mail-send-drafts.js';
import { PersistentMailMemoryRuntime } from '../../src/application/persistent-mail-memory.js';

const root = resolve('.');
const evidence = resolve('.omo/evidence/d4');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const mode = process.argv[2] || 'serve';
const mailboxUser = '';
const owner = 'jm@example.test';
const inbox = { id: 'd4-inbox', displayName: 'Inbox', childFolderCount: 0, wellKnownName: 'inbox' };
const sent = { id: 'd4-sent', displayName: 'Sent Items', childFolderCount: 0, wellKnownName: 'sentitems' };
function message(id, folder, conversation, body, from, received = '2026-10-01T01:00:00Z') {
  return { id, parentFolderId: folder, conversationId: conversation, subject: `자료 회신 요청 ${id}`,
    from: { emailAddress: { address: from, name: from === owner ? '박재민' : 'Fixture Buyer' } },
    toRecipients: [{ emailAddress: { address: from === owner ? 'buyer@nexias.co.kr' : owner } }],
    receivedDateTime: received, sentDateTime: received, bodyPreview: body,
    body: { contentType: 'text', content: body }, isDraft: false, isRead: false, hasAttachments: false };
}
const incoming = [
  message('d4-style', inbox.id, 'd4-style-thread', '자료를 회신 부탁드립니다.', 'buyer@nexias.co.kr'),
  message('d4-handled', inbox.id, 'd4-handled-thread', '전화로 일정 확인 후 회신 부탁드립니다.', 'buyer@example.test'),
  message('d4-cancel', inbox.id, 'd4-cancel-thread', '검토 자료 회신 부탁드립니다.', 'buyer@example.test'),
];
const history = [
  message('d4-old-sent-1', sent.id, 'history-1', '안녕하십니까.\n자료를 보내드립니다.\n고맙습니다.', owner, '2026-09-30T01:00:00Z'),
  message('d4-old-sent-2', sent.id, 'history-2', '안녕하십니까.\n검토 부탁드립니다.\n고맙습니다.', owner, '2026-09-29T01:00:00Z'),
];
if (mode === 'sync-reply') {
  const state = JSON.parse(await readFile(`${evidence}/host.json`, 'utf8'));
  const reply = message('d4-later-owner-reply', sent.id, 'd4-cancel-thread', '안녕하십니까.\n확인했습니다.\n고맙습니다.', owner, '2026-10-01T04:00:00Z');
  const reads = [];
  const runtime = new PersistentMailMemoryRuntime({
    databasePath: join(state.directory, 'mail-intelligence.sqlite'), migrationsDir: resolve('migrations'),
    backupDirectory: join(state.directory, 'backups'), graphBaseUrl: 'https://graph.fixture.test/v1.0',
    fetchImpl: async (input, options = {}) => {
      const url = new URL(String(input));
      if ((options.method || 'GET') !== 'GET') throw new Error('QA_GRAPH_WRITE_BLOCKED');
      reads.push(url.pathname);
      let value;
      if (url.pathname.endsWith('/mailFolders')) value = [inbox, sent];
      else if (url.pathname.includes(`/mailFolders/${inbox.id}/messages/delta`)) value = incoming;
      else if (url.pathname.includes(`/mailFolders/${sent.id}/messages/delta`)) value = [...history, reply];
      else throw new Error(`QA_UNEXPECTED_GRAPH_READ ${url.pathname}`);
      return new Response(JSON.stringify({ value,
        ...(url.pathname.includes('/messages/delta') ? { '@odata.deltaLink': `${url.origin}${url.pathname}?cursor=d4` } : {}) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  try {
    await runtime.initialize();
    const result = await runtime.syncMailbox({ accessToken: 'synthetic-fixture-token', mailboxUser, forceInitial: true });
    const row = runtime.store.db.prepare('SELECT status FROM mail_send_drafts WHERE request_id=?').get('d4-cancel-draft');
    const events = runtime.store.db.prepare('SELECT status, actor, reason FROM mail_send_draft_events WHERE draft_id=? ORDER BY id').all(state.draftId);
    await writeFile(`${evidence}/sent-sync.json`, JSON.stringify({ result, draft: row, events, graphReads: reads, writes: 0 }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: 'D4_SENT_SYNC', status: row.status, writes: 0 }));
  } finally { runtime.store.close(); }
} else {
  const directory = await mkdtemp(join(tmpdir(), 'mail-d4-fixture-'));
  await writeFile(`${evidence}/host.json`, JSON.stringify({ directory, phase: 'seed' }), { mode: 0o600 });
  const store = new SQLiteMailStore({ databasePath: join(directory, 'mail-intelligence.sqlite'), migrationsDir: resolve('migrations') });
  process.once('uncaughtException', async error => {
    store.close();
    await rm(directory, { recursive: true, force: true });
    await writeFile(`${evidence}/seed-cleanup.json`, JSON.stringify({ directory, removed: true, code: error.code || error.message }), { mode: 0o600 });
    console.error(error);
    process.exit(1);
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: owner });
  for (const [folder, items] of [[inbox, incoming], [sent, history]]) {
    const record = store.ensureFolder({ mailboxId: mailbox.id, graphId: folder.id, displayName: folder.displayName, wellKnownName: folder.wellKnownName });
    const run = store.startSyncRun({ mailboxId: mailbox.id, folderId: record.id, runType: 'initial' });
    store.applyDeltaPage({ mailboxId: mailbox.id, folderId: record.id, syncRunId: run, pageIndex: 0,
      requestUrl: 'https://graph.fixture.test/v1.0/messages/delta', items: items.map(normalizeGraphMessage),
      deltaLink: `https://graph.fixture.test/v1.0/mailFolders/${folder.id}/messages/delta?cursor=seed` });
  }
  const now = '2026-10-01T02:00:00Z';
  for (const item of incoming) {
    const record = store.db.prepare('SELECT id FROM messages WHERE graph_id=?').get(item.id);
    store.db.prepare(`INSERT INTO precision_classifications(message_id, mailbox_id, work_state, next_actor, priority,
      fingerprint, analyzed_at, created_at, updated_at) VALUES (?, ?, 'action_required', 'me', 'normal', ?, ?, ?, ?)`)
      .run(record.id, mailbox.id, item.id, now, now, now);
  }
  const original = store.db.prepare('SELECT id FROM messages WHERE graph_id=?').get('d4-cancel');
  const draft = new MailSendDrafts(store.db).create(mailbox.id, 'jarvis', {
    request_id: 'd4-cancel-draft', to: ['buyer@example.test'], subject: 'RE: 자료 요청',
    body_text: '일정은 {확인 필요}입니다.', message_id: original.id,
  }).draft;
  store.close();
  const probe = createServer();
  const listening = once(probe, 'listening');
  probe.listen(0, '127.0.0.1');
  await listening;
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const log = [];
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'globalThis.fetch=async()=>{throw new Error("QA_OUTBOUND_NETWORK_BLOCKED")}; await import("./server.mjs");'], {
    cwd: root, env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: 'test',
      HOST: '127.0.0.1', PORT: String(port), APP_RUNTIME_ACTIONS_APPROVED: '0',
      APP_RUNTIME_ALLOW_SEND: '0', APP_RUNTIME_ALLOW_MUTATIONS: '0', APP_RUNTIME_ALLOW_DATA_PLANE: '0',
      APP_RUNTIME_ALLOW_EXTERNAL_AI: '0', APP_RUNTIME_ENABLE_FIXTURE_WRITES: '1',
      MAIL_INTELLIGENCE_DATA_DIR: directory, OUTLOOK_MAILBOX_USER: mailboxUser,
      MAIL_INTELLIGENCE_ACCESS_KEY: 'd4-owned-fixture-key',
      OUTLOOK_ACCESS_TOKEN: 'synthetic-fixture-token', MAIL_INTELLIGENCE_REPLY_DRAFTS_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let complete = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('D4_FIXTURE_START_TIMEOUT')), 30000);
    child.stdout.on('data', chunk => {
      complete += String(chunk); log.push(String(chunk));
      if (/Mail Intelligence .+ app running at /.test(complete)) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => log.push(String(chunk)));
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`D4_FIXTURE_EXIT ${code}`)); });
  });
  const state = { directory, port, base: `http://127.0.0.1:${port}`, pid: child.pid, draftId: draft.draft_id };
  await writeFile(`${evidence}/host.json`, JSON.stringify(state), { mode: 0o600 });
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
      child.kill('SIGTERM'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
    await writeFile(`${evidence}/host-cleanup.json`, JSON.stringify({ pid: child.pid, port, directory, stopped: true, removed: true }), { mode: 0o600 });
    console.log('D4_QA_HOST_CLEANED');
  };
  process.on('SIGTERM', () => cleanup().then(() => process.exit(0)));
  process.on('SIGINT', () => cleanup().then(() => process.exit(0)));
  try {
    await ready;
    console.log(`D4_QA_HOST_READY ${JSON.stringify(state)}`);
  } catch (error) {
    await writeFile(`${evidence}/startup.log`, log.join(''), { mode: 0o600 });
    await cleanup();
    throw error;
  }
}
