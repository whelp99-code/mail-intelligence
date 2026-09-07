import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = process.cwd();
const testRunner = resolve('scripts/run-tests-isolated.mjs');
const backupInventory = resolve('scripts/inventory-backup-retention.mjs');
const incidentCapacity = resolve('scripts/inspect-incident-capacity.mjs');

test('isolated test launcher removes its private directory after a failing child', () => {
  const tempRoot = resolve('data/tmp');
  const before = existsSync(tempRoot) ? readdirSync(tempRoot) : [];
  const result = spawnSync(process.execPath, [testRunner, 'test/no-such-test.js'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const after = existsSync(tempRoot) ? readdirSync(tempRoot) : [];
  assert.deepEqual(after, before);
});

test('backup retention inventory is dry-run and does not traverse symlinks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'backup-retention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'new.sqlite'), 'backup');
  writeFileSync(join(directory, 'old.sqlite'), 'backup');
  const old = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000));
  utimesSync(join(directory, 'old.sqlite'), old, old);
  symlinkSync(join(directory, 'new.sqlite'), join(directory, 'linked.sqlite'));
  const output = execFileSync(process.execPath, [backupInventory, '--dir', directory], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.mode, 'DRY_RUN_NO_DELETE');
  assert.equal(report.deletionPerformed, false);
  assert.equal(report.regularFiles, 2);
  assert.equal(report.skipped[0].reason, 'symlink_not_followed');
  assert.equal(existsSync(join(directory, 'new.sqlite')), true);
});

test('incident capacity rejects a missing database without creating a retained artifact', () => {
  const result = spawnSync(process.execPath, [incidentCapacity, '--db', join(tmpdir(), 'missing-mail-intelligence.sqlite')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database was not found/);
});

test('incident capacity discovers valid prior exclusions and emits aggregate only', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'incident-capacity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'test/fixtures'), { recursive: true });
  mkdirSync(join(directory, 'data/qa'), { recursive: true });
  writeFileSync(join(directory, 'test/fixtures/known-labels.json'), JSON.stringify({ labels: [{ hash: 'a'.repeat(12) }] }));
  writeFileSync(join(directory, 'data/qa/empty-template.json'), JSON.stringify({ samples: [] }));
  const databasePath = join(directory, 'fixture.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE mail_folders (id INTEGER PRIMARY KEY, display_name TEXT, well_known_name TEXT); CREATE TABLE messages (graph_id TEXT, subject TEXT, body_text TEXT, body_preview TEXT, received_at TEXT, is_draft INTEGER, is_promotional INTEGER, folder_id INTEGER, deleted_at TEXT);');
  database.close();
  const result = spawnSync(process.execPath, [incidentCapacity, '--db', databasePath, '--source-root', directory], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exclusionFiles, 1);
  assert.equal(report.containsHashes, false);
  assert.equal(report.containsPredictions, false);
});
