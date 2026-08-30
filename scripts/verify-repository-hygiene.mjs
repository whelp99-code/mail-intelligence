#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const excludedDirectories = new Set(['.git', '.chatgpt2codex', 'node_modules', 'data']);
const excludedRuntimeFiles = new Set([
  '.outlook-config.json',
  '.mail-cache.json',
  '.env',
  '.env.local',
  'mail-intelligence.sqlite',
  'mail-intelligence.sqlite-wal',
  'mail-intelligence.sqlite-shm',
]);
const runtimeFilePaths = [
  '.outlook-config.json',
  '.mail-cache.json',
  '.env',
  '.env.local',
  'data/.outlook-config.json',
  'data/.mail-cache.json',
  'data/mail-intelligence.sqlite',
  'data/mail-intelligence.sqlite-wal',
  'data/mail-intelligence.sqlite-shm',
];
const runtimeDirectoryPaths = ['data', 'backups'];
const ignoredSuffixes = new Set(['.log', '.db', '.sqlite', '.sqlite3', '.png', '.jpg', '.jpeg', '.webp', '.gz']);
const suspiciousPatterns = [
  ['private-key-header', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/],
  ['github-token', /gh[pousr]_[0-9A-Za-z]{30,}/],
  ['provider-key', /\bsk-[0-9A-Za-z_-]{20,}/],
  ['jwt-literal', /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/],
  ['nonempty-secret-literal', /\b(accessToken|refreshToken|clientSecret|geminiApiKey)\s*:\s*['"][^'"]{6,}['"]/],
];

async function collectFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute, output);
      continue;
    }
    if (!entry.isFile() || excludedRuntimeFiles.has(entry.name) || ignoredSuffixes.has(path.extname(entry.name))) continue;
    output.push(absolute);
  }
  return output;
}

const findings = [];
for (const absolute of await collectFiles(root)) {
  let source;
  try {
    source = await readFile(absolute, 'utf8');
  } catch {
    continue;
  }
  const relative = path.relative(root, absolute);
  for (const [name, pattern] of suspiciousPatterns) {
    // Security tests intentionally exercise non-empty placeholder values.
    // Real credential formats are still scanned in tests by the other rules.
    if (name === 'nonempty-secret-literal' && relative.startsWith(`test${path.sep}`)) continue;
    if (pattern.test(source)) findings.push({ file: relative, rule: name });
  }
}

for (const runtimeName of runtimeFilePaths) {
  const absolute = path.join(root, runtimeName);
  try {
    const metadata = await stat(absolute);
    const mode = metadata.mode & 0o777;
    console.log(`[verify-repository-hygiene] runtime file ${runtimeName}: present, mode=${mode.toString(8)}, bytes=${metadata.size}`);
    if ((mode & 0o077) !== 0) findings.push({ file: runtimeName, rule: `unsafe-mode-${mode.toString(8)}` });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.log(`[verify-repository-hygiene] runtime file ${runtimeName}: absent`);
  }
}

for (const runtimeDirectory of runtimeDirectoryPaths) {
  const absolute = path.join(root, runtimeDirectory);
  try {
    const metadata = await stat(absolute);
    const mode = metadata.mode & 0o777;
    console.log(`[verify-repository-hygiene] runtime directory ${runtimeDirectory}: present, mode=${mode.toString(8)}`);
    if ((mode & 0o077) !== 0) findings.push({ file: runtimeDirectory, rule: `unsafe-directory-mode-${mode.toString(8)}` });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.log(`[verify-repository-hygiene] runtime directory ${runtimeDirectory}: absent`);
  }
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`[verify-repository-hygiene] FLAG ${finding.rule}: ${finding.file}`);
  }
  process.exit(1);
}

console.log('[verify-repository-hygiene] PASS no credential-like literals or unsafe runtime-file modes detected');
