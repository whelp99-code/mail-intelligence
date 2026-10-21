import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as boundary from '../scripts/user-release-boundary.mjs';

const { donorNames, releaseDropInName, releaseEnvironment } = boundary;

const actions = ['ACTIONS_APPROVED', 'ALLOW_MAIL_MUTATIONS', 'ALLOW_DATA_PLANE', 'ALLOW_EXTERNAL_AI'];
const text = environment => Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join('');

// All command execution and /proc access are mocked before importing activation.
// Ordinary file IO below is confined to a synthetic temporary directory.
test('activation rollback re-proves restored safety before restarting', async t => {
  // Block the actual subprocess boundary before any executable module import.
  // This catches even an execFile promisify.custom that bypasses a public mock.
  mock.method(childProcess.ChildProcess.prototype, 'spawn', () => {
    throw new Error('Real subprocess forbidden in activation harness');
  });
  for (const method of ['spawnSync', 'execSync', 'execFileSync']) {
    mock.method(childProcess, method, () => { throw new Error('Real subprocess forbidden in activation harness'); });
  }
  const realRead = fs.readFile.bind(fs);
  const realRealpath = fs.realpath.bind(fs);
  let current;
  const fakeExec = () => { throw new Error('Unexpected callback command'); };
  fakeExec[promisify.custom] = async (command, args) => {
    assert(current, 'Command outside fixture');
    if (command === 'systemd-analyze') return { stdout: '' };
    if (command === 'curl') return { stdout: '200' };
    assert.equal(command, 'systemctl');
    assert.equal(args[0], '--user');
    const operation = args[1];
    if (operation === 'is-active' || operation === 'daemon-reload') return { stdout: 'active' };
    if (operation === 'show-environment') return { stdout: current.manager || '' };
    if (operation === 'restart') {
      current.restarts++;
      if (current.restarts === 2) {
        assert.equal(await realRead(join(current.dataDir, 'runtime.env'), 'utf8'), current.originalRuntime);
        assert.equal(current.processRead, true);
      }
      return { stdout: '' };
    }
    assert.equal(operation, 'show');
    if (args.includes('FragmentPath')) return { stdout: '/synthetic/base.service' };
    if (args.includes('MainPID')) return { stdout: '987654321' };
    const restored = current.restarts > 0 && (await realRead(join(current.dataDir, 'runtime.env'), 'utf8')) === current.originalRuntime;
    let properties = current.properties(restored ? current.oldRoot : current.codeRoot);
    // Force final proof rejection after the new process was successfully read.
    if (current.processRead && !restored && !current.success) {
      current.finalProofRead = true;
      if (!current.trailingRace) properties = properties.replace(`WorkingDirectory=${current.codeRoot}`, 'WorkingDirectory=/synthetic/rejected');
    }
    if (restored && current.propertyMutation) properties = current.propertyMutation(properties);
    return { stdout: properties };
  };
  const originalExec = childProcess.execFile;
  childProcess.execFile = fakeExec;
  mock.method(fs, 'readFile', async (path, ...args) => {
    const name = String(path);
    if (name.startsWith('/proc/')) {
      assert(current, 'Proc read outside fixture');
      if (name.endsWith('/cmdline')) return `/usr/bin/node\0${current.codeRoot}/server.mjs\0`;
      assert(name.endsWith('/environ'));
      current.processRead = true;
      await current.mutate?.();
      return text({ ...releaseEnvironment(current.dataDir, current.commit),
        ...(current.processSend === undefined ? {} : { MAIL_INTELLIGENCE_ALLOW_SEND: current.processSend }) }).replaceAll('\n', '\0');
    }
    assert(!current || name !== join(current.oldRoot, 'VERSION.json'), 'Legacy VERSION must not be required');
    return realRead(path, ...args);
  });
  mock.method(fs, 'realpath', async path => {
    if (String(path) === '/proc/987654321/cwd') return current.codeRoot;
    return realRealpath(path);
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = originalExec; mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => childProcess.spawn('/usr/bin/systemctl', ['--user', 'restart', 'mail-intelligence.service']), /Real subprocess forbidden/);
  assert.equal(typeof fakeExec[promisify.custom], 'function');
  const { activateUserRelease } = await import('../scripts/activate-user-release.mjs');

  const scenarios = [
    ...['0', '1'].flatMap(send => [
      { name: `activation succeeds runtime send${send}, mail-send${send}, empty hold`, send, success: true },
      { name: `safe rollback preserves runtime send${send}, mail-send${send}, empty hold`, send, safe: true, owned: true },
    ]),
    ...['2', undefined].map(send => ({ name: `preparation rejects runtime send ${send}`, send, early: true })),
    ...['2', undefined, 'true', ' '].map(processSend => ({ name: `final process rejects send ${processSend}`, processSend, processFailure: true, safe: true })),
    { name: 'safe old commit without old VERSION and existing owned zz', safe: true, owned: true },
    { name: 'safe old commit without owned zz or old VERSION', safe: true },
    ...['mail-send.env', 'hold.env'].flatMap(file => [
      ...actions.map(key => ({ name: `${file} race enables ${key}`, file, addition: `MAIL_INTELLIGENCE_${key}=1\n` })),
      ...['2', 'true', '" "'].map(value => ({ name: `${file} race invalid send ${value}`, file, addition: `MAIL_INTELLIGENCE_ALLOW_SEND=${value}\n` })),
      { name: `${file} race enables calendar`, file, addition: 'MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED=1\n' },
      { name: `${file} race adds donor`, file, addition: 'COMPANY_MEMORY_UNKNOWN=synthetic-secret-do-not-print\n' },
      { name: `${file} disappears after precheck`, file, remove: true },
    ]),
    { name: 'restored runtime itself unsafe', unsafeRuntime: true },
    { name: 'manager race without matching unset', managerRace: true },
    { name: 'restored chain optional file refused', propertyMutation: p => p.replace('(ignore_errors=no)', '(ignore_errors=yes)') },
    { name: 'restored chain reordered refused', propertyMutation: p => p.replaceAll('mail-send.env', 'swap.env').replaceAll('hold.env', 'mail-send.env').replaceAll('swap.env', 'hold.env') },
    { name: 'restored unit environment donor refused', propertyMutation: p => p.replace('Environment=HOME=', 'Environment=COMPANY_MEMORY_UNKNOWN=synthetic-secret-do-not-print HOME=') },
    { name: 'restored UnsetEnvironment missing refused', propertyMutation: p => p.replace(/^UnsetEnvironment=.*\n/m, '') },
    { name: 'restored UnsetEnvironment removes action refused', propertyMutation: p => p.replace(`UnsetEnvironment=${donorNames.join(' ')}`, `UnsetEnvironment=${donorNames.join(' ')} MAIL_INTELLIGENCE_ALLOW_SEND`) },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mail-rollback-'));
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const commit = 'a'.repeat(40);
    const codeRoot = join(directory, commit);
    const oldRoot = join(directory, 'legacy-without-version');
    const dataDir = join(directory, 'data');
    const config = join(directory, 'config');
    const drop = join(config, 'systemd/user/mail-intelligence.service.d', releaseDropInName);
    process.env.XDG_CONFIG_HOME = config;
    try {
      await fs.mkdir(join(codeRoot, 'deploy/systemd'), { recursive: true });
      await fs.mkdir(dataDir);
      await fs.mkdir(oldRoot);
      const server = '// synthetic rollback server\n';
      await fs.writeFile(join(codeRoot, 'server.mjs'), server);
      await fs.writeFile(join(codeRoot, 'VERSION.json'), JSON.stringify({ commit, serverSha256: createHash('sha256').update(server).digest('hex') }));
      await fs.writeFile(join(codeRoot, 'deploy/systemd/mail-intelligence.service'), await realRead(new URL('../deploy/systemd/mail-intelligence.service', import.meta.url)));
      const send = Object.hasOwn(scenario, 'send') ? scenario.send : '0';
      const originalRuntime = text({ ...releaseEnvironment(dataDir, 'b'.repeat(40)),
        ...(send === undefined ? {} : { MAIL_INTELLIGENCE_ALLOW_SEND: send }),
        ...(scenario.unsafeRuntime ? { MAIL_INTELLIGENCE_ACTIONS_APPROVED: '1' } : {}) });
      await fs.writeFile(join(dataDir, 'runtime.env'), originalRuntime, { mode: 0o600 });
      await fs.writeFile(join(dataDir, '.mail-intelligence-access-key'), 'synthetic-only', { mode: 0o600 });
      for (const file of ['mail-send.env', 'hold.env']) await fs.writeFile(join(dataDir, file), '# synthetic unchanged\n');
      const trailingSend = scenario.send === '0' || scenario.send === '1' ? `MAIL_INTELLIGENCE_ALLOW_SEND=${send}\n` : '';
      await fs.appendFile(join(dataDir, 'mail-send.env'), trailingSend);
      const oldDrop = '# Owned by Mail Intelligence explicit immutable release activation.\n[Service]\n# synthetic old owned zz\n';
      if (scenario.owned) {
        await fs.mkdir(join(config, 'systemd/user/mail-intelligence.service.d'), { recursive: true });
        await fs.writeFile(drop, oldDrop, { mode: 0o640 });
      }
      current = { codeRoot, oldRoot, dataDir, commit, originalRuntime, restarts: 0, processRead: false,
        success: scenario.success, processSend: scenario.processFailure ? scenario.processSend : send,
        trailingRace: Boolean(scenario.file), finalProofRead: false,
        propertyMutation: scenario.propertyMutation,
        properties: root => [
          `WorkingDirectory=${root}`,
          `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${root}/server.mjs ; ignore_errors=no ; pid=0 ; code=(null) ; status=0/0 }`,
          ...['runtime.env', 'mail-send.env', 'hold.env'].map(file => `EnvironmentFiles=${join(dataDir, file)} (ignore_errors=no)`),
          'Environment=HOME=/synthetic',
          `UnsetEnvironment=${donorNames.join(' ')}`,
          `DropInPaths=${drop}`,
          '',
        ].join('\n'),
        mutate: async () => {
          if (scenario.file) {
            const path = join(dataDir, scenario.file);
            if (scenario.remove) await fs.rm(path);
            else await fs.appendFile(path, scenario.addition);
          }
          if (scenario.managerRace) current.manager = 'COMPANY_MEMORY_UNKNOWN=synthetic-secret-do-not-print';
        },
      };
      let failure;
      try { await activateUserRelease({ codeRoot, dataDir, commit }); } catch (error) { failure = error; }
      if (scenario.early) {
        assert.match(failure?.message || '', /ALLOW_SEND/);
        assert.equal(current.restarts, 0);
        assert.equal(current.processRead, false);
        assert.equal(await realRead(join(dataDir, 'runtime.env'), 'utf8'), originalRuntime);
        return;
      }
      if (scenario.success) {
        assert.equal(failure, undefined);
        assert.equal(current.restarts, 1);
        assert.equal(current.processRead, true);
        const prepared = await realRead(join(dataDir, 'runtime.env'), 'utf8');
        assert(prepared.includes(`MAIL_INTELLIGENCE_ALLOW_SEND=${send}\n`));
        assert(prepared.includes(`MAIL_INTELLIGENCE_RELEASE_COMMIT=${commit}\n`));
        return;
      }
      assert(failure, 'Activation must retain final-proof failure');
      assert.equal(current.processRead, true, `Race must occur after new process read, not before activation precheck: ${failure.message}`);
      assert.equal(current.finalProofRead, !scenario.processFailure, 'Final proof must re-query properties after reading the process');
      assert.equal(current.restarts, scenario.safe ? 2 : 1);
      if (scenario.safe) assert.match(failure.message, scenario.processFailure ? /ALLOW_SEND/ : /WorkingDirectory mismatch/);
      else {
        assert.match(failure.message, /ROLLBACK_REQUIRES_MANUAL_INTERVENTION/);
        assert.equal(failure.cause, undefined);
        assert(!failure.stack.includes('synthetic-secret-do-not-print'));
      }
      assert.equal(await realRead(join(dataDir, 'runtime.env'), 'utf8'), originalRuntime);
      if (scenario.owned) {
        assert.equal(await realRead(drop, 'utf8'), oldDrop);
        assert.equal((await fs.stat(drop)).mode & 0o777, 0o640);
      } else await assert.rejects(fs.access(drop), { code: 'ENOENT' });
      for (const file of ['mail-send.env', 'hold.env']) {
        if (file === scenario.file && scenario.remove) await assert.rejects(fs.access(join(dataDir, file)), { code: 'ENOENT' });
        else assert.equal(await realRead(join(dataDir, file), 'utf8'), '# synthetic unchanged\n' + (file === 'mail-send.env' ? trailingSend : '') + (file === scenario.file ? scenario.addition : ''));
      }
    } finally {
      current = undefined;
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

test('rollback safety uses final layering without imposing the new commit', () => {
  const { assertSafeRollback } = boundary;
  const dataDir = '/synthetic/data';
  const environmentFiles = ['runtime.env', 'mail-send.env', 'hold.env'].map(file => ({ path: `${dataDir}/${file}`, text: '' }));
  environmentFiles[0].text = text({ ...releaseEnvironment(dataDir, 'old-commit'), MAIL_INTELLIGENCE_ALLOW_SEND: '0' });
  const properties = [
    ...environmentFiles.map(file => `EnvironmentFiles=${file.path} (ignore_errors=no)`),
    'Environment=MAIL_INTELLIGENCE_ALLOW_SEND=1',
    `UnsetEnvironment=${donorNames.join(' ')} COMPANY_MEMORY_UNKNOWN`,
  ].join('\n');
  const input = { properties, environmentFiles, dataDir, managerEnvironment: 'COMPANY_MEMORY_UNKNOWN=synthetic-only' };
  assert.doesNotThrow(() => assertSafeRollback(input));
  environmentFiles[1].text = 'MAIL_INTELLIGENCE_ALLOW_SEND=1\n';
  assert.doesNotThrow(() => assertSafeRollback(input));
  environmentFiles[1].text = 'MAIL_INTELLIGENCE_ALLOW_SEND=2\n';
  assert.throws(() => assertSafeRollback(input), /ALLOW_SEND/);
  environmentFiles[2].text = 'MAIL_INTELLIGENCE_ALLOW_SEND=0\n';
  assert.doesNotThrow(() => assertSafeRollback(input));
});
