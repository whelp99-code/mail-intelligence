import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStoragePaths } from '../src/storage/storage-paths.js';

const moduleUrl = new URL('../src/storage/storage-paths.js', import.meta.url).href;
const appRoot = dirname(fileURLToPath(new URL('../server.mjs', import.meta.url)));

test('default persistent storage is isolated under the project data directory', () => {
  const paths = resolveStoragePaths({ env: {}, moduleUrl });
  assert.equal(paths.appRoot, appRoot);
  assert.equal(paths.dataDir, join(appRoot, 'data'));
  assert.equal(paths.databasePath, join(appRoot, 'data', 'mail-intelligence.sqlite'));
  assert.equal(paths.legacyCachePath, join(appRoot, 'data', '.mail-cache.json'));
  assert.equal(paths.configPath, join(appRoot, 'data', '.outlook-config.json'));
});

test('explicit storage environment paths override defaults', () => {
  const paths = resolveStoragePaths({
    env: {
      MAIL_INTELLIGENCE_DATA_DIR: '/tmp/mail-intelligence-data',
      MAIL_INTELLIGENCE_DB_PATH: '/tmp/mail-intelligence-db/custom.sqlite',
      MAIL_INTELLIGENCE_LEGACY_CACHE_PATH: '/tmp/mail-intelligence-cache.json',
      MAIL_INTELLIGENCE_CONFIG_PATH: '/tmp/mail-intelligence-config.json',
    },
    moduleUrl,
  });
  assert.equal(paths.dataDir, resolve('/tmp/mail-intelligence-data'));
  assert.equal(paths.databasePath, resolve('/tmp/mail-intelligence-db/custom.sqlite'));
  assert.equal(paths.legacyCachePath, resolve('/tmp/mail-intelligence-cache.json'));
  assert.equal(paths.configPath, resolve('/tmp/mail-intelligence-config.json'));
});
