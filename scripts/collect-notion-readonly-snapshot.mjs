#!/usr/bin/env node
/**
 * Phase 1B operator helper: attempt a read-only Notion snapshot collect.
 * Default: exits with BLOCKED_ON_SECRET / READONLY_DISABLED when secrets are absent.
 * Never prints token values. Metrics are counts + hashes only.
 *
 * Usage:
 *   MAIL_INTELLIGENCE_NOTION_READONLY=1 \
 *   MAIL_INTELLIGENCE_NOTION_TOKEN_FILE=/path/mode600.token \
 *   MAIL_INTELLIGENCE_NOTION_DATABASE_MAP=/path/untracked-map.json \
 *   node scripts/collect-notion-readonly-snapshot.mjs
 */

import { resolve } from 'node:path';

import { collectNotionReadonlySnapshot, resolveNotionReadonlyConfig } from '../src/adapters/notion-readonly-collect.js';

const root = resolve(import.meta.dirname, '..');
const resolved = resolveNotionReadonlyConfig(process.env, { cwd: root });

if (!resolved.ok) {
  console.log(JSON.stringify({
    ok: false,
    code: resolved.code,
    message: resolved.message,
    discovery: {
      enabled: resolved.discovery.enabled,
      tokenEnvPresent: resolved.discovery.tokenEnvPresent,
      tokenFilePath: resolved.discovery.tokenFilePath,
      tokenFileReadable: resolved.discovery.tokenFileReadable,
      databaseMapPath: resolved.discovery.databaseMapPath,
      databaseMapReadable: resolved.discovery.databaseMapReadable,
      outPath: resolved.discovery.outPath,
      schemaPath: resolved.discovery.schemaPath,
    },
  }, null, 2));
  process.exit(resolved.code === 'READONLY_DISABLED' ? 2 : 3);
}

const result = await collectNotionReadonlySnapshot({ cwd: root, env: process.env });
console.log(JSON.stringify({
  ok: result.ok,
  code: result.code,
  message: result.message,
  stale: result.stale,
  completeness: result.completeness,
  watermarks: result.watermarks,
  snapshotPath: result.snapshotPath,
  metrics: result.metrics,
}, null, 2));
process.exit(result.ok ? 0 : 1);
