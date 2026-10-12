import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { prepareUserRelease, commitUserReleaseEnvironment } from './prepare-user-release.mjs';
import { releaseDropInName, assertEffectiveRelease, assertReleaseEnvironment } from './user-release-boundary.mjs';

const run = promisify(execFile);
const service = 'mail-intelligence.service';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const systemctl = async (...args) => (await run('systemctl', ['--user', ...args], { timeout: 35_000 })).stdout.trimEnd();
const effective = () => systemctl('show', service, '-p', 'ExecStart', '-p', 'WorkingDirectory',
  '-p', 'EnvironmentFiles', '-p', 'Environment', '-p', 'UnsetEnvironment', '-p', 'DropInPaths');

async function replacePrivateFile(path, bytes, mode = 0o600) {
  const temporary = `${path}.release-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Explicit owner activation only; preparation/tests never call this entry point. */
export async function activateUserRelease({ codeRoot, dataDir, commit }) {
  await systemctl('is-active', service);
  const fragment = await systemctl('show', service, '-p', 'FragmentPath', '--value');
  assert(fragment, 'Existing user service is required');
  const configRoot = process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config');
  const dropInDirectory = join(configRoot, 'systemd/user', `${service}.d`);
  const ownedDropInPath = join(dropInDirectory, releaseDropInName);
  let originalDropIn;
  let originalMode;
  try {
    const metadata = await lstat(ownedDropInPath);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), 'Owned drop-in must be a regular file');
    originalDropIn = await readFile(ownedDropInPath);
    assert(originalDropIn.toString().startsWith('# Owned by Mail Intelligence explicit immutable release activation.\n'),
      'Refusing to replace another owner drop-in');
    originalMode = metadata.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const managerEnvironment = await systemctl('show-environment');
  await prepareUserRelease({ codeRoot, dataDir, commit, managerEnvironment });
  const runtimePath = join(dataDir, 'runtime.env');
  const originalRuntime = await readFile(runtimePath);
  const preparedRuntime = await readFile(join(codeRoot, '.deployment/runtime.env'), 'utf8');
  const preparedDropIn = await readFile(join(codeRoot, '.deployment', `${service}.d`, releaseDropInName));
  const context = { codeRoot, dataDir, commit, ownedDropInPath };
  let dropInChanged = false;
  let runtimeChanged = false;
  let restartAttempted = false;
  try {
    await mkdir(dropInDirectory, { recursive: true, mode: 0o700 });
    await replacePrivateFile(ownedDropInPath, preparedDropIn);
    dropInChanged = true;
    await systemctl('daemon-reload');
    await commitUserReleaseEnvironment({
      ...context, properties: await effective(),
      managerEnvironment: await systemctl('show-environment'),
    });
    runtimeChanged = true;
    assertEffectiveRelease({
      ...context, properties: await effective(), runtimeText: await readFile(runtimePath, 'utf8'),
      managerEnvironment: await systemctl('show-environment'),
    });
    restartAttempted = true;
    await systemctl('restart', service);
    // This is an operational health deadline, not a test sleep. curl bounds each
    // read; the outer monitor owns the wait and receives the final outcome.
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await run('curl', ['--silent', '--fail', '--max-time', '2',
          '--output', '/dev/null', '--write-out', '%{http_code}', 'http://127.0.0.1:3010/api/health'], { timeout: 3_000 });
        if (health.stdout === '200') {
          healthy = true;
          break;
        }
      } catch (error) {
        if (error.code !== 22 && error.code !== 7 && error.code !== 28) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(healthy, 'Release health did not reach HTTP 200');
    await systemctl('is-active', service);
    const pid = await systemctl('show', service, '-p', 'MainPID', '--value');
    assert(/^[1-9][0-9]*$/.test(pid), 'Release has no live MainPID');
    assert(await realpath(`/proc/${pid}/cwd`) === codeRoot, 'Loaded release working directory mismatch');
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    assert(argv.length === 2 && argv[0] === '/usr/bin/node' && argv[1] === `${codeRoot}/server.mjs`,
      'Loaded release command mismatch');
    const processEnvironment = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8'))
      .split('\0').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assertReleaseEnvironment(processEnvironment, context);
    const version = JSON.parse(await readFile(join(codeRoot, 'VERSION.json'), 'utf8'));
    assert(version.commit === commit && version.serverSha256 === digest(await readFile(join(codeRoot, 'server.mjs'))),
      'Loaded artifact bytes changed');
    assert(digest(await readFile(runtimePath)) === digest(preparedRuntime), 'Operational runtime changed during activation');
    assertEffectiveRelease({
      ...context, properties: await effective(), runtimeText: preparedRuntime,
      managerEnvironment: await systemctl('show-environment'),
    });
    process.stdout.write(`MAIL_RELEASE_ACTIVE commit=${commit} pid=${pid} health=200 donor_assignments=0\n`);
  } catch (error) {
    // Restore only our runtime rewrite and our owned drop-in. Base/90/91/92,
    // SQLite and token caches are never edited or rewound by this operation.
    if (runtimeChanged) await replacePrivateFile(runtimePath, originalRuntime);
    if (dropInChanged) {
      if (originalDropIn) await replacePrivateFile(ownedDropInPath, originalDropIn, originalMode);
      else await rm(ownedDropInPath);
      await systemctl('daemon-reload');
    }
    if (restartAttempted) {
      await systemctl('restart', service);
      await systemctl('is-active', service);
    }
    process.stderr.write(`MAIL_RELEASE_ROLLBACK runtime=${runtimeChanged} restart=${restartAttempted}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [codeRoot, dataDir, commit] = process.argv.slice(2);
  await activateUserRelease({ codeRoot, dataDir, commit });
}
