#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import {
  assertMutationAllowed,
  delegatedScopesForSafety,
  getSafetyPolicy,
  normalizeLoopbackHost,
} from '../src/safety.js';

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const policy = getSafetyPolicy();
assert.equal(policy.mode, 'read-only');
assert.equal(policy.policyVersion, 'read-only-v1.2.0');
assert.ok(Object.keys(policy.capabilities).length > 0, 'safety capabilities must be explicit');
assert.ok(
  Object.values(policy.capabilities).every((value) => value === false),
  'every v1.2.0 mutation capability must remain disabled',
);

const delegatedScopes = delegatedScopesForSafety().split(/\s+/).filter(Boolean);
assert.ok(delegatedScopes.includes('Mail.Read'), 'Mail.Read must be present');
assert.equal(delegatedScopes.includes('Mail.Send'), false, 'Mail.Send must not be requested');
assert.equal(delegatedScopes.includes('Mail.ReadWrite'), false, 'Mail.ReadWrite must not be requested');

assert.equal(normalizeLoopbackHost('127.0.0.1'), '127.0.0.1');
assert.equal(normalizeLoopbackHost('localhost'), 'localhost');
assert.equal(normalizeLoopbackHost('::1'), '::1');
assert.throws(() => normalizeLoopbackHost('0.0.0.0'), /not allowed/i);
assert.throws(() => assertMutationAllowed('mailSend', policy), /disabled/i);

const [
  serverSource,
  appSource,
  indexSource,
  proxySource,
  proxyUnitSource,
  ciSource,
  releaseSource,
  packageSource,
  gitignoreSource,
  configExampleSource,
] = await Promise.all([
  readFile('server.mjs', 'utf8'),
  readFile('src/app.js', 'utf8'),
  readFile('src/index.html', 'utf8'),
  readFile('src/security/tcp-allowlist-proxy.js', 'utf8'),
  readFile('deploy/systemd/mail-intelligence-tailnet.service', 'utf8'),
  readFile('.github/workflows/ci.yml', 'utf8'),
  readFile('.github/workflows/cd.yml', 'utf8'),
  readFile('package.json', 'utf8'),
  readFile('.gitignore', 'utf8'),
  readFile('.outlook-config.json.example', 'utf8'),
]);
const packageJson = JSON.parse(packageSource);
const configExample = JSON.parse(configExampleSource);
assert.equal(packageJson.version, '1.2.0');
assert.match(packageJson.scripts['verify:v1.2.0'], /verify:safety/);
assert.match(packageJson.scripts.check, /persistent-mail-memory\.js/);
assert.match(packageJson.scripts.check, /precision-intelligence\.js/);
assert.match(packageJson.scripts.check, /precision-classifier\.js/);
assert.match(packageJson.scripts.check, /intelligent-search\.js/);
assert.match(packageJson.scripts.check, /evaluate-precision-classification\.mjs/);
assert.match(packageJson.scripts.check, /tcp-allowlist-proxy\.js/);
assert.match(packageJson.scripts.check, /verify-tailnet-exposure\.mjs/);
assert.match(packageJson.scripts['verify:v1.2.0'], /evaluate:precision/);
assert.match(packageJson.scripts.check, /backup-restore\.js/);

assert.equal(serverSource.includes('/sendMail'), false, 'Graph sendMail implementation must not exist');
assert.equal(/method:\s*['"]PATCH['"]/.test(serverSource), false, 'Graph PATCH mutation must not exist');
assert.equal(serverSource.includes('notifyDataPlaneHook'), false, 'data-plane mutation helper must not exist');
assert.equal(serverSource.includes('Mail.Send'), false, 'server must not request Mail.Send');
assert.equal(serverSource.includes('Mail.ReadWrite'), false, 'server must not request Mail.ReadWrite');
assert.match(serverSource, /join\(appRoot, 'data'\)/);
assert.match(serverSource, /MAIL_INTELLIGENCE_LEGACY_DATA_DIR/);
assert.match(serverSource, /PersistentMailMemoryRuntime/);
assert.match(serverSource, /mail-intelligence\.sqlite/);
assert.equal(serverSource.includes('loadMailCache'), false, 'runtime must not use JSON mail cache as authoritative storage');
assert.equal(serverSource.includes('updateMailCache'), false, 'runtime must not write authoritative mail state to JSON');
assert.equal(serverSource.includes('/api/storage/restore'), false, 'restore must remain offline-only');
assert.match(serverSource, /\/api\/storage\/backup/);
assert.match(serverSource, /\/api\/intelligence\/search/);
assert.match(serverSource, /\/api\/intelligence\/correct/);
assert.match(serverSource, /\/api\/intelligence\/projects/);
assert.match(serverSource, /PRECISION_CLASSIFICATION_VERSION/);
assert.match(serverSource, /MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS/);
assert.match(serverSource, /parseTailnetAllowedHosts/);
assert.equal(configExample.aiProvider, 'rules');
for (const secretKey of ['accessToken', 'refreshToken', 'clientSecret', 'geminiApiKey', 'expiresAt']) {
  assert.equal(Object.hasOwn(configExample, secretKey), false, `secret key must not be present in config example: ${secretKey}`);
}

assert.equal(appSource.includes('/api/outlook/send'), false, 'UI must not call the send endpoint');
assert.equal(appSource.includes('/api/outlook/read'), false, 'UI must not call the read-state endpoint');
assert.equal(appSource.includes('markMessageRead('), false, 'UI must not mark messages read automatically');
assert.match(
  appSource,
  /X-Mail-Intelligence-Request/,
  'authenticated deployments must send the additional local mutation-protection header',
);
assert.match(indexSource, /id="aiDataPolicyAccepted"/);
assert.match(indexSource, /Google API로 전송/);
assert.match(indexSource, /v1\.2\.0 · Precision Intelligence/);
assert.match(indexSource, /id="precisionIntelligence"/);
assert.match(indexSource, /프로젝트는 자동 생성하지 않습니다/);
assert.match(appSource, /aiDataPolicyAccepted:\s*aiProvider\.value === 'gemini'/);
assert.match(appSource, /\/api\/intelligence\/search/);
assert.match(appSource, /\/api\/intelligence\/correct/);

assert.match(proxySource, /Proxy bind host must be one explicit non-loopback IPv4 address/);
assert.match(proxySource, /Proxy target host must remain on IPv4 loopback/);
assert.match(proxySource, /100\.64\.0\.0\/10/);
assert.match(proxySource, /clientAddressAllowed/);
assert.doesNotMatch(proxySource, /server\.listen\(config\.bindPort, '0\.0\.0\.0'\)/);
assert.match(proxyUnitSource, /tailnet-only TCP exposure/);
assert.match(proxyUnitSource, /data\/tailnet-proxy\.env/);
assert.match(proxyUnitSource, /run-tailnet-proxy\.mjs/);
assert.match(proxyUnitSource, /NoNewPrivileges=true/);
assert.equal(proxyUnitSource.includes('User=root'), false);

assert.equal(/\|\|\s*true/.test(ciSource), false, 'CI must not ignore verification failures');
assert.equal(packageJson.engines?.node, '>=22', 'Node.js 22+ is required for node:sqlite verification');
assert.match(ciSource, /node-version:\s*['"]22['"]/);
assert.match(releaseSource, /workflow_dispatch/);
assert.equal(/^\s*push:/m.test(releaseSource), false, 'release packaging must not run on push');
assert.match(releaseSource, /NODE_VERSION:\s*['"]22['"]/);
assert.match(releaseSource, /migrations deploy \.github/);
assert.match(releaseSource, /tar -xzf/);
assert.match(releaseSource, /npm run verify:v1\.2\.0/);
for (const pattern of ['mail-intelligence.sqlite', '*.sqlite-wal', '*.sqlite-shm', '/data/', '/backups/']) {
  assert.ok(gitignoreSource.includes(pattern), `runtime storage ignore rule missing: ${pattern}`);
}
assert.match(
  releaseSource,
  /No SSH, server restart, deployment, mail mutation, or external publication was performed/,
);

for (const duplicateRootFile of ['app.js', 'index.html', 'styles.css', 'architecture.html']) {
  assert.equal(await fileExists(duplicateRootFile), false, `${duplicateRootFile} must not duplicate src/ assets`);
}

console.log('[verify-safety-contract] PASS read-only-v1.2.0');
