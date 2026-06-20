import { mkdir, readFile, rename, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function getMailDataDir() {
  const configured = String(process.env.MAIL_DATA_DIR || '').trim();
  return configured ? configured : join(appRoot, 'data');
}

export function getDataFilePath(fileName) {
  return join(getMailDataDir(), fileName);
}

export const DATA_FILES = {
  config: 'runtime-config.json',
  legacyConfig: '.outlook-config.json',
  mailCache: 'mail-cache.json',
  legacyMailCache: '.mail-cache.json',
  attachmentArchive: 'attachment-archive.json',
  attachmentArchiveMeta: 'attachment-archive-meta.json',
  oauthStates: 'oauth-states.json',
  accounts: 'accounts.json',
  outlookAccounts: '.outlook-accounts.json'
};

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(filePath) {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}

/** Prefer data/ path; fall back to legacy root dotfile if data/ copy missing or stale stub. */
export async function resolveDataPath(fileName, legacyRelativePath = '') {
  const dataDir = getMailDataDir();
  await mkdir(dataDir, { recursive: true });
  const primary = join(dataDir, fileName);
  const legacy = legacyRelativePath
    ? join(appRoot, legacyRelativePath)
    : join(appRoot, fileName.startsWith('.') ? fileName : `.${fileName}`);

  const primarySize = await fileSize(primary);
  const legacySize = await fileSize(legacy);

  if (legacySize > 0 && (primarySize === 0 || legacySize > primarySize * 2)) {
    try {
      await rename(legacy, primary);
      return primary;
    } catch {
      return legacy;
    }
  }

  if (primarySize > 0) return primary;
  if (legacySize > 0) {
    try {
      await rename(legacy, primary);
      return primary;
    } catch {
      return legacy;
    }
  }
  return primary;
}

export async function ensureDataDir() {
  const dataDir = getMailDataDir();
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

export { appRoot };
