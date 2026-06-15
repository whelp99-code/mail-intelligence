#!/usr/bin/env node
/**
 * One-time migration: move legacy root JSON runtime files into MAIL_DATA_DIR (default data/).
 */
import { copyFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { appRoot, DATA_FILES, ensureDataDir, getDataFilePath } from '../src/dataPaths.mjs';

const MIGRATIONS = [
  { legacy: '.mail-cache.json', target: DATA_FILES.mailCache },
  { legacy: '.outlook-config.json', target: DATA_FILES.config },
  { legacy: '.attachment-archive.json', target: DATA_FILES.attachmentArchive },
  { legacy: '.attachment-archive-meta.json', target: DATA_FILES.attachmentArchiveMeta },
  { legacy: '.oauth-states.json', target: DATA_FILES.oauthStates },
  { legacy: '.outlook-accounts.json', target: DATA_FILES.outlookAccounts },
  { legacy: 'data/mail-cache.json', target: DATA_FILES.mailCache },
  { legacy: 'data/runtime-config.json', target: DATA_FILES.config }
];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await ensureDataDir();
  let moved = 0;
  for (const { legacy, target } of MIGRATIONS) {
    const from = join(appRoot, legacy);
    const to = getDataFilePath(target);
    if (!(await exists(from))) continue;
    if (await exists(to)) {
      console.log(`skip (exists): ${target}`);
      continue;
    }
    await mkdir(join(to, '..'), { recursive: true });
    await copyFile(from, to);
    console.log(`copied: ${legacy} -> data/${target}`);
    moved += 1;
  }
  console.log(moved ? `Done. ${moved} file(s) copied into ${getDataFilePath('')}` : 'Nothing to migrate.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
