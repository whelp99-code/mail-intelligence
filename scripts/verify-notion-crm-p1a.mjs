#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tests = [
  'test/work-links.test.js',
  'test/work-links-refresh.test.js',
  'test/work-links-api.test.js',
  'test/work-links-ui.test.js',
  'test/notion-schema-contract.test.js',
  'test/notion-readonly-collect.test.js',
  'test/today-briefing-contract.test.js',
  'test/work-link-events.test.js',
];

const result = spawnSync(process.execPath, ['scripts/run-tests-isolated.mjs', ...tests], {
  cwd: root,
  env: { ...process.env, TMPDIR: process.env.TMPDIR || '/var/tmp' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
