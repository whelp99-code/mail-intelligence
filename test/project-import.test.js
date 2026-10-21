import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { parseProjectCsv, previewProjectImport, importProjects, evaluateProjectImpact } from '../src/application/project-import.js';
import { dryRunProjectImport } from '../scripts/import-projects.mjs';

const key = 'a'.repeat(32);
const project = (overrides = {}) => ({ projectKey: key, name: 'Alpha deployment', aliases: ['Alpha unique'],
  status: 'active', createdBy: 'import', ...overrides });
const csv = (rows) => ['project_key,name,customer,status,aliases', ...rows.map((row) =>
  [row.projectKey, row.name, '', row.status === 'archived' ? '종료' : '진행', JSON.stringify(row.aliases)]
    .map((value) => `"${value.replaceAll('"', '""')}"`).join(','))].join('\r\n');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'mi-project-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function storeFixture(t) {
  const store = new SQLiteMailStore({ databasePath: join(temporary(t), 'synthetic.sqlite'), migrationsDir: resolve('migrations') });
  t.after(() => store.close());
  const mailbox = store.ensureMailbox({ key: 'fixture@example.invalid', address: 'fixture@example.invalid' });
  return { store, mailbox };
}

test('CSV preserves quoted commas/newlines, validates keys and never infers customer aliases', () => {
  const rows = parseProjectCsv('\uFEFF' + csv([project({ name: 'Alpha, "deployment"\nPhase 2' }),
    project({ projectKey: 'b'.repeat(32), status: 'archived' })]));
  assert.equal(rows[0].name, 'Alpha, "deployment"\nPhase 2');
  assert.equal(rows[1].status, 'archived');
  assert.equal(rows[0].createdBy, 'import');
  assert.equal('customer' in rows[0], false);
  assert.throws(() => parseProjectCsv(csv([project(), project()])), /Invalid project CSV row/);
  assert.throws(() => parseProjectCsv('project_key,name,status,aliases\n"unterminated'), /Unclosed/);
  assert.throws(() => parseProjectCsv(csv([project({ projectKey: 'unknown' })])), /Invalid project CSV row/);
  assert.throws(() => parseProjectCsv('name,name\nx,y'), /Required CSV columns/);
});

test('pure evaluation counts unique, multiple, archived and unchanged without overlap', () => {
  const rows = [project(), project({ projectKey: 'b'.repeat(32), name: 'Beta deployment', aliases: ['Beta unique'] }),
    project({ projectKey: 'c'.repeat(32), name: 'Closed deployment', aliases: ['Closed unique'], status: 'archived' })];
  const preview = previewProjectImport(rows);
  const messages = [{ subject: 'Alpha unique' }, { subject: 'Alpha unique Beta unique' },
    { subject: 'Closed unique' }, { subject: 'Unrelated message' }, { body: 'Alpha unique Alpha unique' }];
  const result = evaluateProjectImpact(messages, [], preview.projects);
  assert.deepEqual(result.counts, { total: 5, confirmed: 2, review_required: 1, unchanged: 2, other_changed: 0 });
  const rerun = previewProjectImport(rows, preview.projects);
  assert.ok(rerun.plans.every((plan) => plan.action === 'unchanged'));
  assert.equal(evaluateProjectImpact(messages, preview.projects, rerun.projects).counts.unchanged, 5);
});

test('createProject-based import rerun is no-op; update preserves ID and removes obsolete aliases', (t) => {
  const { store, mailbox } = storeFixture(t);
  const first = importProjects(store, mailbox.id, [project()])[0];
  const changes = store.db.prepare('SELECT total_changes() AS count').get().count;
  assert.deepEqual(importProjects(store, mailbox.id, [project()])[0], first);
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, changes);
  const updated = importProjects(store, mailbox.id, [project({ name: 'New deployment', aliases: ['New unique'], status: 'archived' })])[0];
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.deepEqual(updated.aliases, ['New unique']);
  assert.equal(store.listProjects(mailbox.id).length, 0);
  assert.equal(store.listProjects(mailbox.id, { includeArchived: true }).length, 1);
});

test('import refuses user ownership, conflicting aliases and duplicate keys atomically', (t) => {
  const { store, mailbox } = storeFixture(t);
  store.createProject(mailbox.id, project({ createdBy: 'user' }));
  assert.throws(() => importProjects(store, mailbox.id, [project()]), /user-created/);
  const beta = project({ projectKey: 'b'.repeat(32), name: 'Beta deployment', aliases: ['Beta unique'] });
  assert.throws(() => importProjects(store, mailbox.id, [beta, project({ projectKey: 'c'.repeat(32) })]), /already belongs/);
  assert.equal(store.listProjects(mailbox.id).length, 1);
  assert.throws(() => importProjects(store, mailbox.id, [beta, beta]), /Duplicate/);
  assert.equal(store.listProjects(mailbox.id).length, 1);
});

test('synthetic dry-run keeps every file byte unchanged and emits aggregates not mail', (t) => {
  const root = temporary(t);
  const snapshot = join(root, 'snapshot.sqlite');
  const input = join(root, 'input.csv');
  writeFileSync(input, csv([project()]));
  const db = new DatabaseSync(snapshot);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE mailboxes(id INTEGER); INSERT INTO mailboxes VALUES(1);
    CREATE TABLE projects(id INTEGER, mailbox_id INTEGER, project_key TEXT, name TEXT,
      normalized_name TEXT, aliases_json TEXT, status TEXT, created_by TEXT);
    CREATE TABLE messages(id INTEGER, mailbox_id INTEGER, subject TEXT, body_text TEXT,
      body_preview TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE precision_classifications(message_id INTEGER, updated_at TEXT);
    INSERT INTO messages VALUES(1,1,'Alpha unique','','',NULL,'2026-01-01');
    INSERT INTO messages VALUES(2,1,'DO NOT LOG subject','DO NOT LOG body','',NULL,'2026-01-01');
    INSERT INTO messages VALUES(3,1,'Alpha unique','','','2026-01-01','2026-01-01');`);
  db.close(); chmodSync(snapshot, 0o600);
  const before = Object.fromEntries(readdirSync(root).map((name) => [name, hash(join(root, name))]));
  const options = { csv: input, snapshot, expectedSha256: hash(snapshot), mailboxId: 1 };
  const report = dryRunProjectImport(options);
  assert.deepEqual(report.impact.counts, { total: 2, confirmed: 1, review_required: 0, unchanged: 1, other_changed: 0 });
  assert.deepEqual([report.denominator.total, report.denominator.active, report.denominator.excluded], [3, 2, 1]);
  assert.equal(report.denominator.historicalCountMatches, false);
  assert.equal(report.snapshotSha256After, options.expectedSha256);
  assert.equal(JSON.stringify(report).includes('DO NOT LOG'), false);
  assert.deepEqual(Object.fromEntries(readdirSync(root).map((name) => [name, hash(join(root, name))])), before);
  const child = spawnSync(process.execPath, ['scripts/import-projects.mjs', '--dry-run', '--csv', input,
    '--snapshot', snapshot, '--expected-sha256', options.expectedSha256, '--mailbox-id', '1'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).unchanged, true);
  const rejected = spawnSync(process.execPath, ['scripts/import-projects.mjs', '--snapshot', snapshot], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes('DO NOT LOG'), false);
  assert.throws(() => dryRunProjectImport({ ...options, mailboxId: 999 }), /Unknown mailbox/);
  assert.throws(() => dryRunProjectImport({ ...options, expectedSha256: '0'.repeat(64) }), /digest mismatch/);
  writeFileSync(snapshot + '-wal', 'nonempty synthetic WAL');
  assert.throws(() => dryRunProjectImport(options), /closed standalone backup/);
  rmSync(snapshot + '-wal');
  chmodSync(snapshot, 0o644);
  assert.throws(() => dryRunProjectImport(options), /0600/);
});
