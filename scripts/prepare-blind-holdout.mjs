#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PRECISION_CLASSIFICATION_VERSION, splitMessageHistory } from '../src/domain/precision-classifier.js';

const SENT_FOLDER_PATTERN = /^(?:sent|sentitems|sent items|sent mail|보낸 편지함|보낸메일함|보낸 메일함)$/i;
const DELETED_FOLDER_PATTERN = /^(?:deleteditems|deleted items|trash|지운 편지함|삭제된 항목|휴지통)$/i;
const DRAFT_FOLDER_PATTERN = /^(?:drafts|draft|임시 보관함|임시보관함)$/i;
const JUNK_FOLDER_PATTERN = /^(?:junkemail|junk email|junk|spam|정크 메일|스팸)$/i;
const AUTOMATED_SENDER_PATTERN = /^(?:no[-_.]?reply|noreply|notification|notifications|alert|alerts|mailer-daemon)@/i;
const AUTOMATED_CONTENT_PATTERN = /unsubscribe|수신\s*거부|verification\s*code|인증\s*(?:번호|코드)|세금계산서|eformsign|수신문서보기|이카운트|newsletter|webinar/i;
const INCIDENT_PATTERN = /장애|오류|중단|접속\s*불가|보안|security|incident|outage|breach|malware|ransomware|vulnerability|vpn/i;
const BUSINESS_DOCUMENT_PATTERN = /견적|발주|계약|제안서|세금계산서|검수|라이선스|license|quotation|purchase\s*order|contract|invoice/i;
const THREAD_SUBJECT_PATTERN = /^(?:(?:\[(?:re|fw|fwd)\])\s*)*(?:re|fw|fwd|전달)\s*:/i;
const DEFAULT_COUNT = 50;
const LABEL_ADMISSIBILITY_CONTRACT_VERSION = 'current-message-evidence-v1';
const ADDITIONAL_DEFAULT_EXCLUSION_PATHS = Object.freeze([
  'test/fixtures/aside-qafix6-blind-fixed-50.json',
  'test/fixtures/aside-qafix5-blind-fixed-50.json',
]);
const DEFAULT_SEED = 'mail-intelligence-qa-fix5-blind-holdout-v1';
const QA_FIX_TAG = PRECISION_CLASSIFICATION_VERSION.match(/qa-fix\d+$/)?.[0] || 'qa-candidate';
const STRATUM_ORDER = Object.freeze([
  'draft',
  'lifecycle',
  'automated',
  'outgoing',
  'forwarded_or_replied',
  'incident_or_security',
  'business_document',
  'general_inbound',
]);
const TARGET_WEIGHTS = Object.freeze({
  draft: 0.08,
  lifecycle: 0.06,
  automated: 0.16,
  outgoing: 0.16,
  forwarded_or_replied: 0.16,
  incident_or_security: 0.10,
  business_document: 0.14,
  general_inbound: 0.14,
});

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    values.push(...String(process.argv[index + 1] || '').split(','));
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function fail(message) {
  console.error(JSON.stringify({ command: 'prepare-blind-holdout', status: 'ERROR', message }, null, 2));
  process.exit(2);
}

function hashPrefix(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function deterministicRank(seed, graphId) {
  return createHash('sha256').update(`${seed}\0${graphId}`).digest('hex');
}

function comparableFolder(row) {
  return String(row.folder_well_known_name || row.folder_display_name || '').trim();
}

function stratumFor(row, senderAliases) {
  const folder = comparableFolder(row);
  const body = String(row.body_text || row.body_preview || '');
  const subject = String(row.subject || '');
  const current = splitMessageHistory(body).currentContent;
  const combined = `${subject}\n${current}`;
  const sender = String(row.sender_email || '').trim().toLowerCase();
  if (Boolean(row.is_draft) || DRAFT_FOLDER_PATTERN.test(folder)) return 'draft';
  if (DELETED_FOLDER_PATTERN.test(folder) || JUNK_FOLDER_PATTERN.test(folder)) return 'lifecycle';
  if (Boolean(row.is_promotional) || AUTOMATED_SENDER_PATTERN.test(sender) || AUTOMATED_CONTENT_PATTERN.test(combined)) return 'automated';
  if (SENT_FOLDER_PATTERN.test(folder) || senderAliases.has(sender)) return 'outgoing';
  if (THREAD_SUBJECT_PATTERN.test(subject) || splitMessageHistory(body).boundaryType !== 'none') return 'forwarded_or_replied';
  if (INCIDENT_PATTERN.test(combined)) return 'incident_or_security';
  if (BUSINESS_DOCUMENT_PATTERN.test(combined)) return 'business_document';
  return 'general_inbound';
}

function targetCounts(count) {
  const targets = Object.fromEntries(STRATUM_ORDER.map((name) => [name, Math.floor(count * TARGET_WEIGHTS[name])]));
  let assigned = Object.values(targets).reduce((sum, value) => sum + value, 0);
  for (const name of STRATUM_ORDER) {
    if (assigned >= count) break;
    targets[name] += 1;
    assigned += 1;
  }
  return targets;
}

const databasePath = resolve(argumentValue('--db') || process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const exclusionPath = resolve(argumentValue('--exclude-labels') || 'test/fixtures/aside-round3-fixed-50.json');
const outputPath = resolve(argumentValue('--output') || 'data/qa/qa-fix5-blind-holdout-template.json');
const requestedExclusions = argumentValues('--exclude-labels');
const exclusionPaths = requestedExclusions.length
  ? requestedExclusions.map((value) => resolve(value))
  : [exclusionPath, ...ADDITIONAL_DEFAULT_EXCLUSION_PATHS.map((value) => resolve(value))];
const seed = argumentValue('--seed') || DEFAULT_SEED;
const count = Number.parseInt(argumentValue('--count') || String(DEFAULT_COUNT), 10);
const overwrite = process.argv.includes('--overwrite');

if (!Number.isInteger(count) || count < 20 || count > 200) fail('count must be an integer between 20 and 200.');
if (!existsSync(databasePath)) fail('Mail Intelligence database was not found.');
for (const path of exclusionPaths) {
  if (!existsSync(path)) fail(`Known benchmark exclusion file was not found: ${basename(path)}`);
}
if (existsSync(outputPath) && !overwrite) fail('Output already exists. Use --overwrite only when intentionally regenerating the same blinded template.');

const excludedHashes = new Set();
const exclusionFiles = [];
for (const path of exclusionPaths) {
  const bytes = readFileSync(path);
  let exclusion;
  try {
    exclusion = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`Known benchmark exclusion file is not valid JSON: ${basename(path)}`);
  }
  if (!Array.isArray(exclusion.labels) || !exclusion.labels.length) {
    fail(`Known benchmark exclusion file has no labels: ${basename(path)}`);
  }
  const before = excludedHashes.size;
  for (const item of exclusion.labels) {
    const hash = String(item.hash || '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(hash)) fail(`Known benchmark contains an invalid hash: ${basename(path)}`);
    excludedHashes.add(hash);
  }
  exclusionFiles.push({
    file: basename(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    labels: exclusion.labels.length,
    uniqueAdded: excludedHashes.size - before,
  });
}
if (excludedHashes.size < 50) fail('Known benchmark exclusions must contain at least 50 unique hashes.');

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.graph_id,
      m.subject,
      m.sender_email,
      m.received_at,
      m.is_draft,
      m.is_promotional,
      m.body_preview,
      m.body_text,
      f.display_name AS folder_display_name,
      f.well_known_name AS folder_well_known_name
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    WHERE m.deleted_at IS NULL
      AND TRIM(m.graph_id) <> ''
  `).all();
  const senderAliases = new Set(rows
    .filter((row) => SENT_FOLDER_PATTERN.test(comparableFolder(row)) || Boolean(row.is_draft))
    .map((row) => String(row.sender_email || '').trim().toLowerCase())
    .filter(Boolean));
  const candidates = rows
    .map((row) => ({
      graphId: String(row.graph_id),
      hash: hashPrefix(row.graph_id),
      stratum: stratumFor(row, senderAliases),
      receivedAt: String(row.received_at || ''),
      rank: deterministicRank(seed, row.graph_id),
    }))
    .filter((item) => !excludedHashes.has(item.hash));
  const unique = new Map();
  for (const item of candidates) {
    if (unique.has(item.hash)) fail(`Database contains a duplicate 12-character hash prefix: ${item.hash}`);
    unique.set(item.hash, item);
  }
  if (unique.size < count) fail(`Only ${unique.size} eligible messages remain after excluding the known benchmark.`);

  const pools = Object.fromEntries(STRATUM_ORDER.map((name) => [name, []]));
  for (const item of unique.values()) pools[item.stratum].push(item);
  for (const name of STRATUM_ORDER) pools[name].sort((a, b) => a.rank.localeCompare(b.rank));
  const targets = targetCounts(count);
  const selected = [];
  const selectedHashes = new Set();
  for (const name of STRATUM_ORDER) {
    for (const item of pools[name].slice(0, targets[name])) {
      selected.push(item);
      selectedHashes.add(item.hash);
    }
  }
  if (selected.length < count) {
    const remainder = [...unique.values()]
      .filter((item) => !selectedHashes.has(item.hash))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    for (const item of remainder) {
      if (selected.length >= count) break;
      selected.push(item);
      selectedHashes.add(item.hash);
    }
  }
  selected.sort((a, b) => a.rank.localeCompare(b.rank));

  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  const payload = {
    version: 'independent-ground-truth-draft-v1',
    labelAdmissibilityContractVersion: LABEL_ADMISSIBILITY_CONTRACT_VERSION,
    benchmarkId: `${QA_FIX_TAG}-blind-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    seed,
    classifierVersion: PRECISION_CLASSIFICATION_VERSION,
    privacy: {
      containsMessageContent: false,
      containsStoredPredictions: false,
      ownerOnlyRuntimeArtifact: true,
    },
    source: {
      databaseFile: basename(databasePath),
      activeMessages: rows.length,
      eligibleMessages: unique.size,
      excludedKnownBenchmarks: excludedHashes.size,
      exclusionFiles,
    },
    instructions: [
      'Review each hash against the original mail without looking at current system classification.',
      'Fill workState, nextActor, priority, reference, important, and reviewerNote.',
      'After labels are frozen, set version to independent-ground-truth-v1 and rename samples to labels.',
      'Do not alter labels after running the scorer.',
    ],
    requestedStrata: targets,
    actualStrata: Object.fromEntries(STRATUM_ORDER.map((name) => [name, selected.filter((item) => item.stratum === name).length])),
    samples: selected.map((item, index) => ({
      order: index + 1,
      hash: item.hash,
      stratum: item.stratum,
      workState: null,
      nextActor: null,
      priority: null,
      reference: null,
      important: null,
      reviewerNote: '',
      reviewerDisagreement: null,
      currentEvidence: null,
    })),
  };
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  chmodSync(outputPath, 0o600);
  console.log(JSON.stringify({
    command: 'prepare-blind-holdout',
    status: 'PASS',
    output: outputPath,
    benchmarkId: payload.benchmarkId,
    count: selected.length,
    knownBenchmarksExcluded: excludedHashes.size,
    exclusionFiles,
    containsMessageContent: false,
    containsStoredPredictions: false,
    actualStrata: payload.actualStrata,
  }, null, 2));
} finally {
  db.close();
}
