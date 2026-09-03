#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { splitMessageHistory } from '../src/domain/precision-classifier.js';

const DEFAULT_LABEL_FILES = Object.freeze([
  'test/fixtures/aside-round3-fixed-50.json',
  'test/fixtures/aside-qafix5-blind-fixed-50.json',
  'test/fixtures/aside-qafix6-blind-fixed-50.json',
  'data/qa/qa-fix7-blind-holdout-labels.json',
  'data/qa/qa-fix7-incident-security-supplement-labels.json',
]);

const ACTIONABLE_STATES = new Set(['action_required', 'waiting', 'decision_required']);
const LIFECYCLE_FOLDER_PATTERN = /^(?:deleteditems|deleted items|trash|junkemail|junk email|junk|spam|지운 편지함|삭제된 항목|휴지통|정크 메일|스팸)$/i;
const CURRENT_URGENCY_PATTERN = /(?:긴급|즉시|금일|오늘|내일|48\s*시간|urgent|asap|immediately|critical|service\s+down|outage|접속\s*불가|서비스\s*중단|offline|오프라인|expired?|만료|한도\s*초과|동작하지\s*않|license.{0,24}invalid)/i;
const BUSINESS_PROCESS_COMPLETION_PATTERN = /(?:검수|승인|결재|등록|발행|처리|계약|주문).{0,48}(?:완료|승인|처리\s*완료)|(?:approval|inspection|registration|issuance).{0,48}(?:has\s+been\s+)?completed/i;

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    values.push(...String(process.argv[index + 1] || '').split(','));
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function hashPrefix(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function fail(message) {
  console.error(JSON.stringify({
    audit: 'ground-truth-policy-v1',
    status: 'ERROR',
    message,
  }, null, 2));
  process.exit(2);
}

function triple(label = {}) {
  return `${label.workState || ''}/${label.nextActor || ''}/${label.priority || ''}`;
}

const requested = argumentValues('--labels');
const labelFiles = (requested.length ? requested : DEFAULT_LABEL_FILES).map((value) => resolve(value));
const databasePath = resolve(
  argumentValues('--db')[0]
    || process.env.MAIL_INTELLIGENCE_DB_PATH
    || 'data/mail-intelligence.sqlite',
);
const strict = process.argv.includes('--strict');

if (!existsSync(databasePath)) fail('Mail Intelligence database was not found.');
for (const path of labelFiles) {
  if (!existsSync(path)) fail(`Ground Truth file was not found: ${basename(path)}`);
}

const entries = [];
const sources = [];
for (const path of labelFiles) {
  const bytes = readFileSync(path);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`Ground Truth file is not valid JSON: ${basename(path)}`);
  }
  if (!Array.isArray(payload.labels) || payload.labels.length < 1) {
    fail(`Ground Truth file must contain one or more labels: ${basename(path)}`);
  }
  sources.push({
    file: basename(path),
    benchmarkId: String(payload.benchmarkId || ''),
    labels: payload.labels.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  for (const label of payload.labels) {
    entries.push({
      source: basename(path),
      benchmarkId: String(payload.benchmarkId || ''),
      label,
    });
  }
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.graph_id,
      m.subject,
      m.body_text,
      m.body_preview,
      m.is_draft,
      m.received_at,
      m.sent_at,
      f.display_name AS folder_display_name,
      f.well_known_name AS folder_well_known_name
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    WHERE TRIM(m.graph_id) <> ''
  `).all();
  const rowByHash = new Map(rows.map((row) => [hashPrefix(row.graph_id), row]));
  const missing = [];
  const policyConflicts = [];
  const now = Date.parse('2026-09-01T00:00:00Z');

  for (const entry of entries) {
    const hash = String(entry.label.hash || '').toLowerCase();
    const row = rowByHash.get(hash);
    if (!row) {
      missing.push(hash);
      continue;
    }
    const current = splitMessageHistory(row.body_text || row.body_preview || '').currentContent;
    const currentText = `${row.subject || ''}\n${current}`;
    const folder = String(row.folder_well_known_name || row.folder_display_name || '');
    const expectedState = String(entry.label.workState || '');
    const expectedPriority = String(entry.label.priority || '');

    if (LIFECYCLE_FOLDER_PATTERN.test(folder) && ACTIONABLE_STATES.has(expectedState)) {
      policyConflicts.push({
        hash,
        source: entry.source,
        benchmarkId: entry.benchmarkId,
        policy: 'lifecycle-folders-are-not-current-actions',
        expected: triple(entry.label),
      });
    }

    if (Boolean(row.is_draft)
        && LIFECYCLE_FOLDER_PATTERN.test(folder)
        && current.trim().length < 80
        && expectedState === 'reference') {
      const timestamp = Date.parse(row.received_at || row.sent_at || '');
      const ageDays = Number.isFinite(timestamp) ? Math.floor((now - timestamp) / 86_400_000) : null;
      if (ageDays != null && ageDays <= 14) {
        policyConflicts.push({
          hash,
          source: entry.source,
          benchmarkId: entry.benchmarkId,
          policy: 'recent-incomplete-deleted-draft-requires-review',
          expected: triple(entry.label),
          ageDays,
        });
      }
    }

    if (['high', 'critical'].includes(expectedPriority)
        && !CURRENT_URGENCY_PATTERN.test(currentText)) {
      policyConflicts.push({
        hash,
        source: entry.source,
        benchmarkId: entry.benchmarkId,
        policy: 'high-priority-requires-current-verified-urgency',
        expected: triple(entry.label),
      });
    }

    if (expectedState === 'reference'
        && expectedPriority === 'low'
        && BUSINESS_PROCESS_COMPLETION_PATTERN.test(currentText)) {
      policyConflicts.push({
        hash,
        source: entry.source,
        benchmarkId: entry.benchmarkId,
        policy: 'completed-business-process-is-not-low-reference',
        expected: triple(entry.label),
      });
    }
  }

  const uniqueConflictHashes = [...new Set(policyConflicts.map((item) => item.hash))].sort();
  const result = {
    audit: 'ground-truth-policy-v1',
    status: policyConflicts.length ? 'POLICY_CONFLICTS_DETECTED' : 'PASS',
    strict,
    sources,
    labels: entries.length,
    messagesFound: entries.length - missing.length,
    missing: [...new Set(missing)].sort(),
    policyConflictCount: policyConflicts.length,
    uniquePolicyConflictHashes: uniqueConflictHashes,
    policyConflicts,
    policy: {
      labelsMutated: false,
      policyConflictsAreReportOnly: true,
      newBlindRemainsReleaseDeciding: true,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (strict && (missing.length || policyConflicts.length)) process.exitCode = 1;
} finally {
  db.close();
}
