import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const migrationsDir = resolve('migrations');
const files = readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
const versionOf = (name) => Number(name.split('_')[0]);
const now = () => '2026-09-23T12:00:00.000Z';
const originalHashes = {
  6: '8b81b2bab51ac5853eb2c37737a9cc1bfd7b2111dd8fe52d4913a892d47cc0df',
  7: 'fc30a26dabc761af32f02839b401071d2d67d768da3cb8445c2934fba4b77c4c',
  9: '7995343a55876a27ecb87cb0acda1140e70e527d0c35aaf5daa6dbc1bc5aff18',
};

function fixture(t, include = () => true) {
  const root = mkdtempSync(join(tmpdir(), 'attachment-migration-bridge-'));
  const partialDir = join(root, 'migrations');
  mkdirSync(partialDir, { mode: 0o700 });
  for (const name of files.filter((name) => include(versionOf(name)))) {
    copyFileSync(join(migrationsDir, name), join(partialDir, name));
  }
  const databasePath = join(root, 'mail.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) if (!store.closed) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function open(directory = migrationsDir) {
    const store = new SQLiteMailStore({
      databasePath, migrationsDir: directory,
      now: directory === partialDir ? () => '2026-09-10T00:00:00.000Z' : now,
    });
    stores.push(store);
    return store;
  }
  return { store: open(partialDir), open };
}

function rows(db, table) {
  const order = db.prepare(`PRAGMA table_info("${table}")`).all().map((_, index) => index + 1).join(', ');
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all();
}

function snapshot(db) {
  const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
  const tables = schema.filter((entry) => entry.type === 'table');
  return { schema, tables: Object.fromEntries(tables.map(({ name }) => [name, rows(db, name)])) };
}

function assertPreserved(db, before) {
  for (const [table, previous] of Object.entries(before.tables)) {
    const current = rows(db, table);
    if (table === 'schema_migrations') {
      for (const row of previous) assert.deepEqual(current.find((item) => item.version === row.version), row);
      continue;
    }
    assert.equal(current.length, previous.length, table);
    previous.forEach((row, index) => {
      for (const [column, value] of Object.entries(row)) {
        assert.deepEqual(current[index][column], value, `${table}[${index}].${column}`);
      }
    });
  }
}

function assertComplete(db) {
  const history = rows(db, 'schema_migrations');
  assert.deepEqual(history.map((row) => row.version), files.map(versionOf));
  for (const { version, name, checksum } of history) {
    assert.equal(checksum, createHash('sha256').update(readFileSync(join(migrationsDir, name))).digest('hex'));
    if (originalHashes[version]) assert.equal(checksum, originalHashes[version]);
  }
  const columns = db.prepare('PRAGMA table_info(mail_send_drafts)').all();
  for (const [name, type, defaultValue] of [['digest_version', 'INTEGER', '1'], ['links_json', 'TEXT', '\'[]\'']]) {
    const column = columns.find((item) => item.name === name);
    assert.ok(column, name);
    assert.equal(column.type, type);
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, defaultValue);
  }
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_temp_master WHERE type = \'table\'').all(), []);
}

function seedDrafts(store, { attachments = false, canonical = false } = {}) {
  const { db } = store;
  const mailbox = store.ensureMailbox({ key: 'synthetic', address: 'owner@example.test' });
  const drafts = [
    ['approved-ui', 'ui', 'approved'],
    ['sending-bot', 'grok-bot', 'sending'],
    ['sent-ui', 'ui', 'sent'],
    ['links-only', 'grok-bot', 'needs_approval'],
    ['legacy-v1', 'ui', 'needs_approval'],
    ...(canonical ? [['jarvis-owned', 'jarvis', 'sent']] : []),
  ];
  for (const [id, source, status] of drafts) {
    const approved = ['approved', 'sending', 'sent'].includes(status);
    const values = [id, mailbox.id, `request-${id}`, source, '[ { "email" : "recipient@example.test" } ]', '[]',
      `Subject ${id}`, `Body\n${id}`, `unchanged-payload-digest-${id}`, status, now(),
      approved ? now() : null, approved ? 'human-approval-fixture' : null,
      status === 'sent' ? now() : null, status === 'sent' ? `graph-receipt-${id}` : null, null];
    const columns = ['draft_id', 'mailbox_id', 'request_id', 'source', 'to_json', 'cc_json', 'subject',
      'body_text', 'payload_digest', 'status', 'created_at', 'approved_at', 'approved_by', 'sent_at',
      'graph_message_id', 'failure_reason'];
    if (canonical) {
      columns.push('owner_principal');
      values.push(source === 'ui' ? 'human:ui' : `agent:${source}`);
    }
    db.prepare(`INSERT INTO mail_send_drafts (${columns.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`).run(...values);
    db.prepare('INSERT INTO mail_send_draft_events(draft_id, status, actor, created_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(id, status, `fixture:${source}`, now(), `event-${id}`);
    if (attachments && id !== 'legacy-v1') {
      db.prepare('UPDATE mail_send_drafts SET digest_version = 2, links_json = ? WHERE draft_id = ?')
        .run(` [ { "url" : "https://example.test/${id}", "name" : "raw \\u006cink" } ]\n`, id);
    }
  }
  if (!attachments) return mailbox;
  db.prepare('INSERT INTO mail_drive_connections VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('drive-connection', mailbox.id, 'synthetic-subject', 'encrypted-token-fixture', '["drive.file"]', now(), null);
  db.prepare('INSERT INTO mail_drive_file_grants VALUES (?, ?, ?, ?, ?, ?)')
    .run('drive-connection', mailbox.id, 'drive-file', 'encrypted-resource-key', now(), null);
  const assetInsert = db.prepare(`INSERT INTO mail_attachment_assets (
    id, mailbox_id, source, request_id, display_name, mime_type, byte_length, sha256,
    ciphertext, nonce, auth_tag, key_version, encryption_aad_version, encryption_policy_version,
    scan_policy_version, state, scan_engine, scan_version, scanned_at, origin,
    drive_connection_id, drive_file_id, drive_resource_key, drive_version, drive_modified_time,
    export_mime, created_at, expires_at
  ) VALUES (${Array.from({ length: 28 }, () => '?').join(', ')})`);
  for (const [index, id] of ['asset-local', 'asset-drive'].entries()) {
    assetInsert.run(id, mailbox.id, 'ui', `upload-${id}`, `${id}.txt`, 'text/plain', 17 + index, `sha-${id}`,
      Buffer.from([0, 255, index, 128]), Buffer.from([1, index]), Buffer.from([2, index]), 'key-v1', 'aad-v1', 'encryption-v1',
      'scan-v1', 'ready', 'synthetic', '1', now(), index ? 'drive' : 'local',
      index ? 'drive-connection' : null, index ? 'drive-file' : null, index ? Buffer.from([128, 0, 255]) : null,
      index ? 'version-17' : null, index ? now() : null, index ? 'text/plain' : null, now(), null);
  }
  for (const id of ['approved-ui', 'sending-bot', 'sent-ui']) {
    for (const [ordinal, asset] of [[0, 'asset-drive'], [3, 'asset-local']]) {
      db.prepare('INSERT INTO mail_draft_attachments VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, ordinal, asset, `frozen-${asset}.txt`, 'application/octet-stream', 19 + ordinal, `frozen-sha-${asset}`);
    }
  }
  db.prepare('INSERT INTO mail_attachment_reservations VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('reservation', mailbox.id, 'grok-bot', 'inflight-request', 2048, now(), null);
  return mailbox;
}

function assertForeignKeyRejection(db) {
  assert.throws(() => db.exec(`INSERT INTO mail_draft_attachments VALUES (
    'missing-draft', 0, 'asset-local', 'name', 'text/plain', 1, 'sha'
  )`), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec(`INSERT INTO mail_draft_attachments VALUES (
    'approved-ui', 20, 'missing-asset', 'name', 'text/plain', 1, 'sha'
  )`), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec('DELETE FROM mail_send_drafts WHERE draft_id = \'approved-ui\''), /FOREIGN KEY constraint failed/);
}

test('fresh store retains exact attachment column definitions through immutable 009', (t) => {
  const { store } = fixture(t);
  assertComplete(store.db);
});

test('005 upgrade preserves existing drafts, approvals, digests, receipts and event IDs', (t) => {
  const { store, open } = fixture(t, (version) => version <= 5);
  seedDrafts(store);
  const before = snapshot(store.db);
  store.close();
  const upgraded = open();
  assertComplete(upgraded.db);
  assertPreserved(upgraded.db, before);
  for (const draft of rows(upgraded.db, 'mail_send_drafts')) {
    assert.equal(draft.digest_version, 1);
    assert.equal(draft.links_json, '[]');
    assert.equal(draft.owner_principal, draft.source === 'ui' ? 'human:ui' : 'agent:grok-bot');
  }
});

test('populated attachment 007 upgrade preserves raw metadata, bindings, assets, Drive and history; reopen is idempotent', (t) => {
  const { store, open } = fixture(t, (version) => version <= 7);
  seedDrafts(store, { attachments: true });
  const before = snapshot(store.db);
  store.close();
  const upgraded = open();
  assertComplete(upgraded.db);
  assertPreserved(upgraded.db, before);
  assertForeignKeyRejection(upgraded.db);
  for (const draft of rows(upgraded.db, 'mail_send_drafts')) {
    assert.equal(draft.owner_principal, draft.source === 'ui' ? 'human:ui' : 'agent:grok-bot');
  }
  const after = snapshot(upgraded.db);
  upgraded.close();
  const reopened = open();
  assertComplete(reopened.db);
  assert.deepEqual(snapshot(reopened.db), after);
});

test('canonical 013 without 006/007 adds attachments without rebuilding owned drafts or reconciliation/outbox records', (t) => {
  const { store, open } = fixture(t, (version) => ![6, 7].includes(version));
  const mailbox = seedDrafts(store, { canonical: true });
  store.db.prepare(`INSERT INTO mail_send_reconciliation_jobs (
    draft_id, mailbox_id, state, next_attempt_at, created_at, updated_at
  ) VALUES (?, ?, 'pending', ?, ?, ?)`)
    .run('jarvis-owned', mailbox.id, now(), now(), now());
  store.db.prepare(`INSERT INTO mail_company_memory_outbox (
    id, workspace_id, kind, provider, mailbox, source_locator, source_event_id, status, created_at, updated_at
  ) VALUES ('outbox-fixture', 'workspace', 'INBOX_RECEIVED', 'graph', 'synthetic', 'locator', 'event', 'PENDING', ?, ?)`)
    .run(now(), now());
  // A rebuild would destroy this trigger. It also rejects any unintended draft rewrite.
  store.db.exec(`CREATE TRIGGER canonical_draft_unchanged BEFORE UPDATE ON mail_send_drafts
    BEGIN SELECT RAISE(ABORT, 'canonical drafts must not be rewritten'); END;`);
  const before = snapshot(store.db);
  store.close();
  const upgraded = open();
  assertComplete(upgraded.db);
  assertPreserved(upgraded.db, before);
  assert.ok(upgraded.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('canonical_draft_unchanged'));
  assert.equal(upgraded.db.prepare('SELECT owner_principal FROM mail_send_drafts WHERE draft_id = ?').get('jarvis-owned').owner_principal, 'agent:jarvis');
  const after = snapshot(upgraded.db);
  upgraded.close();
  assert.deepEqual(snapshot(open().db), after);
});

const failureTriggers = {
  detach: `AFTER DELETE ON mail_draft_attachments WHEN (SELECT count(*) FROM mail_draft_attachments) = 0
    BEGIN SELECT RAISE(ABORT, 'bridge-detach-failure'); END`,
  restore: `BEFORE INSERT ON mail_draft_attachments
    BEGIN SELECT RAISE(ABORT, 'bridge-restore-failure'); END`,
  restored: `AFTER INSERT ON mail_draft_attachments WHEN (SELECT count(*) FROM mail_draft_attachments) = 6
    BEGIN SELECT RAISE(ABORT, 'bridge-restored-failure'); END`,
  history: `AFTER INSERT ON schema_migrations WHEN NEW.version = 9
    BEGIN SELECT RAISE(ABORT, 'bridge-history-failure'); END`,
};

for (const [stage, trigger] of Object.entries(failureTriggers)) {
  test(`009 ${stage} SQL-trigger failure rolls back the whole bridge and permits retry`, (t) => {
    const { store } = fixture(t, (version) => version <= 8);
    seedDrafts(store, { attachments: true });
    store.db.exec(`CREATE TRIGGER fail_bridge ${trigger};`);
    const before = snapshot(store.db);
    store.migrationsDir = migrationsDir;
    assert.throws(() => store.migrate(), new RegExp(`bridge-${stage}-failure`));
    assert.deepEqual(snapshot(store.db), before);
    assert.equal(store.txDepth, 0);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(store.db.prepare('SELECT name FROM sqlite_temp_master WHERE type = \'table\'').all(), []);
    store.db.exec('DROP TRIGGER fail_bridge;');
    store.migrate();
    assertComplete(store.db);
    assertPreserved(store.db, before);
    assertForeignKeyRejection(store.db);
  });
}

test('preservation assertion rejects silent binding changes during restoration', (t) => {
  const { store } = fixture(t, (version) => version <= 8);
  seedDrafts(store, { attachments: true });
  store.db.exec(`CREATE TRIGGER corrupt_restore AFTER INSERT ON mail_draft_attachments
    BEGIN UPDATE mail_draft_attachments SET frozen_name = 'corrupted'
      WHERE draft_id = NEW.draft_id AND ordinal = NEW.ordinal; END;`);
  const before = snapshot(store.db);
  store.migrationsDir = migrationsDir;
  assert.throws(() => store.migrate(), /Attachment migration preservation failed/);
  assert.deepEqual(snapshot(store.db), before);
  store.db.exec('DROP TRIGGER corrupt_restore;');
  store.migrate();
  assertComplete(store.db);
  assertPreserved(store.db, before);
});

test('foreign keys stay enabled during detachment and restoration', (t) => {
  const { store } = fixture(t, (version) => version <= 8);
  seedDrafts(store, { attachments: true });
  for (const operation of ['DELETE', 'INSERT']) {
    store.db.exec(`CREATE TRIGGER require_fk_${operation} BEFORE ${operation} ON mail_draft_attachments
      WHEN (SELECT foreign_keys FROM pragma_foreign_keys) <> 1
      BEGIN SELECT RAISE(ABORT, 'foreign keys were disabled'); END;`);
  }
  store.migrationsDir = migrationsDir;
  store.migrate();
  assertComplete(store.db);
  assertForeignKeyRejection(store.db);
});

for (const column of ['name', 'checksum']) {
  test(`applied 013 ${column} mismatch fails before pending 006/007 writes`, (t) => {
    const { store } = fixture(t, (version) => ![6, 7].includes(version));
    seedDrafts(store, { canonical: true });
    const original = store.db.prepare(`SELECT ${column} AS value FROM schema_migrations WHERE version = 13`).get().value;
    store.db.prepare(`UPDATE schema_migrations SET ${column} = ? WHERE version = 13`).run('mismatched');
    const before = snapshot(store.db);
    store.migrationsDir = migrationsDir;
    assert.throws(() => store.migrate(), /Migration 13 checksum or name changed after application/);
    assert.deepEqual(snapshot(store.db), before);
    store.db.prepare(`UPDATE schema_migrations SET ${column} = ? WHERE version = 13`).run(original);
    store.migrate();
    assertComplete(store.db);
  });
}

test('an applied 006 with missing metadata fails without guessing or discarding bindings', (t) => {
  const { store } = fixture(t, (version) => version <= 8);
  seedDrafts(store, { attachments: true });
  store.db.exec('ALTER TABLE mail_send_drafts DROP COLUMN links_json;');
  const before = snapshot(store.db);
  store.migrationsDir = migrationsDir;
  assert.throws(() => store.migrate(), /links_json/);
  assert.deepEqual(snapshot(store.db), before);
});
