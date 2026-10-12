import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorizeJarvisMailReader, loadJarvisMailReader } from '../src/security/jarvis-mail-reader.js';

// Public synthetic test material, never an issued operational credential.
const credential = 'synthetic-jarvis-reader-fixture-not-a-real-key';
const principalId = 'jarvis-fixture-reader';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-reader-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'reader.key');
  await writeFile(keyFile, credential, { mode: 0o600 });
  return { directory, keyFile, env: {
    MAIL_INTELLIGENCE_JARVIS_READER_ENABLED: '1',
    MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID: principalId,
    MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: keyFile,
  } };
}

function request(overrides = {}) {
  return { method: 'GET', url: '/api/storage/status', headers: {
    'x-api-key': credential, 'x-principal-id': principalId, 'x-principal-kind': 'service',
  }, ...overrides };
}

test('reader binding is opt-in and a disabled binding denies machine requests', async () => {
  assert.equal(await loadJarvisMailReader({}), null);
  assert.equal(await loadJarvisMailReader({ MAIL_INTELLIGENCE_JARVIS_READER_ENABLED: '0' }), null);
  assert.throws(() => authorizeJarvisMailReader(request(), null), { code: 'JARVIS_READER_UNAUTHENTICATED' });
  assert.equal(authorizeJarvisMailReader({ headers: {} }, null), false);
});

test('partial, malformed and unsafe credential configuration fails closed', async (t) => {
  const { env, keyFile, directory } = await fixture(t);
  for (const patch of [
    { MAIL_INTELLIGENCE_JARVIS_READER_ENABLED: '' },
    { MAIL_INTELLIGENCE_JARVIS_READER_ENABLED: 'true' },
    { MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID: '' },
    { MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID: 'reader space' },
    { MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: 'relative.key' },
    { MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: directory },
    { MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: join(directory, 'missing') },
  ]) await assert.rejects(loadJarvisMailReader({ ...env, ...patch }), { code: 'JARVIS_READER_CONFIG_INVALID' });
  await chmod(keyFile, 0o644);
  await assert.rejects(loadJarvisMailReader(env), { code: 'JARVIS_READER_CONFIG_INVALID' });
  await chmod(keyFile, 0o600);
  const alias = join(directory, 'alias.key');
  await symlink(keyFile, alias);
  await assert.rejects(loadJarvisMailReader({ ...env, MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: alias }),
    { code: 'JARVIS_READER_CONFIG_INVALID' });
  for (const value of ['short', 'x'.repeat(5000), 'x'.repeat(32) + '\n' + 'y'.repeat(32)]) {
    await writeFile(keyFile, value);
    await assert.rejects(loadJarvisMailReader(env), { code: 'JARVIS_READER_CONFIG_INVALID' });
  }
});

test('reader refuses operator or draft credential reuse', async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(loadJarvisMailReader(env, { forbiddenCredentials: ['other', credential] }),
    { code: 'JARVIS_READER_CREDENTIAL_REUSE' });
});

test('only exact scoped GET is admitted and bad identity never falls back', async (t) => {
  const { env } = await fixture(t);
  const binding = await loadJarvisMailReader(env);
  assert.equal(authorizeJarvisMailReader(request(), binding), true);
  for (const patch of [
    { method: 'POST' }, { method: 'HEAD' }, { url: '/api/storage/status?all=1' },
    { url: '/api/session' }, { url: '/api/mail/send-drafts' }, { url: '/' },
  ]) assert.throws(() => authorizeJarvisMailReader(request(patch), binding),
    { code: 'JARVIS_READER_SCOPE_DENIED' });
  for (const field of ['x-api-key', 'x-principal-id', 'x-principal-kind']) {
    const req = request();
    req.headers[field] = 'wrong';
    assert.throws(() => authorizeJarvisMailReader(req, binding), { code: 'JARVIS_READER_UNAUTHENTICATED' });
    delete req.headers[field];
    assert.throws(() => authorizeJarvisMailReader(req, binding), { code: 'JARVIS_READER_UNAUTHENTICATED' });
  }
  for (const field of ['cookie', 'authorization', 'x-workspace-id']) {
    const req = request();
    req.headers[field] = '';
    assert.throws(() => authorizeJarvisMailReader(req, binding), { code: 'JARVIS_READER_AUTH_CONFLICT' });
  }
});
