import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { classificationFingerprint } from '../src/domain/precision-classifier.js';
import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { previewProjectImport, importProjects } from '../src/application/project-import.js';
import { applyProjectImport, createProjectImportBackup, validateApplyConfirmation, validateReclassificationConfirmation } from '../src/application/project-import-command.js';
import { dryRunProjectImport } from '../scripts/import-projects.mjs';

const key = 'a'.repeat(32), otherKey = 'b'.repeat(32);
const project = (values = {}) => ({ projectKey: key, name: 'Alpha deployment', aliases: ['Alpha unique'],
  status: 'active', createdBy: 'import', ...values });
const csv = (rows) => ['project_key,name,status,aliases', ...rows.map((row) =>
  [row.projectKey, row.name, row.status, JSON.stringify(row.aliases)]
    .map((value) => `"${value.replaceAll('"', '""')}"`).join(','))].join('\n');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(t, rows = [project()]) {
  const root = mkdtempSync(join(tmpdir(), 'mi-followup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'synthetic.sqlite'), input = join(root, 'synthetic.csv');
  writeFileSync(input, csv(rows));
  const store = new SQLiteMailStore({ databasePath: database, migrationsDir: resolve('migrations') });
  t.after(() => store.close());
  const mailbox = store.ensureMailbox({ key: 'owner@example.invalid', address: 'owner@example.invalid' });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', displayName: 'Inbox', wellKnownName: 'inbox' });
  const add = (id, subject = 'Alpha unique material request', sender = 'sender@example.invalid') => {
    const message = normalizeGraphMessage({ id, subject, from: { emailAddress: { address: sender } },
      toRecipients: [{ emailAddress: { address: 'owner@example.invalid' } }],
      body: { contentType: 'text', content: '기능정리 자료를 보내주세요.' }, receivedDateTime: '2026-10-01T00:00:00Z' });
    store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message });
  };
  const options = (count, overrides = {}) => ({ csv: input, database, mailboxId: mailbox.id,
    backupPath: join(root, 'before.sqlite'),
    confirm: `APPLY-PROJECTS mailbox=${mailbox.id} csv=${hash(input).slice(0, 16)} db=${database} rows=${rows.length}`,
    reclassifyConfirm: `RECLASSIFY-PROJECTS mailbox=${mailbox.id} count=${count}`,
    onBackup: () => {}, ...overrides });
  return { root, database, input, store, mailbox, add, options };
}

function protectedTables(db) {
  const allowed = new Set(['projects', 'audit_events', 'precision_classifications', 'precision_classification_events']);
  return Object.fromEntries(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name')
    .all().filter(({ name }) => !allowed.has(name)).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

test('status-only updates audit both statuses and unchanged rerun emits no audit', (t) => {
  const { store, mailbox } = fixture(t);
  store.createProject(mailbox.id, project());
  for (const status of ['archived', 'active']) store.createProject(mailbox.id, project({ status }));
  const updates = store.db.prepare('SELECT payload_json FROM audit_events WHERE event_type=\'project.updated\' ORDER BY id').all()
    .map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(updates.map((row) => [row.previousStatus, row.status]), [['active', 'archived'], ['archived', 'active']]);
  const before = store.db.prepare('SELECT count(*) AS n FROM audit_events').get().n;
  store.createProject(mailbox.id, project());
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit_events').get().n, before);
});

for (const reverse of [false, true]) test(`name and alias swaps validate final registry independent of row order reverse=${reverse}`, (t) => {
  const { store, mailbox } = fixture(t);
  const first = project(), second = project({ projectKey: otherKey, name: 'Beta deployment', aliases: ['Beta unique'] });
  importProjects(store, mailbox.id, [first, second]);
  const swaps = [project({ name: second.name, aliases: second.aliases }),
    project({ projectKey: otherKey, name: first.name, aliases: first.aliases })];
  if (reverse) swaps.reverse();
  const old = store.listProjects(mailbox.id, { includeArchived: true });
  const preview = previewProjectImport(swaps, old);
  assert.ok(preview.plans.every((plan) => plan.action === 'update'));
  const saved = importProjects(store, mailbox.id, swaps);
  assert.equal(saved.find((item) => item.projectKey === key).name, second.name);
  assert.deepEqual(saved.find((item) => item.projectKey === key).aliases, second.aliases);
  assert.deepEqual(new Set(saved.map((item) => item.id)), new Set(old.map((item) => item.id)));
  assert.ok(store.listProjects(mailbox.id).every((item) => !item.normalizedName.startsWith('__import_')));
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n;
  importProjects(store, mailbox.id, swaps);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('outside-batch and final-batch conflicts remain atomic; SQL failure rolls back swap staging and audit', (t) => {
  const { store, mailbox } = fixture(t);
  const second = project({ projectKey: otherKey, name: 'Beta deployment', aliases: ['Beta unique'] });
  importProjects(store, mailbox.id, [project(), second]);
  const before = store.listProjects(mailbox.id);
  assert.throws(() => importProjects(store, mailbox.id, [project({ aliases: ['Beta unique'] })]), /already belongs/);
  assert.throws(() => importProjects(store, mailbox.id, [project(), { ...second, name: project().name }]), /already belongs/);
  const audits = store.db.prepare('SELECT * FROM audit_events').all();
  store.db.exec(`CREATE TRIGGER fixture_failure BEFORE UPDATE OF name ON projects
    WHEN NEW.project_key = '${otherKey}' BEGIN SELECT RAISE(ABORT, 'fixture batch failure'); END;`);
  assert.throws(() => importProjects(store, mailbox.id, [project({ name: second.name, aliases: second.aliases }),
    { ...second, name: project().name, aliases: project().aliases }]), /fixture batch failure/);
  assert.deepEqual(store.listProjects(mailbox.id), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM audit_events').all(), audits);
});

test('empty mailbox preview reports numeric zero denominator and leaves snapshot bytes unchanged', (t) => {
  const f = fixture(t); f.store.close();
  const before = hash(f.database);
  const report = dryRunProjectImport({ csv: f.input, snapshot: f.database, expectedSha256: before, mailboxId: f.mailbox.id });
  assert.deepEqual([report.denominator.total, report.denominator.active, report.denominator.excluded,
    report.denominator.classificationTarget], [0, 0, 0, 0]);
  assert.equal(report.impact.counts.total, 0);
  assert.equal(hash(f.database), before);
});

test('exact approval rejects wrong fields, formatting and weak phrases without disclosing values', () => {
  const values = { mailboxId: 3, csvSha256: 'a'.repeat(64), databasePath: '/private/selected database.sqlite', rows: 40 };
  const exact = `APPLY-PROJECTS mailbox=3 csv=${'a'.repeat(16)} db=${values.databasePath} rows=40`;
  validateApplyConfirmation(exact, values);
  for (const [text, fields] of [[exact.replace('mailbox=3', 'mailbox=4'), ['mailbox']],
    [exact.replace('rows=40', 'rows=41'), ['rows']], [exact.replace('csv=aaaa', 'csv=bbbb'), ['csv']],
    [exact.replace('selected database', 'another database'), ['db']], [exact + ' ', ['format']], ['yes', ['format']]]) {
    assert.throws(() => validateApplyConfirmation(text, values), (error) => {
      assert.deepEqual(error.fields, fields); assert.equal(error.message.includes('/private/'), false); return true;
    });
  }
  validateReclassificationConfirmation('RECLASSIFY-PROJECTS mailbox=3 count=0', 3, 0);
  assert.throws(() => validateReclassificationConfirmation('RECLASSIFY-PROJECTS mailbox=3 count=857', 3, 2),
    (error) => error.fields.join(',') === 'count');
});

test('apply requires both exact approvals; missing or wrong approvals never create a backup or alter target', async (t) => {
  const f = fixture(t); f.add('one'); f.store.close();
  const before = hash(f.database);
  for (const overrides of [{ confirm: 'yes' }, { reclassifyConfirm: undefined },
    { reclassifyConfirm: `RECLASSIFY-PROJECTS mailbox=${f.mailbox.id} count=857` }]) {
    await assert.rejects(applyProjectImport(f.options(1, overrides)), { code: 'PROJECT_IMPORT_CONFIRMATION_REJECTED' });
    assert.equal(existsSync(join(f.root, 'before.sqlite')), false);
    assert.equal(hash(f.database), before);
  }
  const child = spawnSync(process.execPath, ['scripts/import-projects.mjs', '--apply', '--csv', f.input,
    '--database', f.database, '--backup', join(f.root, 'cli.sqlite'), '--mailbox-id', String(f.mailbox.id),
    '--confirm', 'yes'], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.equal(child.stderr.includes(f.database), false);
  assert.equal(child.stderr.includes(hash(f.input)), false);
});

test('selected target rejects symlinks, relative paths and implicit normalization before backup', async (t) => {
  const f = fixture(t); f.store.close();
  const alias = join(f.root, 'alias.sqlite'); symlinkSync(f.database, alias);
  const before = hash(f.database);
  for (const database of [alias, 'relative.sqlite', `${f.root}/./synthetic.sqlite`]) {
    await assert.rejects(applyProjectImport(f.options(0, { database })), (error) => error.fields?.join(',') === 'db');
    assert.equal(existsSync(join(f.root, 'before.sqlite')), false);
    assert.equal(hash(f.database), before);
  }
});

test('native SQLite backup API rejection propagates without importing or replaying', async (t) => {
  const f = fixture(t); f.store.close();
  const source = new DatabaseSync(':memory:'); source.close();
  const before = hash(f.database);
  await assert.rejects(createProjectImportBackup(source, join(f.root, 'native-failure.sqlite')), /not open|closed/);
  assert.equal(hash(f.database), before);
});

test('backup gate refuses existing files and integrity failure without source mutation', async (t) => {
  const f = fixture(t); f.store.close();
  const target = join(f.root, 'before.sqlite'); writeFileSync(target, 'must not overwrite');
  const before = hash(f.database);
  await assert.rejects(applyProjectImport(f.options(0)));
  assert.equal(readFileSync(target, 'utf8'), 'must not overwrite'); assert.equal(hash(f.database), before);
  rmSync(target);
  const db = new DatabaseSync(f.database);
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE fixture_parent(id PRIMARY KEY); CREATE TABLE fixture_orphan(id REFERENCES fixture_parent(id)); INSERT INTO fixture_orphan VALUES(1);');
  db.close();
  const invalidBefore = hash(f.database);
  await assert.rejects(applyProjectImport(f.options(0)), /Backup integrity failure/);
  assert.equal(hash(f.database), invalidBefore);
  const check = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM projects').get().n, 0); check.close();
});

test('apply backs up first then imports and persists confirmed replay with no other table mutations', async (t) => {
  const f = fixture(t); f.add('rule'); f.add('deleted');
  f.store.db.prepare('UPDATE messages SET deleted_at=\'2026-10-01\' WHERE graph_id=\'deleted\'').run();
  const before = protectedTables(f.store.db); f.store.close();
  let receipt;
  const result = await applyProjectImport(f.options(1, { onBackup: (value) => {
    receipt = value;
    const backup = new DatabaseSync(value.backupPath, { readOnly: true });
    assert.equal(backup.prepare('SELECT count(*) AS n FROM projects').get().n, 0);
    assert.equal(backup.prepare('SELECT count(*) AS n FROM precision_classifications').get().n, 0);
    backup.close();
    assert.equal(hash(value.backupPath), value.sha256);
  } }));
  assert.equal(result.operations.create, 1);
  assert.deepEqual(result.projects, { total: 1, active: 1, archived: 0 });
  assert.deepEqual(result.reclassification, { target: 1, processed: 1, changed: 1, unchanged: 0,
    confirmed: 1, review_required: 0, candidate: 0, unassigned: 0 });
  assert.ok(receipt);
  const reopened = new SQLiteMailStore({ databasePath: f.database, initialize: false });
  assert.equal(reopened.getPrecisionClassification(f.mailbox.id, 'rule').projectResolution, 'confirmed');
  assert.equal(reopened.getPrecisionClassification(f.mailbox.id, 'deleted'), null);
  assert.deepEqual(protectedTables(reopened.db), before); reopened.close();
  const again = await applyProjectImport(f.options(1, { backupPath: join(f.root, 'before-rerun.sqlite') }));
  assert.deepEqual(again.operations, { create: 0, update: 0, unchanged: 1 });
  assert.equal(again.reclassification.changed, 0);
});

test('safe replay preserves AI work fields, explicit project correction and learned policy', async (t) => {
  const f = fixture(t);
  for (const id of ['ai', 'corrected', 'policy-source', 'policy-target']) {
    f.add(id, 'Alpha unique GS인증 기능정리 요청', id === 'ai' ? 'ai-only@example.invalid' : 'sender@example.invalid');
  }
  const service = new PrecisionIntelligenceService({ store: f.store });
  const ai = service.classifyOne(f.mailbox.mailbox_key, 'ai').classification;
  const aiSaved = { ...ai, source: 'ai', provider: 'openai', model: 'synthetic', workState: 'waiting', nextActor: 'external_party', priority: 'high' };
  aiSaved.fingerprint = classificationFingerprint(aiSaved);
  f.store.savePrecisionClassification(f.mailbox.id, 'ai', aiSaved);
  f.store.savePrecisionCorrection(f.mailbox.id, 'corrected', { overrides: { projectResolution: 'unassigned', primaryProjectId: null, projectCandidate: null,
    priority: 'low' }, savedAt: '2026-10-01T00:00:00Z', reasonCode: 'fixture-clear' });
  service.correct(f.mailbox.mailbox_key, 'policy-source', { workState: 'action_required', nextActor: 'me', priority: 'high', reasonCode: 'fixture-policy' });
  const before = protectedTables(f.store.db); f.store.close();
  const result = await applyProjectImport(f.options(4));
  assert.equal(result.reclassification.processed, 4);
  const reopened = new SQLiteMailStore({ databasePath: f.database, initialize: false });
  const afterAi = reopened.getPrecisionClassification(f.mailbox.id, 'ai');
  assert.equal(afterAi.projectResolution, 'confirmed');
  assert.equal(afterAi.workState, 'waiting'); assert.equal(afterAi.nextActor, 'external_party');
  assert.equal(afterAi.priority, 'high'); assert.equal(afterAi.source, 'ai');
  assert.equal(afterAi.provider, 'openai'); assert.equal(afterAi.model, 'synthetic');
  const correction = reopened.getPrecisionClassification(f.mailbox.id, 'corrected');
  assert.equal(correction.projectResolution, 'unassigned'); assert.equal(correction.priority, 'low');
  assert.equal(correction.reviewStatus, 'corrected');
  const learned = reopened.getPrecisionClassification(f.mailbox.id, 'policy-target');
  assert.equal(learned.workState, 'action_required'); assert.equal(learned.nextActor, 'me');
  assert.ok(learned.reviewReasons.some((reason) => reason.startsWith('learned-policy:')));
  assert.deepEqual(protectedTables(reopened.db), before); reopened.close();
});

test('explicit apply CLI emits only verified backup receipt before post-apply counts for zero targets', (t) => {
  const f = fixture(t); f.store.close();
  const options = f.options(0);
  const child = spawnSync(process.execPath, ['scripts/import-projects.mjs', '--apply', '--csv', f.input,
    '--database', f.database, '--backup', options.backupPath, '--mailbox-id', String(f.mailbox.id),
    '--confirm', options.confirm, '--reclassify-confirm', options.reclassifyConfirm], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const newline = child.stdout.indexOf('\n');
  const receipt = JSON.parse(child.stdout.slice(0, newline));
  assert.deepEqual(Object.keys(receipt).sort(), ['backupPath', 'sha256']);
  assert.equal(hash(receipt.backupPath), receipt.sha256);
  const result = JSON.parse(child.stdout.slice(newline + 1));
  assert.equal(result.applied, true); assert.equal(result.projects.total, 1);
  assert.equal(result.reclassification.target, 0); assert.equal(result.reclassification.processed, 0);
});

test('maintenance apply refuses migration gaps rather than migrating before backup', async (t) => {
  const f = fixture(t);
  f.store.db.exec('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)');
  f.store.close();
  const before = hash(f.database);
  await assert.rejects(applyProjectImport(f.options(0)), { code: 'PROJECT_IMPORT_SCHEMA_REQUIRED' });
  assert.equal(hash(f.database), before); assert.equal(existsSync(join(f.root, 'before.sqlite')), false);
});

test('replay failure rolls back import, earlier replay results and audit in the same transaction', async (t) => {
  const f = fixture(t); f.add('first'); f.add('second');
  f.store.savePrecisionCorrection(f.mailbox.id, 'second', { overrides: { primaryProjectId: 999, projectResolution: 'confirmed' },
    savedAt: '2026-10-01T00:00:00Z', reasonCode: 'fixture-invalid-project' });
  const before = protectedTables(f.store.db);
  const audit = f.store.db.prepare('SELECT * FROM audit_events').all(); f.store.close();
  await assert.rejects(applyProjectImport(f.options(2)), /Primary project must reference an active project/);
  const check = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM projects').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM precision_classifications').get().n, 0);
  assert.deepEqual(check.prepare('SELECT * FROM audit_events').all(), audit);
  assert.deepEqual(protectedTables(check), before); check.close();
});

for (const drift of ['csv', 'count', 'same-count-content', 'backup']) test(`post-backup ${drift} drift aborts before registry/replay writes`, async (t) => {
  const f = fixture(t); f.add('one'); f.store.close();
  await assert.rejects(applyProjectImport(f.options(1, { onBackup: (receipt) => {
    if (drift === 'csv') writeFileSync(f.input, csv([project({ name: 'Changed deployment' })]));
    else if (drift === 'backup') writeFileSync(receipt.backupPath, 'tampered backup');
    else {
      const db = new DatabaseSync(f.database);
      if (drift === 'count') db.exec('UPDATE messages SET deleted_at=\'2026-10-01\'');
      else db.exec('UPDATE messages SET subject=\'Changed synthetic subject\'');
      db.close();
    }
  } })));
  const check = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) AS n FROM projects').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM precision_classifications').get().n, 0); check.close();
});
