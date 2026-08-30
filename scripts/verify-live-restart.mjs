#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = 'http://127.0.0.1:3010';
const key = (await readFile(new URL('../data/.mail-intelligence-access-key', import.meta.url), 'utf8')).trim();
const authorization = `Basic ${Buffer.from(`mailintelligence:${key}`, 'utf8').toString('base64')}`;

const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.ok, true);
assert.equal(health.version, '1.2.0');

const root = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
assert.equal(root.status, 200);
const cookie = (root.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^mi_session=/);
await root.arrayBuffer();

const storageResponse = await fetch(`${baseUrl}/api/storage/status`, {
  headers: { Cookie: cookie },
  cache: 'no-store',
});
const storage = await storageResponse.json();
assert.equal(storageResponse.status, 200);
assert.equal(storage.authoritativeStore, 'sqlite');
assert.equal(storage.schemaVersion, 4);
assert.equal(storage.ready, true);
assert.equal(storage.integrity?.ok, true);
assert.ok((storage.counts?.backup_manifests || 0) >= 1);
assert.ok((storage.counts?.operator_jobs || 0) >= 1);

const precisionResponse = await fetch(`${baseUrl}/api/intelligence/summary`, {
  headers: { Cookie: cookie },
  cache: 'no-store',
});
const precision = await precisionResponse.json();
assert.equal(precisionResponse.status, 200);
assert.equal(precision.total, storage.counts?.precision_classifications || 0);

console.log(JSON.stringify({
  restartPersistence: 'PASS',
  version: health.version,
  service: health.service,
  sqliteReady: storage.ready,
  schemaVersion: storage.schemaVersion,
  integrity: storage.integrity,
  backupManifests: storage.counts.backup_manifests,
  operatorJobs: storage.counts.operator_jobs,
  messages: storage.counts.messages,
  precisionClassifications: storage.counts.precision_classifications,
  precisionCorrections: storage.counts.precision_corrections,
  projects: storage.counts.projects,
  reviewRequired: precision.reviewRequired,
}, null, 2));
