import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, mkdir, chmod, rename } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  releaseDropInName, donorNames, managerDonorNames, releaseEnvironment,
  environmentFileRecords, assertEffectiveRelease,
} from './user-release-boundary.mjs';

const run = promisify(execFile);

/** Preserve existing private configuration; release setup never creates credentials. */
export async function prepareUserRelease({ codeRoot, dataDir, commit, managerEnvironment = '' }) {
  assert(isAbsolute(codeRoot) && isAbsolute(dataDir) && /^[A-Za-z0-9/_.-]+$/.test(codeRoot + dataDir), 'Literal absolute deployment paths are required');
  assert(/^[a-f0-9]{40}$/.test(commit) && basename(codeRoot) === commit, 'Exact immutable release directory is required');
  const version = JSON.parse(await readFile(join(codeRoot, 'VERSION.json'), 'utf8'));
  const serverBytes = await readFile(join(codeRoot, 'server.mjs'));
  assert.equal(version.commit, commit, 'Release identity does not match');
  assert.equal(version.serverSha256, createHash('sha256').update(serverBytes).digest('hex'), 'Release server bytes changed');
  const runtimeEnv = join(dataDir, 'runtime.env');
  for (const path of [runtimeEnv, join(dataDir, '.mail-intelligence-access-key')]) {
    const metadata = await lstat(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0, 'Existing private credentials/config are required');
  }
  const original = await readFile(runtimeEnv, 'utf8');
  const overrides = releaseEnvironment(dataDir, commit);
  const retained = environmentFileRecords(original)
    .filter(record => !record.donor && !Object.hasOwn(overrides, record.key))
    .map(record => record.raw).join('');
  const updated = retained + (retained.endsWith('\n') ? '' : '\n')
    + Object.entries(overrides).map(([key, value]) => `${key}=${value}\n`).join('');
  const template = await readFile(join(codeRoot, 'deploy/systemd/mail-intelligence.service'), 'utf8');
  const unit = template
    .replace(/^Documentation=.*$/m, `Documentation=file://${codeRoot}/docs/runbooks/UBUNTU-DEPLOYMENT.md`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${codeRoot}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${runtimeEnv}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=/usr/bin/node ${codeRoot}/server.mjs`)
    .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${dataDir} -/home/jm/.codex -/home/jm/.grok`);
  const unitDirectory = join(codeRoot, '.deployment');
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const unitPath = join(unitDirectory, 'mail-intelligence.service');
  await writeFile(unitPath, unit, { mode: 0o600 });
  await chmod(unitPath, 0o600);
  const dropInDirectory = join(unitDirectory, 'mail-intelligence.service.d');
  await mkdir(dropInDirectory, { recursive: true, mode: 0o700 });
  const dropIn = [
    '# Owned by Mail Intelligence explicit immutable release activation.',
    '[Service]',
    `WorkingDirectory=${codeRoot}`,
    'ExecStart=',
    `ExecStart=/usr/bin/node ${codeRoot}/server.mjs`,
    'EnvironmentFile=',
    `EnvironmentFile=${runtimeEnv}`,
    'Environment=',
    'Environment=HOME=/home/jm',
    'Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/jm/.local/bin:/home/jm/.grok/bin',
    'UnsetEnvironment=',
    `UnsetEnvironment=${[...new Set([...donorNames, ...managerDonorNames(managerEnvironment)])].join(' ')}`,
    'ReadWritePaths=',
    `ReadWritePaths=${dataDir} -/home/jm/.codex -/home/jm/.grok`,
    '',
  ].join('\n');
  await writeFile(join(dropInDirectory, releaseDropInName), dropIn, { mode: 0o600 });
  await chmod(join(dropInDirectory, releaseDropInName), 0o600);
  await writeFile(join(unitDirectory, 'runtime.env'), updated, { mode: 0o600 });
  await chmod(join(unitDirectory, 'runtime.env'), 0o600);
  await writeFile(join(unitDirectory, 'release-plan.json'), JSON.stringify({
    codeRoot, dataDir, commit,
    originalRuntimeSha256: createHash('sha256').update(original).digest('hex'),
    preparedRuntimeSha256: createHash('sha256').update(updated).digest('hex'),
  }), { mode: 0o600 });
  // Preparation is local only. Operational runtime.env is changed only after a
  // daemon reload and an authoritative merged-boundary proof in activation.
  await run('systemd-analyze', ['--user', 'verify', unitPath], { timeout: 10_000 });
  return unitPath;
}

export async function commitUserReleaseEnvironment({ codeRoot, dataDir, commit, properties, managerEnvironment, ownedDropInPath }) {
  const plan = JSON.parse(await readFile(join(codeRoot, '.deployment/release-plan.json'), 'utf8'));
  assert(plan.codeRoot === codeRoot && plan.dataDir === dataDir && plan.commit === commit, 'Prepared release plan mismatch');
  const updated = await readFile(join(codeRoot, '.deployment/runtime.env'), 'utf8');
  assert(createHash('sha256').update(updated).digest('hex') === plan.preparedRuntimeSha256, 'Prepared environment changed');
  assertEffectiveRelease({ properties, runtimeText: updated, managerEnvironment, codeRoot, dataDir, commit, ownedDropInPath });
  const runtimeEnv = join(dataDir, 'runtime.env');
  const original = await readFile(runtimeEnv);
  assert(createHash('sha256').update(original).digest('hex') === plan.originalRuntimeSha256, 'Operational environment changed since preparation');
  const temporaryEnv = `${runtimeEnv}.release-${randomUUID()}`;
  await writeFile(temporaryEnv, updated, { mode: 0o600, flag: 'wx' });
  await rename(temporaryEnv, runtimeEnv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [codeRoot, dataDir, commit] = process.argv.slice(2);
  process.stdout.write(`${await prepareUserRelease({ codeRoot, dataDir, commit })}\n`);
}
