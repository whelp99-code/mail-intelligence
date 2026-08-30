import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveStoragePaths({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const appRoot = dirname(fileURLToPath(new URL('../../server.mjs', moduleUrl)));
  const dataDir = resolve(env.MAIL_INTELLIGENCE_DATA_DIR || join(appRoot, 'data'));
  const databasePath = resolve(env.MAIL_INTELLIGENCE_DB_PATH || join(dataDir, 'mail-intelligence.sqlite'));
  const legacyCachePath = resolve(env.MAIL_INTELLIGENCE_LEGACY_CACHE_PATH || join(dataDir, '.mail-cache.json'));
  const configPath = resolve(env.MAIL_INTELLIGENCE_CONFIG_PATH || join(dataDir, '.outlook-config.json'));
  return { appRoot, dataDir, databasePath, legacyCachePath, configPath };
}
