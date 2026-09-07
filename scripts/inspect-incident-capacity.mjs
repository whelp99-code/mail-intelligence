#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function value(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

const root = process.cwd();
const databasePath = resolve(value('--db') || process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const sourceRoot = resolve(value('--source-root') || root);
const count = value('--count') || '5';
if (!existsSync(databasePath)) throw new Error(`Mail Intelligence database was not found: ${databasePath}`);
const sourceMetadata = lstatSync(sourceRoot);
if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) throw new Error('Source root must be a real directory.');

function discoverExclusions(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...discoverExclusions(path));
      continue;
    }
    if (!entry.isFile()
      || !entry.name.endsWith('.json')
      || !/(?:labels?|templates?|manifests?|canonical|adjudicat|aside|labeler)/i.test(entry.name)) continue;
    let payload;
    try {
      payload = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`Selected message-benchmark exclusion file is malformed: ${path}`);
    }
    const entries = Array.isArray(payload.labels) ? payload.labels : payload.samples;
    if (!Array.isArray(entries) || !entries.length) continue;
    if (!entries.some((item) => Object.hasOwn(item || {}, 'hash'))) continue;
    if (entries.some((item) => !/^[0-9a-f]{12}$/i.test(String(item?.hash || '')))) {
      throw new Error(`Exclusion candidate has an invalid hash: ${path}`);
    }
    files.push(path);
  }
  return files;
}

const exclusionDirectories = [join(sourceRoot, 'test/fixtures'), join(sourceRoot, 'data/qa')];
const exclusions = exclusionDirectories.flatMap((directory) => {
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Exclusion directory must be a real directory: ${directory}`);
  return discoverExclusions(directory);
});
if (!exclusions.length) throw new Error('No prior label/template exclusions were discovered.');
const privateRoot = resolve(root, 'data/tmp');
if (!existsSync(privateRoot)) mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const rootMetadata = lstatSync(privateRoot);
if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Private temporary root must be a real directory.');
chmodSync(privateRoot, 0o700);
const runDirectory = mkdtempSync(join(privateRoot, 'incident-capacity-'));
chmodSync(runDirectory, 0o700);
const artifactPath = join(runDirectory, 'incident-template.json');

try {
  const child = spawnSync(process.execPath, [
    'scripts/prepare-incident-security-supplement.mjs',
    '--db', databasePath,
    '--output', artifactPath,
    '--count', count,
    '--seed', 'incident-capacity-inventory-v1',
    '--exclude-labels', exclusions.join(','),
  ], { cwd: root, encoding: 'utf8' });
  if (child.error) throw child.error;
  if (!existsSync(artifactPath)) throw new Error('Incident capacity preparation did not produce its private artifact.');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  process.stdout.write(`${JSON.stringify({
    command: 'inspect-incident-capacity',
    status: artifact.complete ? 'CAPACITY_AVAILABLE' : 'INSUFFICIENT_UNSEEN_INCIDENT_SECURITY',
    requestedCount: artifact.requestedCount,
    availableCount: artifact.availableCount,
    complete: artifact.complete,
    excludedHashes: artifact.source?.excludedHashes,
    exclusionFiles: artifact.source?.exclusionFiles?.length || 0,
    activeMessages: artifact.source?.activeMessages,
    containsMessageContent: false,
    containsHashes: false,
    containsPredictions: false,
    nextAction: artifact.complete
      ? 'Independent reviewer may prepare and label a new blind incident/security sample.'
      : 'Do not substitute synthetic cases; collect new unseen real incident/security mail before release QA.',
  }, null, 2)}\n`);
  if (child.status !== 0 && child.status !== 2) process.exitCode = child.status;
} finally {
  rmSync(runDirectory, { recursive: true, force: true });
}
