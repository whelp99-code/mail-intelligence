#!/usr/bin/env node
/**
 * CI audit: portal mail routes must not call destructive mail-intelligence APIs
 * without an approval gate (v2) or at all (v1 read-only boundary).
 *
 * Usage:
 *   node scripts/verify-mail-readonly-boundary.mjs
 *   AIOS_V1_ROOT=... AIOS_V2_ROOT=... node scripts/verify-mail-readonly-boundary.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIL_ROOT = resolve(__dirname, '..');
const V1_ROOT = process.env.AIOS_V1_ROOT || resolve(MAIL_ROOT, '../../AIOS v1');
const V2_ROOT = process.env.AIOS_V2_ROOT || resolve(MAIL_ROOT, '../../AIOSv2_integration');

const DESTRUCTIVE_PATH_RE =
  /\/api\/outlook\/(send|read|config)\b|fetchMailIntelligence\([^)]*\/api\/outlook\/(send|read|config)/;

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx']);

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, files);
    else if (SOURCE_EXT.has(entry.slice(entry.lastIndexOf('.')))) files.push(full);
  }
  return files;
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function scanForDestructiveCalls(root, label, allowlist = []) {
  const violations = [];
  const files = walk(root);
  for (const file of files) {
    if (allowlist.some((allowed) => file.includes(allowed))) continue;
    const content = readFileSync(file, 'utf8');
    if (!DESTRUCTIVE_PATH_RE.test(content)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentOnlyLine(line)) continue;
      if (DESTRUCTIVE_PATH_RE.test(line)) {
        violations.push({ file, line: i + 1, text: line.trim(), label });
      }
    }
  }
  return violations;
}

function assertV2ApprovalGates() {
  const routes = [
    'apps/web/src/app/api/mail/send/route.ts',
    'apps/web/src/app/api/mail/read/route.ts',
    'apps/web/src/app/api/mail/config/route.ts',
  ];
  const missing = [];
  for (const rel of routes) {
    const file = join(V2_ROOT, rel);
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      missing.push({ file: rel, reason: 'file_missing' });
      continue;
    }
    if (!content.includes('ensureApprovedAction')) {
      missing.push({ file: rel, reason: 'missing_ensureApprovedAction' });
    }
    if (!content.includes('fetchMailIntelligence')) {
      missing.push({ file: rel, reason: 'missing_fetchMailIntelligence' });
    }
  }
  return missing;
}

function main() {
  const failures = [];

  const v1Dirs = [
    join(V1_ROOT, 'apps/web/src'),
    join(V1_ROOT, 'packages/mail-intelligence/src'),
    join(V1_ROOT, 'packages/automation/src'),
  ];
  for (const dir of v1Dirs) {
    const hits = scanForDestructiveCalls(dir, 'v1');
    if (hits.length) failures.push(...hits);
  }

  const v2Hits = scanForDestructiveCalls(join(V2_ROOT, 'apps/web/src'), 'v2', [
    '/api/mail/send/route.ts',
    '/api/mail/read/route.ts',
    '/api/mail/config/route.ts',
    '/lib/integrations/mail-intelligence-proxy.ts',
  ]);
  if (v2Hits.length) failures.push(...v2Hits);

  const gateMissing = assertV2ApprovalGates();
  if (gateMissing.length) {
    for (const item of gateMissing) {
      failures.push({
        file: item.file,
        line: 0,
        text: item.reason,
        label: 'v2-approval-gate',
      });
    }
  }

  if (failures.length) {
    console.error('mail read-only boundary audit FAILED\n');
    for (const failure of failures) {
      console.error(`[${failure.label}] ${failure.file}:${failure.line}`);
      console.error(`  ${failure.text}\n`);
    }
    process.exit(1);
  }

  console.log('mail read-only boundary audit passed');
  console.log(`  v1 roots: ${v1Dirs.join(', ')}`);
  console.log(`  v2 gated routes: mail/send, mail/read, mail/config`);
}

main();
