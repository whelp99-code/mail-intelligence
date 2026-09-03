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
]);

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    values.push(...String(process.argv[index + 1] || '').split(','));
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function fail(message) {
  console.error(JSON.stringify({
    audit: 'ground-truth-consistency-v1',
    status: 'ERROR',
    message,
  }, null, 2));
  process.exit(2);
}

function hashPrefix(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function senderDomain(value = '') {
  const address = String(value || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : address;
}

function normalizeTemplate(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/[^\s)>]+/gu, '<url>')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '<email>')
    .replace(/\b[0-9a-f]{8,}\b/giu, '#')
    .replace(/(?:₩|krw|usd|eur|원|달러)\s*[\d,.]+/giu, '<amount>')
    .replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/gu, '<date>')
    .replace(/\d{1,4}(?:[.,:/-]\d{1,4})+/gu, '#')
    .replace(/\d+/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim();
}

function expectedTriple(label) {
  return `${label.workState}/${label.nextActor}/${label.priority}`;
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

const labelsByHash = new Map();
const sourceFiles = [];
for (const path of labelFiles) {
  const bytes = readFileSync(path);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`Ground Truth file is not valid JSON: ${basename(path)}`);
  }
  if (!Array.isArray(payload.labels) || payload.labels.length !== 50) {
    fail(`Ground Truth file must contain 50 labels: ${basename(path)}`);
  }
  sourceFiles.push({
    file: basename(path),
    benchmarkId: String(payload.benchmarkId || ''),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    labels: payload.labels.length,
  });
  for (const label of payload.labels) {
    const hash = String(label.hash || '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(hash)) fail(`Invalid message hash in ${basename(path)}.`);
    const entries = labelsByHash.get(hash) || [];
    entries.push({
      source: basename(path),
      benchmarkId: String(payload.benchmarkId || ''),
      label,
    });
    labelsByHash.set(hash, entries);
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
      m.sender_email,
      f.display_name AS folder_display_name,
      f.well_known_name AS folder_well_known_name
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    WHERE TRIM(m.graph_id) <> ''
  `).all();
  const rowByHash = new Map(rows.map((row) => [hashPrefix(row.graph_id), row]));
  const groups = new Map();
  const missing = [];

  for (const [hash, entries] of labelsByHash) {
    const row = rowByHash.get(hash);
    if (!row) {
      missing.push(hash);
      continue;
    }
    const current = splitMessageHistory(row.body_text || row.body_preview || '').currentContent;
    const signatureSource = [
      senderDomain(row.sender_email),
      normalizeTemplate(row.folder_well_known_name || row.folder_display_name),
      normalizeTemplate(row.subject),
      normalizeTemplate(current).slice(0, 1600),
    ].join('\n');
    const signature = createHash('sha256').update(signatureSource).digest('hex').slice(0, 20);
    const group = groups.get(signature) || {
      signature,
      senderDomain: senderDomain(row.sender_email),
      folder: String(row.folder_well_known_name || row.folder_display_name || ''),
      subjectTemplate: normalizeTemplate(row.subject).slice(0, 240),
      entries: [],
    };
    for (const entry of entries) {
      group.entries.push({
        hash,
        source: entry.source,
        benchmarkId: entry.benchmarkId,
        expected: expectedTriple(entry.label),
        reference: Boolean(entry.label.reference),
        important: Boolean(entry.label.important),
      });
    }
    groups.set(signature, group);
  }

  const repeatedTemplates = [...groups.values()]
    .filter((group) => new Set(group.entries.map((entry) => entry.hash)).size > 1);
  const conflicts = repeatedTemplates
    .map((group) => ({
      ...group,
      expectedTriples: [...new Set(group.entries.map((entry) => entry.expected))].sort(),
      referenceValues: [...new Set(group.entries.map((entry) => entry.reference))].sort(),
      importantValues: [...new Set(group.entries.map((entry) => entry.important))].sort(),
    }))
    .filter((group) => group.expectedTriples.length > 1
      || group.referenceValues.length > 1
      || group.importantValues.length > 1);

  const result = {
    audit: 'ground-truth-consistency-v1',
    status: conflicts.length ? 'CONFLICTS_DETECTED' : 'PASS',
    strict,
    sourceFiles,
    uniqueHashes: labelsByHash.size,
    duplicateHashLabels: [...labelsByHash.values()].filter((entries) => entries.length > 1).length,
    messagesFound: labelsByHash.size - missing.length,
    missing,
    repeatedTemplateGroups: repeatedTemplates.length,
    conflictGroups: conflicts.length,
    conflicts,
    policy: {
      labelsMutated: false,
      conflictingTemplatesAreNotValidStrictRegressionGates: true,
      freshBlindHoldoutRemainsReleaseDecisive: true,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (strict && (missing.length || conflicts.length)) process.exitCode = 1;
} finally {
  db.close();
}
