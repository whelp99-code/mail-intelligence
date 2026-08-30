import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runAdmin(dataDir, args) {
  const result = spawnSync(process.execPath, ['scripts/mail-memory-admin.mjs', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
    },
    encoding: 'utf8',
  });
  let body = {};
  try {
    body = JSON.parse(result.stdout || result.stderr || '{}');
  } catch {
    // Assertions below include the full process output.
  }
  return { ...result, body };
}

test('mail-memory admin CLI supports status, integrity, verified backup and offline restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-admin-'));
  const backupPath = join(dataDir, 'external-backup.sqlite');
  try {
    let result = runAdmin(dataDir, ['status']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.body.authoritativeStore, 'sqlite');
    assert.equal(result.body.ready, true);
    assert.equal(result.body.schemaVersion, 4);

    result = runAdmin(dataDir, ['integrity']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.quickCheck, ['ok']);
    assert.deepEqual(result.body.foreignKeyErrors, []);

    result = runAdmin(dataDir, ['backup', backupPath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.body.validation.ok, true);
    assert.equal(result.body.schemaVersion, 4);
    assert.match(result.body.checksumSha256, /^[a-f0-9]{64}$/);
    await access(backupPath);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

    result = runAdmin(dataDir, ['restore', backupPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.body.message || result.stderr, /confirmServerStopped=true/);

    result = runAdmin(dataDir, ['restore', backupPath, '--confirm-stopped']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.body.restored, true);
    assert.equal(result.body.validation.ok, true);
    assert.ok(result.body.rollbackPath);
    await access(result.body.rollbackPath);
    assert.equal((await stat(result.body.rollbackPath)).mode & 0o777, 0o600);

    result = runAdmin(dataDir, ['integrity']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.body.ok, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
