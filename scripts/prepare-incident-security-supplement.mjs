#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PRECISION_CLASSIFICATION_VERSION, splitMessageHistory } from '../src/domain/precision-classifier.js';

const INCIDENT_SECURITY_PATTERN = /장애|오류|중단|접속\s*불가|비정상\s*(?:로그인|접속)|보안\s*(?:경고|알림|이슈|사고)|침해|해킹|취약점|악성코드|랜섬웨어|\bhci\b.{0,48}(?:라이선스|license).{0,48}(?:오류|실패|장애)|\bvpn\b.{0,48}(?:오류|실패|접속\s*불가)|security\s+(?:alert|incident|issue)|incident|outage|breach|compromise|vulnerability|malware|ransomware/i;
const NOISE_ONLY_PATTERN = /세금계산서|청구서|invoice|보험|insurance|증권|광고|newsletter|webinar/i;
const DEFAULT_COUNT = 5;
const DEFAULT_SEED = 'mail-intelligence-qafix7-incident-supplement-v1';
const QA_FIX_TAG = PRECISION_CLASSIFICATION_VERSION.match(/qa-fix\d+$/)?.[0] || 'qa-candidate';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

function fail(message) {
  console.error(JSON.stringify({ command: 'prepare-incident-security-supplement', status: 'ERROR', message }, null, 2));
  process.exit(2);
}

function hashPrefix(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function deterministicRank(seed, graphId) {
  return createHash('sha256').update(`${seed}\0${graphId}`).digest('hex');
}

function parsePaths(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

function collectExcludedHashes(paths) {
  const excluded = new Set();
  const sources = [];
  for (const path of paths) {
    if (!existsSync(path)) fail(`Exclusion file was not found: ${path}`);
    const bytes = readFileSync(path);
    const payload = JSON.parse(bytes);
    const entries = payload.labels || payload.samples || [];
    let added = 0;
    for (const item of entries) {
      const hash = String(item.hash || '').toLowerCase();
      if (!hash || excluded.has(hash)) continue;
      excluded.add(hash);
      added += 1;
    }
    sources.push({
      file: basename(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      entries: entries.length,
      uniqueAdded: added,
    });
  }
  return { excluded, sources };
}

const databasePath = resolve(argumentValue('--db') || process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const outputPath = resolve(argumentValue('--output') || 'data/qa/qa-fix7-incident-security-supplement-template.json');
const defaultExclusions = [
  'test/fixtures/aside-round3-fixed-50.json',
  'test/fixtures/aside-qafix5-blind-fixed-50.json',
  'test/fixtures/aside-qafix6-blind-fixed-50.json',
  'data/qa/qa-fix7-blind-holdout-template.json',
].join(',');
const exclusionPaths = parsePaths(argumentValue('--exclude-labels') || defaultExclusions);
const seed = argumentValue('--seed') || DEFAULT_SEED;
const count = Number.parseInt(argumentValue('--count') || String(DEFAULT_COUNT), 10);
const overwrite = process.argv.includes('--overwrite');

if (!Number.isInteger(count) || count < 1 || count > 50) fail('count must be an integer between 1 and 50.');
if (!existsSync(databasePath)) fail('Mail Intelligence database was not found.');
if (existsSync(outputPath) && !overwrite) fail('Output already exists. Use --overwrite only for an intentional regeneration.');

const { excluded, sources } = collectExcludedHashes(exclusionPaths);
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.graph_id,
      m.subject,
      m.body_text,
      m.body_preview,
      m.received_at,
      m.is_draft,
      m.is_promotional,
      f.display_name AS folder_display_name,
      f.well_known_name AS folder_well_known_name
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    WHERE m.deleted_at IS NULL
      AND TRIM(m.graph_id) <> ''
  `).all();

  const candidates = rows
    .map((row) => {
      const hash = hashPrefix(row.graph_id);
      const currentContent = splitMessageHistory(row.body_text || row.body_preview || '').currentContent;
      const combined = `${row.subject || ''}\n${currentContent}`;
      const incidentSecurity = INCIDENT_SECURITY_PATTERN.test(combined);
      const noiseOnly = NOISE_ONLY_PATTERN.test(combined) && !/(?:장애|오류|중단|접속\s*불가|비정상|침해|해킹|취약점|security\s+(?:alert|incident)|outage|breach|malware|ransomware)/i.test(combined);
      return {
        hash,
        graphId: String(row.graph_id),
        receivedAt: String(row.received_at || ''),
        rank: deterministicRank(seed, row.graph_id),
        eligible: incidentSecurity && !noiseOnly,
      };
    })
    .filter((item) => item.eligible && !excluded.has(item.hash))
    .sort((a, b) => a.rank.localeCompare(b.rank));

  const unique = new Map();
  for (const item of candidates) {
    if (!unique.has(item.hash)) unique.set(item.hash, item);
  }
  const selected = [...unique.values()].slice(0, count);
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);

  const payload = {
    version: 'independent-ground-truth-draft-v1',
    benchmarkId: `${QA_FIX_TAG}-incident-security-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    classifierVersion: PRECISION_CLASSIFICATION_VERSION,
    requestedCount: count,
    availableCount: selected.length,
    complete: selected.length >= count,
    limitation: selected.length >= count
      ? ''
      : 'Fewer than five unseen real incident/security messages remain after excluding all known regression and primary blind hashes. Do not replace this gap with synthetic cases or count them as blind accuracy.',
    privacy: {
      containsMessageContent: false,
      containsStoredPredictions: false,
      ownerOnlyRuntimeArtifact: true,
    },
    source: {
      databaseFile: basename(databasePath),
      activeMessages: rows.length,
      excludedHashes: excluded.size,
      exclusionFiles: sources,
    },
    samples: selected.map((item, index) => ({
      order: index + 1,
      hash: item.hash,
      stratum: 'incident_or_security',
      workState: null,
      nextActor: null,
      priority: null,
      reference: null,
      important: null,
      reviewerNote: '',
    })),
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  chmodSync(outputPath, 0o600);
  console.log(JSON.stringify({
    command: 'prepare-incident-security-supplement',
    status: payload.complete ? 'PASS' : 'INSUFFICIENT_UNSEEN_INCIDENT_SECURITY',
    output: outputPath,
    requestedCount: count,
    availableCount: selected.length,
    excludedHashes: excluded.size,
    containsMessageContent: false,
    containsStoredPredictions: false,
  }, null, 2));
} finally {
  db.close();
}
