#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { classifyMessage, PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';

const WORK_STATES = new Set([
  'action_required',
  'waiting',
  'decision_required',
  'completed',
  'reference',
  'review_required',
]);
const NEXT_ACTORS = new Set([
  'me',
  'internal_team',
  'external_party',
  'shared',
  'none',
  'unknown',
]);
const PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);
const ACTIONABLE_STATES = new Set(['action_required', 'waiting', 'decision_required']);
const IMPORTANT_MISS_CONTRACT_VERSION = 'important-priority-and-action-v3';
const reportOnly = process.argv.includes('--report-only');
const SENT_FOLDER_PATTERN = /^(?:sent|sentitems|sent items|sent mail|보낸 편지함|보낸메일함|보낸 메일함)$/i;
const DELETED_FOLDER_PATTERN = /^(?:deleteditems|deleted items|trash|지운 편지함|삭제된 항목|휴지통)$/i;
const DRAFT_FOLDER_PATTERN = /^(?:drafts|draft|임시 보관함|임시보관함)$/i;
const JUNK_FOLDER_PATTERN = /^(?:junkemail|junk email|junk|spam|정크 메일|스팸)$/i;
const RELEASE_THRESHOLDS = Object.freeze({
  workStateAccuracy: 0.95,
  nextActorAccuracy: 0.95,
  priorityAccuracy: 0.95,
  referenceFalseActionRate: 0.02,
  importantPriorityMissRate: 0.03,
  importantActionMissRate: 0.03,
});

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return String(process.argv[index + 1] || '').trim();
}

function fail(message) {
  console.error(JSON.stringify({
    evaluation: 'independent-ground-truth-v1',
    status: 'ERROR',
    message,
  }, null, 2));
  process.exit(2);
}

function exactBoolean(value, field, index) {
  if (typeof value !== 'boolean') {
    fail(`labels[${index}].${field} must be a boolean.`);
  }
  return value;
}

function validateLabels(payload, expectedCount) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Ground Truth file must contain a JSON object.');
  }
  if (payload.version !== 'independent-ground-truth-v1') {
    fail('Ground Truth version must be independent-ground-truth-v1.');
  }
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(String(payload.benchmarkId || ''))) {
    fail('benchmarkId is required and must be a stable identifier.');
  }
  if (!Array.isArray(payload.labels) || payload.labels.length !== expectedCount) {
    fail(`Ground Truth must contain exactly ${expectedCount} labels.`);
  }

  const seen = new Set();
  return payload.labels.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(`labels[${index}] must be an object.`);
    }
    const hash = String(item.hash || '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(hash)) fail(`labels[${index}].hash must be a 12-character SHA-256 prefix.`);
    if (seen.has(hash)) fail(`Duplicate Ground Truth hash: ${hash}`);
    seen.add(hash);

    const workState = String(item.workState || '');
    const nextActor = String(item.nextActor || '');
    const priority = String(item.priority || '');
    if (!WORK_STATES.has(workState)) fail(`labels[${index}].workState is invalid.`);
    if (!NEXT_ACTORS.has(nextActor)) fail(`labels[${index}].nextActor is invalid.`);
    if (!PRIORITIES.has(priority)) fail(`labels[${index}].priority is invalid.`);

    return {
      hash,
      workState,
      nextActor,
      priority,
      reference: exactBoolean(item.reference, 'reference', index),
      important: exactBoolean(item.important, 'important', index),
    };
  });
}

function ratio(passed, total) {
  return total ? passed / total : 1;
}

const labelsArgument = argumentValue('--labels');
const recompute = process.argv.includes('--recompute');
const includeDeleted = process.argv.includes('--include-deleted');
const expectedCount = Number.parseInt(argumentValue('--expected-count') || '50', 10);
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 200) fail('--expected-count must be an integer between 1 and 200.');
if (!labelsArgument) fail('Usage: npm run evaluate:independent -- --labels /owner-only/path/round2-fixed-50.json');

const labelsPath = resolve(labelsArgument);
const databasePath = resolve(argumentValue('--db') || process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
if (!existsSync(labelsPath)) fail('Ground Truth file was not found.');
if (!existsSync(databasePath)) fail('Mail Intelligence database was not found.');

const labelBytes = readFileSync(labelsPath);
let payload;
try {
  payload = JSON.parse(labelBytes.toString('utf8'));
} catch {
  fail('Ground Truth file is not valid JSON.');
}
const labels = validateLabels(payload, expectedCount);
const labelSha256 = createHash('sha256').update(labelBytes).digest('hex');

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.id AS message_database_id,
      m.graph_id,
      m.subject,
      m.sender_email,
      m.sender_name,
      m.received_at,
      m.sent_at,
      m.importance,
      m.is_draft,
      m.has_attachments,
      m.is_promotional,
      m.body_preview,
      m.body_text,
      f.display_name AS folder_display_name,
      f.well_known_name AS folder_well_known_name,
      mb.address AS mailbox_address,
      pc.work_state,
      pc.next_actor,
      pc.priority
    FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    JOIN precision_classifications pc ON pc.message_id = m.id
    WHERE ${includeDeleted ? '1 = 1' : 'm.deleted_at IS NULL'}
  `).all();
  const folderComparable = (row) => String(row.folder_well_known_name || row.folder_display_name || '').trim();
  const senderAliases = [...new Set(rows
    .filter((row) => SENT_FOLDER_PATTERN.test(folderComparable(row)) || Boolean(row.is_draft))
    .map((row) => String(row.sender_email || '').trim().toLowerCase())
    .filter(Boolean))].sort();
  const evaluationNow = payload.evaluationNow ? new Date(payload.evaluationNow) : new Date();
  if (Number.isNaN(evaluationNow.getTime())) fail('Ground Truth evaluationNow must be a valid ISO date when supplied.');
  const recipientQuery = db.prepare(`
    SELECT recipient_type, email, display_name
    FROM message_recipients
    WHERE message_id = ?
    ORDER BY recipient_type, ordinal, id
  `);
  const byHash = new Map();
  for (const row of rows) {
    const hash = createHash('sha256').update(String(row.graph_id || '')).digest('hex').slice(0, 12);
    if (byHash.has(hash)) fail(`Evaluation database contains a duplicate 12-character hash prefix: ${hash}`);
    const comparable = folderComparable(row);
    const groupedRecipients = { to: [], cc: [], bcc: [], replyTo: [] };
    for (const recipient of recipientQuery.all(row.message_database_id)) {
      groupedRecipients[recipient.recipient_type]?.push({
        emailAddress: {
          address: String(recipient.email || ''),
          name: String(recipient.display_name || ''),
        },
      });
    }
    const message = {
      id: String(row.graph_id || ''),
      subject: String(row.subject || ''),
      from: String(row.sender_email || ''),
      fromName: String(row.sender_name || ''),
      receivedAt: String(row.received_at || ''),
      sentAt: String(row.sent_at || ''),
      importance: String(row.importance || 'normal'),
      isDraft: Boolean(row.is_draft),
      hasAttachments: Boolean(row.has_attachments),
      isPromotional: Boolean(row.is_promotional),
      bodyPreview: String(row.body_preview || ''),
      body: String(row.body_text || row.body_preview || ''),
      toRecipients: groupedRecipients.to,
      ccRecipients: groupedRecipients.cc,
      bccRecipients: groupedRecipients.bcc,
      replyTo: groupedRecipients.replyTo,
      folderName: String(row.folder_display_name || ''),
      folderWellKnownName: String(row.folder_well_known_name || ''),
      isOutgoing: SENT_FOLDER_PATTERN.test(comparable),
      isDeletedFolder: DELETED_FOLDER_PATTERN.test(comparable),
      isDraftFolder: DRAFT_FOLDER_PATTERN.test(comparable),
      isJunkFolder: JUNK_FOLDER_PATTERN.test(comparable),
    };
    const result = recompute
      ? classifyMessage(message, {
        mailboxAddress: String(row.mailbox_address || ''),
        mailboxAddresses: senderAliases,
        now: evaluationNow,
      })
      : {
        workState: row.work_state,
        nextActor: row.next_actor,
        priority: row.priority,
      };
    byHash.set(hash, {
      subject: row.subject,
      work_state: result.workState,
      next_actor: result.nextActor,
      priority: result.priority,
    });
  }

  let workStatePassed = 0;
  let nextActorPassed = 0;
  let priorityPassed = 0;
  let referenceFalseActions = 0;
  let importantPriorityMisses = 0;
  let importantPriorityTotal = 0;
  let importantActionMisses = 0;
  let importantActionTotal = 0;
  let legacyImportantLowCount = 0;
  let legacyImportantTotal = 0;
  const labelContractWarnings = [];
  const missing = [];
  const mismatches = [];

  for (const expected of labels) {
    const actual = byHash.get(expected.hash);
    if (!actual) {
      missing.push(expected.hash);
      continue;
    }
    const workStateMatch = actual.work_state === expected.workState;
    const nextActorMatch = actual.next_actor === expected.nextActor;
    const priorityMatch = actual.priority === expected.priority;
    if (workStateMatch) workStatePassed += 1;
    if (nextActorMatch) nextActorPassed += 1;
    if (priorityMatch) priorityPassed += 1;

    const falseAction = expected.reference && ACTIONABLE_STATES.has(actual.work_state);
    if (falseAction) referenceFalseActions += 1;

    if (expected.important) {
      legacyImportantTotal += 1;
      if (actual.priority === 'low') legacyImportantLowCount += 1;
      if (expected.priority === 'low') {
        labelContractWarnings.push({
          hash: expected.hash,
          warning: 'important=true with expected priority=low; excluded from Important Priority Miss denominator',
        });
      } else {
        importantPriorityTotal += 1;
      }
    }
    const importantPriorityMiss = expected.important
      && expected.priority !== 'low'
      && actual.priority === 'low';
    if (importantPriorityMiss) importantPriorityMisses += 1;

    const expectedActionable = ACTIONABLE_STATES.has(expected.workState);
    const importantActionMiss = expectedActionable && !ACTIONABLE_STATES.has(actual.work_state);
    if (expectedActionable) importantActionTotal += 1;
    if (importantActionMiss) importantActionMisses += 1;

    if (!workStateMatch || !nextActorMatch || !priorityMatch || falseAction || importantPriorityMiss || importantActionMiss) {
      mismatches.push({
        hash: expected.hash,
        subject: String(actual.subject || '').slice(0, 200),
        expected: `${expected.workState}/${expected.nextActor}/${expected.priority}`,
        actual: `${actual.work_state}/${actual.next_actor}/${actual.priority}`,
        falseAction,
        importantPriorityMiss,
        importantActionMiss,
      });
    }
  }

  const total = labels.length;
  const metrics = {
    found: total - missing.length,
    total,
    workState: {
      passed: workStatePassed,
      total,
      accuracy: ratio(workStatePassed, total),
    },
    nextActor: {
      passed: nextActorPassed,
      total,
      accuracy: ratio(nextActorPassed, total),
    },
    priority: {
      passed: priorityPassed,
      total,
      accuracy: ratio(priorityPassed, total),
    },
    referenceFalseAction: {
      count: referenceFalseActions,
      total,
      rate: ratio(referenceFalseActions, total),
    },
    importantPriorityMiss: {
      count: importantPriorityMisses,
      total: importantPriorityTotal,
      rate: ratio(importantPriorityMisses, importantPriorityTotal),
      contractVersion: IMPORTANT_MISS_CONTRACT_VERSION,
      definition: 'important=true, expected priority is not low, and actual priority is low',
    },
    importantActionMiss: {
      count: importantActionMisses,
      total: importantActionTotal,
      rate: ratio(importantActionMisses, importantActionTotal),
      contractVersion: IMPORTANT_MISS_CONTRACT_VERSION,
      definition: 'expected state is actionable and actual state is not actionable',
    },
    legacyImportantLowRate: {
      count: legacyImportantLowCount,
      total: legacyImportantTotal,
      rate: ratio(legacyImportantLowCount, legacyImportantTotal),
      gated: false,
      definition: 'legacy diagnostic only; includes ground-truth labels whose expected priority is low',
    },
  };

  const gates = {
    allLabelsFound: missing.length === 0,
    workState: metrics.workState.accuracy >= RELEASE_THRESHOLDS.workStateAccuracy,
    nextActor: metrics.nextActor.accuracy >= RELEASE_THRESHOLDS.nextActorAccuracy,
    priority: metrics.priority.accuracy >= RELEASE_THRESHOLDS.priorityAccuracy,
    referenceFalseAction: metrics.referenceFalseAction.rate <= RELEASE_THRESHOLDS.referenceFalseActionRate,
    importantPriorityMiss: metrics.importantPriorityMiss.rate <= RELEASE_THRESHOLDS.importantPriorityMissRate,
    importantActionMiss: metrics.importantActionMiss.rate <= RELEASE_THRESHOLDS.importantActionMissRate,
  };
  const verdict = Object.values(gates).every(Boolean) ? 'GO_CANDIDATE' : 'NO_GO';

  console.log(JSON.stringify({
    evaluation: 'independent-ground-truth-v1',
    benchmarkId: payload.benchmarkId,
    labelFile: basename(labelsPath),
    labelSha256,
    databaseFile: basename(databasePath),
    evaluationMode: recompute ? 'recomputed-from-source' : 'stored-classification',
    includeDeleted,
    expectedCount,
    reportOnly,
    classifierVersion: recompute ? PRECISION_CLASSIFICATION_VERSION : 'stored',
    evaluationNow: evaluationNow.toISOString(),
    mailboxSenderAliases: senderAliases.length,
    scoringPolicy: {
      labelsMustBeFrozenBeforeReadingCurrentResults: true,
      referenceFalseActionDenominator: 'all 50 labels',
      thresholds: RELEASE_THRESHOLDS,
    },
    metrics,
    labelContractWarnings,
    gates,
    verdict,
    missing,
    mismatches,
  }, null, 2));

  process.exitCode = reportOnly || verdict === 'GO_CANDIDATE' ? 0 : 1;
} finally {
  db.close();
}
