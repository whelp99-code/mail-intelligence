import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareUserRelease, commitUserReleaseEnvironment } from '../scripts/prepare-user-release.mjs';
import {
  releaseDropInName, donorNames, environmentFileRecords, assertEffectiveRelease, releaseEnvironment, assertReleaseEnvironment, assertSafeRollback,
} from '../scripts/user-release-boundary.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-release-config-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(access(directory), { code: 'ENOENT' });
  });
  const commit = 'a'.repeat(40);
  const codeRoot = join(directory, commit);
  const dataDir = join(directory, 'data');
  await mkdir(join(codeRoot, 'deploy/systemd'), { recursive: true });
  await mkdir(dataDir);
  const server = '// synthetic release server\n';
  await writeFile(join(codeRoot, 'server.mjs'), server);
  await writeFile(join(codeRoot, 'VERSION.json'), JSON.stringify({
    commit, serverSha256: createHash('sha256').update(server).digest('hex'),
  }));
  await writeFile(join(codeRoot, 'deploy/systemd/mail-intelligence.service'),
    await readFile(new URL('../deploy/systemd/mail-intelligence.service', import.meta.url), 'utf8'));
  const original = [
    'NODE_ENV=production', 'HOST=127.0.0.1', 'PORT=3010',
    'MAIL_INTELLIGENCE_ACCESS_KEY=synthetic-secret-key',
    'MAIL_INTELLIGENCE_INTAKE_WORKSPACE=synthetic-workspace',
    'MAIL_INTELLIGENCE_CWOS_BASE_URL=http://127.0.0.1:3999',
    'MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID=synthetic-reader',
    'MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND=service',
    'MAIL_INTELLIGENCE_CWOS_PLAN_ID=synthetic-plan',
    'MAIL_INTELLIGENCE_CWOS_API_KEY=synthetic-cwos-secret',
    'MAIL_INTELLIGENCE_ALLOW_SEND=1',
    'MAIL_INTELLIGENCE_ALLOW_SEND=1',
    'COMPANY_MEMORY_AUTHORITY_FILE=/synthetic/private/authority',
  ].join('\n') + '\n';
  await writeFile(join(dataDir, 'runtime.env'), original, { mode: 0o600 });
  await writeFile(join(dataDir, '.mail-intelligence-access-key'), 'synthetic-secret-key', { mode: 0o600 });
  await writeFile(join(dataDir, 'token-cache'), 'synthetic-existing-token');
  await writeFile(join(dataDir, 'mail-send.env'), '# synthetic trailing send\n', { mode: 0o600 });
  await writeFile(join(dataDir, 'hold.env'), '# synthetic trailing hold\n', { mode: 0o600 });
  const environmentFiles = await Promise.all(['runtime.env', 'mail-send.env', 'hold.env'].map(async name => ({
    path: join(dataDir, name), text: await readFile(join(dataDir, name), 'utf8'),
  })));
  return { codeRoot, dataDir, commit, original, environmentFiles };
}

function mergedFixture(input) {
  const ownedDropInPath = join(input.codeRoot, '.deployment/mail-intelligence.service.d', releaseDropInName);
  return {
    ...input, ownedDropInPath,
    properties: [
      `WorkingDirectory=${input.codeRoot}`,
      `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${input.codeRoot}/server.mjs ; ignore_errors=no ; pid=0 ; code=(null) ; status=0/0 }`,
      `EnvironmentFiles=${input.environmentFiles.map(file => `${file.path} (ignore_errors=no)`).join(' ')}`,
      'Environment=HOME=/home/jm PATH=/usr/bin:/bin',
      `UnsetEnvironment=${donorNames.join(' ')}`,
      `DropInPaths=/synthetic/90-mail-send.conf /synthetic/91-notion-snapshot.conf /synthetic/92-reply-drafts.conf ${ownedDropInPath}`,
    ].join('\n'),
  };
}

test('release setup preserves bound config/secrets and disables external effects without touching token bytes', async t => {
  const input = await fixture(t);
  const unitPath = await prepareUserRelease(input);
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  const env = await readFile(join(input.codeRoot, '.deployment/runtime.env'), 'utf8');
  for (const line of input.original.split('\n').filter(line => /INTAKE_|CWOS_|ACCESS_KEY=/.test(line))) {
    assert(env.split('\n').includes(line));
  }
  assert.deepEqual(environmentFileRecords(env).filter(record => record.key === 'MAIL_INTELLIGENCE_ALLOW_SEND').map(record => record.raw),
    environmentFileRecords(input.original).filter(record => record.key === 'MAIL_INTELLIGENCE_ALLOW_SEND').map(record => record.raw));
  for (const name of ['ACTIONS_APPROVED', 'ALLOW_MAIL_MUTATIONS', 'ALLOW_DATA_PLANE', 'ALLOW_EXTERNAL_AI']) {
    assert.equal(env.split('\n').filter(line => line.startsWith(`MAIL_INTELLIGENCE_${name}=`)).join(''), `MAIL_INTELLIGENCE_${name}=0`);
  }
  assert(!env.includes('COMPANY_MEMORY_'));
  assert.equal(await readFile(join(input.dataDir, 'token-cache'), 'utf8'), 'synthetic-existing-token');
  assert.equal((await stat(join(input.dataDir, 'runtime.env'))).mode & 0o777, 0o600);
  const unit = await readFile(unitPath, 'utf8');
  assert(unit.includes(`WorkingDirectory=${input.codeRoot}`));
  assert(unit.includes(`ExecStart=/usr/bin/node ${input.codeRoot}/server.mjs`));
  assert(unit.includes(`EnvironmentFile=${input.dataDir}/runtime.env`));
  const dropIn = await readFile(join(input.codeRoot, '.deployment/mail-intelligence.service.d', releaseDropInName), 'utf8');
  assert(dropIn.includes(`ExecStart=\nExecStart=/usr/bin/node ${input.codeRoot}/server.mjs\n`));
  assert.deepEqual(dropIn.split('\n').filter(line => line.startsWith('EnvironmentFile=')),
    ['EnvironmentFile=', `EnvironmentFile=${input.dataDir}/runtime.env`]);
  assert.deepEqual(unit.split('\n').filter(line => line.startsWith('EnvironmentFile=')),
    input.environmentFiles.map(file => `EnvironmentFile=${file.path}`));
  const context = mergedFixture(input);
  const properties = context.properties.replace(/^EnvironmentFiles=.*$/m,
    input.environmentFiles.map(file => `EnvironmentFiles=${file.path} (ignore_errors=no)`).join('\n'));
  assert.doesNotThrow(() => assertEffectiveRelease({ ...context, properties,
    environmentFiles: input.environmentFiles.map((file, index) => index === 0 ? { ...file, text: env } : file) }));
  for (const file of input.environmentFiles.slice(1)) {
    assert.equal(await readFile(file.path, 'utf8'), file.text);
  }
});

test('release identity or byte mismatch refuses before changing existing configuration', async t => {
  const input = await fixture(t);
  await assert.rejects(prepareUserRelease({ ...input, commit: 'b'.repeat(40) }));
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  await writeFile(join(input.codeRoot, 'server.mjs'), '// different bytes\n');
  await assert.rejects(prepareUserRelease(input));
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
});

test('release setup removes whitespace, exported and quoted donor assignments', async t => {
  const input = await fixture(t);
  const adversarial = [
    '  COMPANY_MEMORY_AUTHORITY_FILE="/synthetic/authority"',
    '\tCOMPANY_MEMORY_AUTHORITY_DIGEST=synthetic-digest',
    ' export COMPANY_MEMORY_AUTHORITY_FILE=/synthetic/export',
    '"COMPANY_MEMORY_AUTHORITY_DIGEST"="synthetic-quoted-key"',
    'COMPANY_MEMORY_READ_POLICY=\'synthetic\nmultiline-policy\'',
    ' COMPANY_MEMORY_EXPECTED_INTAKE_PIN=synthetic\\',
    'continued-pin',
  ].join('\n') + '\n';
  await writeFile(join(input.dataDir, 'runtime.env'), input.original + adversarial, { mode: 0o600 });
  input.environmentFiles[0].text = input.original + adversarial;
  const unitPath = await prepareUserRelease(input);
  const prepared = await readFile(join(input.codeRoot, '.deployment/runtime.env'), 'utf8');
  assert.equal(/COMPANY_MEMORY_[A-Z_]+\s*["']?=/.test(prepared), false);
  assert(!prepared.includes('continued-pin'));
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original + adversarial);
  assert(unitPath);
});

test('native EnvironmentFile records preserve quoted secrets and escaped whitespace as one record', () => {
  const text = [
    '# COMPANY_MEMORY_COMMENT=ignored',
    'SECRET_SINGLE=\'line one\nCOMPANY_MEMORY_NOT_A_KEY=value\nline three\'',
    'SECRET_DOUBLE="line one\\',
    'line two\\q\\$\\`\\\\\\""',
    'UNQUOTED=  one  two"literal"\\',
    'three\\  ',
    '  HOST = 127.0.0.1 \t',
    'export IGNORED_BY_SYSTEMD=value',
    '',
  ].join('\n');
  const records = environmentFileRecords(text);
  assert.equal(records.map(record => record.raw).join(''), text);
  const values = Object.fromEntries(records.filter(record => record.key).map(record => [record.key, record.value]));
  assert.deepEqual(values, {
    SECRET_SINGLE: 'line one\nCOMPANY_MEMORY_NOT_A_KEY=value\nline three',
    SECRET_DOUBLE: 'line oneline two\\q$`\\"',
    UNQUOTED: 'one  two"literal"three ',
    HOST: '127.0.0.1',
  });
  assert(records.every(record => !record.donor));
  assert.throws(() => environmentFileRecords('SECRET=\'unterminated'), /Unterminated/);
});

test('merged conflicts deny before any operational rewrite, including late drop-in and file values', async t => {
  const input = await fixture(t);
  await prepareUserRelease(input);
  const context = mergedFixture(input);
  const runtimeText = await readFile(join(input.codeRoot, '.deployment/runtime.env'), 'utf8');
  const environmentFiles = context.environmentFiles.map((file, index) => index === 0 ? { ...file, text: runtimeText } : file);
  assert.doesNotThrow(() => assertEffectiveRelease({ ...context, environmentFiles }));
  const conflicts = [
    context.properties.replace(`WorkingDirectory=${input.codeRoot}`, 'WorkingDirectory=/synthetic/other'),
    context.properties.replace(`${input.codeRoot}/server.mjs ;`, '/synthetic/other/server.mjs ;'),
    context.properties + '\nEnvironmentFiles=/synthetic/mail-send.env (ignore_errors=no)',
    context.properties.replace(`${input.dataDir}/runtime.env (ignore_errors=no)`, '-/synthetic/mail-send.env (ignore_errors=yes)'),
    context.properties.replace('Environment=HOME=', 'Environment=COMPANY_MEMORY_AUTHORITY_FILE=/synthetic/donor HOME='),
    context.properties.replace(`UnsetEnvironment=${donorNames.join(' ')}`, 'UnsetEnvironment='),
    context.properties.replace(context.ownedDropInPath, '/synthetic/zz-unowned.conf'),
    context.properties.replace('Environment=HOME=', 'Environment=MAIL_INTELLIGENCE_ALLOW_SEND=1 HOME=')
      .replace(`UnsetEnvironment=${donorNames.join(' ')}`, `UnsetEnvironment=${donorNames.join(' ')} MAIL_INTELLIGENCE_ALLOW_SEND=1`),
  ];
  for (const properties of conflicts) {
    await assert.rejects(commitUserReleaseEnvironment({ ...context, properties }));
    assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  }
  assert.throws(() => assertEffectiveRelease({
    ...context, environmentFiles: environmentFiles.map((file, index) => index === 0
      ? { ...file, text: runtimeText + ' MAIL_INTELLIGENCE_DATA_DIR=/synthetic/other\n' } : file),
  }), /DATA_DIR/);
  assert.throws(() => assertEffectiveRelease({
    ...context, environmentFiles: environmentFiles.map((file, index) => index === 0
      ? { ...file, text: runtimeText + ' MAIL_INTELLIGENCE_ALLOW_SEND="2"\n' } : file),
  }), /ALLOW_SEND/);
});

test('an inherited unknown donor requires final UnsetEnvironment coverage', async t => {
  const input = await fixture(t);
  const managerEnvironment = 'COMPANY_MEMORY_FUTURE_DONOR=synthetic\nOTHER=keep\n';
  await prepareUserRelease({ ...input, managerEnvironment });
  const context = mergedFixture(input);
  await assert.rejects(commitUserReleaseEnvironment({ ...context, managerEnvironment }));
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  context.properties = context.properties.replace(`UnsetEnvironment=${donorNames.join(' ')}`,
    `UnsetEnvironment=${donorNames.join(' ')} COMPANY_MEMORY_FUTURE_DONOR`);
  await commitUserReleaseEnvironment({ ...context, managerEnvironment });
  const env = await readFile(join(input.dataDir, 'runtime.env'), 'utf8');
  assertEffectiveRelease({ ...context, environmentFiles: context.environmentFiles.map((file, index) =>
    index === 0 ? { ...file, text: env } : file), managerEnvironment });
  assert.equal((await stat(join(input.dataDir, 'runtime.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(input.dataDir, 'token-cache'), 'utf8'), 'synthetic-existing-token');
});

test('staged or operational environment changes invalidate the admission proof', async t => {
  const input = await fixture(t);
  await prepareUserRelease(input);
  const context = mergedFixture(input);
  const stage = join(input.codeRoot, '.deployment/runtime.env');
  const staged = await readFile(stage);
  await writeFile(stage, staged + 'MAIL_INTELLIGENCE_ALLOW_SEND=1\n');
  await assert.rejects(commitUserReleaseEnvironment(context), /Prepared environment changed/);
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  await writeFile(stage, staged);
  await writeFile(join(input.dataDir, 'runtime.env'), input.original + 'OTHER=changed\n');
  await assert.rejects(commitUserReleaseEnvironment(context), /Operational environment changed/);
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original + 'OTHER=changed\n');
});

// Production paths below are inert strings: boundary tests never open them.
function boundaryFixture(production = true) {
  const dataDir = production ? '/home/jm/orca/projects/mail-intelligence/data' : '/synthetic/release-data';
  const commit = 'a'.repeat(40);
  const paths = production ? [
    `${dataDir}/runtime.env`, '/home/jm/.config/mail-intelligence/mail-send.env',
    '/home/jm/.local/state/mail-intelligence/rollback-20261009/hold.env',
  ] : [`${dataDir}/runtime.env`, `${dataDir}/mail-send.env`, `${dataDir}/hold.env`];
  const text = Object.entries({ ...releaseEnvironment(dataDir, commit), MAIL_INTELLIGENCE_ALLOW_SEND: '0' }).map(([key, value]) => `${key}=${value}\n`).join('');
  const environmentFiles = paths.map((path, index) => ({ path, text: index === 0 ? text : '# synthetic only\n' }));
  return mergedFixture({ codeRoot: `/synthetic/releases/${commit}`, dataDir, commit, environmentFiles });
}

test('exact production trio and deterministic synthetic trio accept without filesystem reads', () => {
  for (const production of [true, false]) {
    const context = boundaryFixture(production);
    assert.doesNotThrow(() => assertEffectiveRelease(context));
    // Identical trailing assignments are safe and must not be mistaken for a conflict.
    for (const index of [1, 2]) {
      const environmentFiles = context.environmentFiles.map((file, position) => ({
        ...file, text: position === index ? context.environmentFiles[0].text : file.text,
      }));
      assert.doesNotThrow(() => assertEffectiveRelease({ ...context, environmentFiles }));
    }
    const environmentFiles = context.environmentFiles.map((file, index) => ({ ...file,
      text: index === 1 ? 'MAIL_INTELLIGENCE_ALLOW_SEND=1\n'
        : index === 2 ? 'MAIL_INTELLIGENCE_ALLOW_SEND=0\n' : file.text,
    }));
    assert.doesNotThrow(() => assertEffectiveRelease({ ...context, environmentFiles }));
  }
});

test('native repeated EnvironmentFiles lines accept exact trio and reject malformed repeated chains', () => {
  for (const production of [true, false]) {
    const context = boundaryFixture(production);
    const lines = context.environmentFiles.map(file => `EnvironmentFiles=${file.path} (ignore_errors=no)`);
    const propertiesFor = records => context.properties.replace(/^EnvironmentFiles=.*$/m, records.join('\n'));
    assert.doesNotThrow(() => assertEffectiveRelease({ ...context, properties: propertiesFor(lines) }));
    assert.doesNotThrow(() => assertEffectiveRelease({ ...context,
      properties: propertiesFor([`${lines[0]} ${lines[1].slice('EnvironmentFiles='.length)}`, lines[2]]) }));
    const invalid = [
      [...lines, 'EnvironmentFiles=/synthetic/extra.env (ignore_errors=no)'],
      [lines[1], lines[0], lines[2]], [lines[0], lines[2], lines[1]],
      [...lines, 'EnvironmentFiles='],
      [lines[0].replace(' (ignore_errors=no)', ''), lines[1], lines[2]],
    ];
    for (let index = 0; index < lines.length; index++) {
      invalid.push(lines.filter((_, position) => position !== index));
      invalid.push([...lines.slice(0, index), lines[index], ...lines.slice(index)]);
      invalid.push(lines.map((line, position) => position === index ? line.replace('ignore_errors=no', 'ignore_errors=yes') : line));
      invalid.push(lines.map((line, position) => position === index ? line.replace('EnvironmentFiles=', 'EnvironmentFiles=-') : line));
    }
    for (const records of invalid) {
      assert.throws(() => assertEffectiveRelease({ ...context, properties: propertiesFor(records) }), /EnvironmentFile/);
    }
  }
});

test('each missing, additional, duplicate, reordered or optional EnvironmentFile is rejected', () => {
  for (const production of [true, false]) {
    const context = boundaryFixture(production);
    const files = context.environmentFiles;
    const chains = [];
    for (let index = 0; index < files.length; index++) {
      chains.push(files.filter((_, position) => position !== index));
      chains.push([...files.slice(0, index), files[index], ...files.slice(index)]);
    }
    chains.push([...files, { path: '/synthetic/extra.env', text: '' }]);
    chains.push([files[1], files[0], files[2]], [files[0], files[2], files[1]]);
    for (const chain of chains) {
      const properties = context.properties.replace(/^EnvironmentFiles=.*$/m,
        `EnvironmentFiles=${chain.map(file => `${file.path} (ignore_errors=no)`).join(' ')}`);
      assert.throws(() => assertEffectiveRelease({ ...context, properties }), /EnvironmentFile/);
      assert.throws(() => assertEffectiveRelease({ ...context, environmentFiles: chain }), /EnvironmentFile/);
    }
    for (const file of files) {
      for (const replacement of [`${file.path} (ignore_errors=yes)`, `-${file.path} (ignore_errors=no)`]) {
        const properties = context.properties.replace(`${file.path} (ignore_errors=no)`, replacement);
        assert.throws(() => assertEffectiveRelease({ ...context, properties }), /EnvironmentFile/);
      }
    }
    assert.throws(() => assertEffectiveRelease({ ...context,
      properties: context.properties + `\nEnvironmentFiles=${files[0].path} (ignore_errors=no)` }), /EnvironmentFile/);
    assert.throws(() => assertEffectiveRelease({ ...context, environmentFiles: undefined }), /EnvironmentFile/);
  }
});

test('either trailing file unsafe overrides of six rewritten keys, send, calendar or donor deny without leaking values', () => {
  const context = boundaryFixture();
  const assignments = [
    ...Object.keys(releaseEnvironment(context.dataDir, context.commit)).map(key => [key, 'synthetic-secret-override']),
    ['MAIL_INTELLIGENCE_ALLOW_SEND', 'synthetic-secret-override'],
    ['MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED', '1'],
    ['COMPANY_MEMORY_FUTURE_DONOR', 'synthetic-secret-override'],
  ];
  for (const index of [1, 2]) {
    for (const [key, value] of assignments) {
      const environmentFiles = context.environmentFiles.map((file, position) => ({
        ...file, text: position === index ? `${key}=${value}\n` : file.text,
      }));
      assert.throws(() => assertEffectiveRelease({ ...context, environmentFiles }), error => {
        assert(!error.message.includes('synthetic-secret-override'));
        if (key.startsWith('COMPANY_MEMORY_')) return /donor/i.test(error.message);
        if (key === 'MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED') return /Calendar reader/.test(error.message);
        return error.message === `Release environment mismatch: ${key}`;
      });
    }
  }
});

test('final process calendar reader rejects enabled consent with six rewritten keys and valid send', () => {
  const context = boundaryFixture();
  const environment = { ...releaseEnvironment(context.dataDir, context.commit), MAIL_INTELLIGENCE_ALLOW_SEND: '0' };
  assert.throws(() => assertReleaseEnvironment({
    ...environment, MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED: '1',
  }, context), /Calendar reader/);
  for (const value of ['', '0', 'true']) {
    assert.doesNotThrow(() => assertReleaseEnvironment({
      ...environment, MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED: value,
    }, context));
  }
});

test('non-ASCII key whitespace cannot hide unsafe trailing values from the native environment proof', () => {
  const context = boundaryFixture();
  for (const codePoint of [0xa0, 0x1680, 0x2003, 0x202f]) {
    const space = String.fromCodePoint(codePoint);
    for (const [key, message] of [
      ['MAIL_INTELLIGENCE_ALLOW_SEND', 'Release environment mismatch: MAIL_INTELLIGENCE_ALLOW_SEND'],
      ['MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED', 'Calendar reader must remain disabled'],
    ]) {
      for (const invalidKey of [`${space}${key}`, `${key}${space}`]) {
        const text = `${key}=${key === 'MAIL_INTELLIGENCE_ALLOW_SEND' ? '2' : '1'}\n${invalidKey}=0\n`;
        assert.equal(environmentFileRecords(text)[1].key, undefined);
        for (const index of [1, 2]) {
          const environmentFiles = context.environmentFiles.map((file, position) => ({
            ...file, text: position === index ? text : file.text,
          }));
          assert.throws(() => assertEffectiveRelease({ ...context, environmentFiles }), error => error.message === message);
        }
      }
    }
  }
});

test('trio keeps manager donor, effective reset and final unset gates', () => {
  const context = boundaryFixture();
  const managerEnvironment = 'COMPANY_MEMORY_UNKNOWN=synthetic-secret-override\n';
  assert.throws(() => assertEffectiveRelease({ ...context, managerEnvironment }), /neutralised/);
  const properties = context.properties.replace(`UnsetEnvironment=${donorNames.join(' ')}`,
    `UnsetEnvironment=${donorNames.join(' ')} COMPANY_MEMORY_UNKNOWN`);
  assert.doesNotThrow(() => assertEffectiveRelease({ ...context, properties, managerEnvironment }));
  for (const replacement of [
    'UnsetEnvironment=',
    `UnsetEnvironment=${donorNames.join(' ')} MAIL_INTELLIGENCE_ALLOW_SEND=0`,
  ]) {
    assert.throws(() => assertEffectiveRelease({ ...context,
      properties: context.properties.replace(/^UnsetEnvironment=.*$/m, replacement) }));
  }
  assert.throws(() => assertEffectiveRelease({ ...context,
    properties: context.properties.replace('Environment=HOME=', 'Environment=COMPANY_MEMORY_UNKNOWN=synthetic HOME=') }), /donor/);
});

test('changed trailing fixture bytes invalidate proof and are never restored or rewritten', async t => {
  const input = await fixture(t);
  await prepareUserRelease(input);
  const context = mergedFixture(input);
  const changed = '# safe but changed trailing file\n';
  const path = input.environmentFiles[2].path;
  await writeFile(path, changed);
  const environmentFiles = input.environmentFiles.map((file, index) => index === 2 ? { ...file, text: changed } : file);
  await assert.rejects(commitUserReleaseEnvironment({ ...context, environmentFiles }), /inputs changed/);
  assert.equal(await readFile(path, 'utf8'), changed);
  assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
});

test('preparation refuses unsafe supplied trailing contents without touching operational fixtures', async t => {
  const input = await fixture(t);
  for (const index of [1, 2]) {
    const environmentFiles = input.environmentFiles.map((file, position) => position === index
      ? { ...file, text: 'MAIL_INTELLIGENCE_ALLOW_SEND=2\n' } : file);
    await assert.rejects(prepareUserRelease({ ...input, environmentFiles }), /ALLOW_SEND/);
    assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
    for (const file of input.environmentFiles.slice(1)) {
      assert.equal(await readFile(file.path, 'utf8'), file.text);
    }
  }
  await assert.rejects(prepareUserRelease({ ...input, environmentFiles: undefined }), /EnvironmentFile/);
});

test('send accepts only exact strings zero or one in process and rollback proofs', () => {
  const context = boundaryFixture(false);
  for (const value of ['0', '1', undefined, '2', 'true', 'false', '', ' ', ' 0', '1 ', '\t', '01', 0, 1, true, null]) {
    const environment = { ...releaseEnvironment(context.dataDir, context.commit), MAIL_INTELLIGENCE_ALLOW_SEND: value };
    if (value === undefined) delete environment.MAIL_INTELLIGENCE_ALLOW_SEND;
    const valid = value === '0' || value === '1';
    if (valid) assert.doesNotThrow(() => assertReleaseEnvironment(environment, context));
    else assert.throws(() => assertReleaseEnvironment(environment, context), /ALLOW_SEND/);
    // EnvironmentFile quoted values preserve significant whitespace; absence is not defaulted.
    if (typeof value !== 'string' && value !== undefined) continue;
    const environmentFiles = context.environmentFiles.map((file, index) => index === 0 ? { ...file,
      text: Object.entries(environment).map(([key, item]) => `${key}=${JSON.stringify(item)}\n`).join(''),
    } : file);
    if (valid) assert.doesNotThrow(() => assertSafeRollback({ ...context, environmentFiles }));
    else assert.throws(() => assertSafeRollback({ ...context, environmentFiles }), /ALLOW_SEND/);
  }
  for (const key of ['ACTIONS_APPROVED', 'ALLOW_MAIL_MUTATIONS', 'ALLOW_DATA_PLANE', 'ALLOW_EXTERNAL_AI']) {
    for (const value of [undefined, '1', '', ' ', 'true', 0]) {
      const environment = { ...releaseEnvironment(context.dataDir, context.commit), MAIL_INTELLIGENCE_ALLOW_SEND: '1',
        [`MAIL_INTELLIGENCE_${key}`]: value };
      assert.throws(() => assertReleaseEnvironment(environment, context), new RegExp(key));
    }
  }
});

test('preparation preserves native send records byte for byte and never fills an absent runtime send', async t => {
  const input = await fixture(t);
  const withoutSend = environmentFileRecords(input.original).filter(record => record.key !== 'MAIL_INTELLIGENCE_ALLOW_SEND').map(record => record.raw).join('');
  for (const sendRecords of ['MAIL_INTELLIGENCE_ALLOW_SEND=0\n', '  MAIL_INTELLIGENCE_ALLOW_SEND = "1"\nMAIL_INTELLIGENCE_ALLOW_SEND=1\n', '']) {
    const original = withoutSend + sendRecords;
    await writeFile(join(input.dataDir, 'runtime.env'), original);
    const environmentFiles = input.environmentFiles.map((file, index) => ({ ...file,
      text: index === 0 ? original : index === 1 ? 'MAIL_INTELLIGENCE_ALLOW_SEND=1\n' : file.text,
    }));
    await prepareUserRelease({ ...input, environmentFiles });
    const prepared = await readFile(join(input.codeRoot, '.deployment/runtime.env'), 'utf8');
    assert.equal(environmentFileRecords(prepared).filter(record => record.key === 'MAIL_INTELLIGENCE_ALLOW_SEND').map(record => record.raw).join(''), sendRecords);
    assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), original);
    if (!sendRecords) await assert.rejects(prepareUserRelease({ ...input,
      environmentFiles: environmentFiles.map((file, index) => index === 1 ? { ...file, text: '' } : file),
    }), /ALLOW_SEND/);
  }
});
