#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { MORNING_DIGEST_DIR, writeMorningDigest, yesterdayUtc } from '../src/application/reply-draft-pipeline.js';
import { resolveStoragePaths } from '../src/storage/storage-paths.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || '';
}

const day = arg('--date') || yesterdayUtc();
const paths = resolveStoragePaths({ env: process.env });
const db = new DatabaseSync(arg('--db') || paths.databasePath, { readOnly: true, timeout: 5_000 });
const path = arg('--out') || `${MORNING_DIGEST_DIR}/morning-digest-${day}.md`;
const result = writeMorningDigest({ db, day, path });
process.stdout.write(result.markdown);
db.close();
