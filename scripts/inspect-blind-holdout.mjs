#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { splitMessageHistory } from '../src/domain/precision-classifier.js';

const SENT_FOLDER_PATTERN = /^(?:sent|sentitems|sent items|sent mail|보낸 편지함|보낸메일함|보낸 메일함)$/i;
const DRAFT_FOLDER_PATTERN = /^(?:drafts|draft|임시 보관함|임시보관함)$/i;
const DELETED_FOLDER_PATTERN = /^(?:deleteditems|deleted items|trash|지운 편지함|삭제된 항목|휴지통)$/i;
const JUNK_FOLDER_PATTERN = /^(?:junkemail|junk email|junk|spam|정크 메일|스팸)$/i;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

function fail(message) {
  console.error(JSON.stringify({ command: 'inspect-blind-holdout', status: 'ERROR', message }, null, 2));
  process.exit(2);
}

function hashPrefix(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function folderComparable(row) {
  return String(row.folder_well_known_name || row.folder_display_name || '').trim();
}

const manifestPath = resolve(argumentValue('--manifest') || 'data/qa/qa-fix5-blind-holdout-template.json');
const databasePath = resolve(argumentValue('--db') || process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const requestedHash = argumentValue('--hash').toLowerCase();
const requestedIndex = Number.parseInt(argumentValue('--index') || '0', 10);

if (!existsSync(manifestPath)) fail('Blind holdout manifest was not found.');
if (!existsSync(databasePath)) fail('Mail Intelligence database was not found.');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('Blind holdout manifest is not valid JSON.');
}
if (manifest.version !== 'independent-ground-truth-draft-v1' || !Array.isArray(manifest.samples)) {
  fail('Manifest must be an independent-ground-truth-draft-v1 template.');
}
const sample = requestedHash
  ? manifest.samples.find((item) => item.hash === requestedHash)
  : Number.isInteger(requestedIndex) && requestedIndex >= 1
    ? manifest.samples[requestedIndex - 1]
    : null;
if (!sample) fail('Select one sample with --index 1..N or --hash <12-char-hash>.');

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.graph_id,
      m.subject,
      m.sender_email,
      m.sender_name,
      m.received_at,
      m.sent_at,
      m.importance,
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
  const selected = rows.find((row) => hashPrefix(row.graph_id) === sample.hash);
  if (!selected) fail(`Selected sample is not present in the active database: ${sample.hash}`);
  const senderAliases = new Set(rows
    .filter((row) => SENT_FOLDER_PATTERN.test(folderComparable(row)) || Boolean(row.is_draft))
    .map((row) => String(row.sender_email || '').trim().toLowerCase())
    .filter(Boolean));
  const folder = folderComparable(selected);
  const sender = String(selected.sender_email || '').trim().toLowerCase();
  const history = splitMessageHistory(selected.body_text || selected.body_preview || '');
  const isDraft = Boolean(selected.is_draft) || DRAFT_FOLDER_PATTERN.test(folder);
  const isOutgoing = !isDraft && (SENT_FOLDER_PATTERN.test(folder) || senderAliases.has(sender));
  const lifecycle = DELETED_FOLDER_PATTERN.test(folder) ? 'deleted' : JUNK_FOLDER_PATTERN.test(folder) ? 'junk' : 'active';
  console.log(JSON.stringify({
    command: 'inspect-blind-holdout',
    status: 'PASS',
    predictionDisclosure: false,
    order: sample.order,
    hash: sample.hash,
    stratum: sample.stratum,
    source: {
      subject: String(selected.subject || ''),
      senderName: String(selected.sender_name || ''),
      senderAddress: String(selected.sender_email || ''),
      receivedAt: String(selected.received_at || ''),
      sentAt: String(selected.sent_at || ''),
      importance: String(selected.importance || 'normal'),
      folderName: String(selected.folder_display_name || selected.folder_well_known_name || ''),
      direction: isDraft ? 'draft' : isOutgoing ? 'outgoing' : 'incoming',
      lifecycle,
      isPromotional: Boolean(selected.is_promotional),
      currentContent: history.currentContent,
      quotedContent: history.quotedContent,
      historyBoundary: history.boundaryType,
    },
    reviewerFields: {
      workState: sample.workState,
      nextActor: sample.nextActor,
      priority: sample.priority,
      reference: sample.reference,
      important: sample.important,
      reviewerNote: sample.reviewerNote || '',
    },
  }, null, 2));
} finally {
  db.close();
}
