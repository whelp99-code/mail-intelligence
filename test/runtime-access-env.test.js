import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ACCESS_USERNAME,
  NEW_ACCESS_KEY_PATTERN,
  resolveRuntimeAccess,
  writeRuntimeAccessEnv,
} from '../src/security/runtime-access-env.js';

const syntheticUser = 'synthetic-operator';
const syntheticKey = 'synthetic key ! not-a-token';
const fileKey = 'a'.repeat(48);

async function tempData() {
  return mkdtemp(join(tmpdir(), 'mail-runtime-access-'));
}

test('an existing login id and access key are copied unchanged', async () => {
  const dataDir = await tempData();
  try {
    await writeFile(join(dataDir, 'runtime.env'), [
      `MAIL_INTELLIGENCE_ACCESS_USER=${syntheticUser}`,
      `MAIL_INTELLIGENCE_ACCESS_KEY=${syntheticKey}`,
      'MAIL_INTELLIGENCE_ALLOW_SEND=1',
      '',
    ].join('\n'));
    await writeFile(join(dataDir, '.mail-intelligence-access-key'), fileKey);
    const written = await writeRuntimeAccessEnv({
      dataDir,
      allowedProxyHosts: '100.64.0.1',
      generateKey: () => { throw new Error('must not create a key'); },
    });
    const text = await readFile(join(dataDir, 'runtime.env'), 'utf8');
    assert.equal(written.username, syntheticUser);
    assert.match(text, new RegExp(`^MAIL_INTELLIGENCE_ACCESS_USER=${syntheticUser}$`, 'm'));
    assert.match(text, new RegExp(`^MAIL_INTELLIGENCE_ACCESS_KEY=${syntheticKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal(text.includes(fileKey), false);
    assert.match(text, /^MAIL_INTELLIGENCE_ALLOW_SEND=0$/m);
    assert.equal(await readFile(join(dataDir, '.mail-intelligence-access-key'), 'utf8'), fileKey);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a preserved key skips the new-key shape check', () => {
  const resolved = resolveRuntimeAccess({
    existingText: `MAIL_INTELLIGENCE_ACCESS_USER=${syntheticUser}\nMAIL_INTELLIGENCE_ACCESS_KEY=short\n`,
    keyFileText: 'nope',
    generateKey: () => { throw new Error('must not create a key'); },
  });
  assert.equal(resolved.username, syntheticUser);
  assert.equal(resolved.accessKey, 'short');
  assert.equal(resolved.createdKey, false);
  assert.equal(NEW_ACCESS_KEY_PATTERN.test(resolved.accessKey), false);
});

test('a missing key is created and must match the new-key shape', async () => {
  const dataDir = await tempData();
  const created = 'b'.repeat(48);
  try {
    await writeFile(join(dataDir, 'runtime.env'), `MAIL_INTELLIGENCE_ACCESS_USER=${syntheticUser}\nMAIL_INTELLIGENCE_ACCESS_KEY=\n`);
    const written = await writeRuntimeAccessEnv({
      dataDir,
      generateKey: () => created,
    });
    const text = await readFile(join(dataDir, 'runtime.env'), 'utf8');
    assert.equal(written.username, syntheticUser);
    assert.match(text, new RegExp(`^MAIL_INTELLIGENCE_ACCESS_KEY=${created}$`, 'm'));
    assert.equal(await readFile(join(dataDir, '.mail-intelligence-access-key'), 'utf8'), created);
    assert.equal(NEW_ACCESS_KEY_PATTERN.test(created), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a new key file that fails the shape check is rejected', async () => {
  const dataDir = await tempData();
  try {
    await writeFile(join(dataDir, '.mail-intelligence-access-key'), 'nope');
    await assert.rejects(
      () => writeRuntimeAccessEnv({ dataDir, generateKey: () => 'also-nope' }),
      { code: 'ACCESS_KEY_INVALID' },
    );
    await assert.rejects(readFile(join(dataDir, 'runtime.env'), 'utf8'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a missing login id becomes the historical username and keeps the stored key', () => {
  const resolved = resolveRuntimeAccess({
    existingText: 'MAIL_INTELLIGENCE_ACCESS_KEY=kept-value\n',
    generateKey: () => { throw new Error('must not create a key'); },
  });
  assert.equal(resolved.username, DEFAULT_ACCESS_USERNAME);
  assert.equal(resolved.accessKey, 'kept-value');
});

test('the activator prints the preserved username instead of the historical default', async () => {
  const source = await readFile(new URL('../scripts/activate-user-service.sh', import.meta.url), 'utf8');
  assert.match(source, /write-runtime-access-env\.mjs/);
  assert.match(source, /printf 'Access username: %s\\n' "\$ACCESS_USERNAME"/);
  assert.doesNotMatch(source, /Access username: mailintelligence/);
  assert.doesNotMatch(source, /ACCESS_KEY=~ \^\[A-Za-z0-9_-\]\{40,\}/);
});
