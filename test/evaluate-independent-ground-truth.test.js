import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const evaluatorPath = fileURLToPath(new URL('../scripts/evaluate-independent-ground-truth.mjs', import.meta.url));

function runEvaluator({ expectedWorkState, important }) {
  const directory = mkdtempSync(join(tmpdir(), 'mail-intelligence-evaluator-'));
  chmodSync(directory, 0o700);
  const databasePath = join(directory, 'fixture.sqlite');
  const labelsPath = join(directory, 'labels.json');
  const graphId = `fixture-${expectedWorkState}-${important}`;
  const hash = createHash('sha256').update(graphId).digest('hex').slice(0, 12);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE mailboxes (id INTEGER PRIMARY KEY, address TEXT);
      CREATE TABLE mail_folders (id INTEGER PRIMARY KEY, display_name TEXT, well_known_name TEXT);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, mailbox_id INTEGER, folder_id INTEGER, graph_id TEXT,
        subject TEXT, sender_email TEXT, sender_name TEXT, received_at TEXT, sent_at TEXT,
        importance TEXT, is_draft INTEGER, has_attachments INTEGER, is_promotional INTEGER,
        body_preview TEXT, body_text TEXT, deleted_at TEXT
      );
      CREATE TABLE precision_classifications (
        message_id INTEGER, work_state TEXT, next_actor TEXT, priority TEXT
      );
      CREATE TABLE message_recipients (
        id INTEGER PRIMARY KEY, message_id INTEGER, recipient_type TEXT, email TEXT,
        display_name TEXT, ordinal INTEGER
      );
    `);
    db.prepare('INSERT INTO mailboxes (id, address) VALUES (1, ?)').run('owner@example.test');
    db.prepare('INSERT INTO mail_folders (id, display_name, well_known_name) VALUES (1, ?, ?)').run('Inbox', 'inbox');
    db.prepare(`
      INSERT INTO messages (
        id, mailbox_id, folder_id, graph_id, subject, sender_email, sender_name,
        received_at, sent_at, importance, is_draft, has_attachments, is_promotional,
        body_preview, body_text, deleted_at
      ) VALUES (1, 1, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, NULL)
    `).run(graphId, 'Fixture reference', 'sender@example.test', 'Fixture Sender', '2026-09-04T00:00:00.000Z', '', 'normal', 'Reference only', 'Reference only');
    db.prepare('INSERT INTO precision_classifications (message_id, work_state, next_actor, priority) VALUES (1, ?, ?, ?)')
      .run('reference', 'none', 'normal');
    writeFileSync(labelsPath, `${JSON.stringify({
      version: 'independent-ground-truth-v1',
      benchmarkId: `fixture-${expectedWorkState}`,
      labels: [{
        hash,
        workState: expectedWorkState,
        nextActor: expectedWorkState === 'action_required' ? 'me' : 'none',
        priority: 'normal',
        reference: expectedWorkState === 'reference',
        important,
      }],
    })}\n`, { mode: 0o600 });
    chmodSync(labelsPath, 0o600);
  } finally {
    db.close();
  }

  try {
    return JSON.parse(execFileSync(process.execPath, [
      evaluatorPath,
      '--labels', labelsPath,
      '--db', databasePath,
      '--expected-count', '1',
      '--report-only',
    ], { encoding: 'utf8' }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('independent evaluator reports zero important-action denominator as not applicable', () => {
  const report = runEvaluator({ expectedWorkState: 'reference', important: false });

  assert.deepEqual(report.metrics.importantActionMiss, {
    count: 0,
    total: 0,
    rate: null,
    applicable: false,
    contractVersion: report.metrics.importantActionMiss.contractVersion,
    definition: report.metrics.importantActionMiss.definition,
  });
  assert.equal(report.gates.importantActionMiss, true);
});

test('independent evaluator fails the important-action gate for a nonzero miss', () => {
  const report = runEvaluator({ expectedWorkState: 'action_required', important: true });

  assert.equal(report.metrics.importantActionMiss.total, 1);
  assert.equal(report.metrics.importantActionMiss.count, 1);
  assert.equal(report.metrics.importantActionMiss.rate, 1);
  assert.equal(report.metrics.importantActionMiss.applicable, true);
  assert.equal(report.gates.importantActionMiss, false);
});