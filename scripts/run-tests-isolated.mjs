#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const tempRoot = resolve(root, 'data/tmp');
if (!existsSync(tempRoot)) mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
const rootMetadata = lstatSync(tempRoot);
if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Test temporary root must be a real directory.');
chmodSync(tempRoot, 0o700);
const runDirectory = mkdtempSync(join(tempRoot, 'test-'));
chmodSync(runDirectory, 0o700);

try {
  const preflight = join(runDirectory, '.write-preflight');
  writeFileSync(preflight, 'ok\n', { mode: 0o600, flag: 'wx' });
  const tests = process.argv.slice(2);
  const child = spawnSync(process.execPath, ['--test', ...(tests.length ? tests : ['test/*.test.js'])], {
    cwd: root,
    env: { ...process.env, TMPDIR: runDirectory, TMP: runDirectory, TEMP: runDirectory },
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  rmSync(runDirectory, { recursive: true, force: true });
}
