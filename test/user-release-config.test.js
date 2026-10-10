import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareUserRelease, commitUserReleaseEnvironment } from '../scripts/prepare-user-release.mjs';
import {
  releaseDropInName, donorNames, environmentFileRecords, assertEffectiveRelease,
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
  return { codeRoot, dataDir, commit, original };
}

function mergedFixture(input) {
  const ownedDropInPath = join(input.codeRoot, '.deployment/mail-intelligence.service.d', releaseDropInName);
  return {
    ...input, ownedDropInPath,
    properties: [
      `WorkingDirectory=${input.codeRoot}`,
      `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${input.codeRoot}/server.mjs ; ignore_errors=no ; pid=0 ; code=(null) ; status=0/0 }`,
      `EnvironmentFiles=${input.dataDir}/runtime.env (ignore_errors=no)`,
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
  for (const name of ['ACTIONS_APPROVED', 'ALLOW_SEND', 'ALLOW_MAIL_MUTATIONS', 'ALLOW_DATA_PLANE', 'ALLOW_EXTERNAL_AI']) {
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
  assert(dropIn.includes(`EnvironmentFile=\nEnvironmentFile=${input.dataDir}/runtime.env\n`));
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
  assert.doesNotThrow(() => assertEffectiveRelease({ ...context, runtimeText }));
  const conflicts = [
    context.properties.replace(`WorkingDirectory=${input.codeRoot}`, 'WorkingDirectory=/synthetic/other'),
    context.properties.replace(`${input.codeRoot}/server.mjs ;`, '/synthetic/other/server.mjs ;'),
    context.properties + '\nEnvironmentFiles=/synthetic/mail-send.env (ignore_errors=no)',
    context.properties.replace(`${input.dataDir}/runtime.env (ignore_errors=no)`, '-/synthetic/mail-send.env (ignore_errors=yes)'),
    context.properties.replace('Environment=HOME=', 'Environment=COMPANY_MEMORY_AUTHORITY_FILE=/synthetic/donor HOME='),
    context.properties.replace(`UnsetEnvironment=${donorNames.join(' ')}`, 'UnsetEnvironment='),
    context.properties.replace(context.ownedDropInPath, '/synthetic/zz-unowned.conf'),
    context.properties.replace('Environment=HOME=', 'Environment=MAIL_INTELLIGENCE_ALLOW_SEND=1 HOME=')
      .replace(`UnsetEnvironment=${donorNames.join(' ')}`, `UnsetEnvironment=${donorNames.join(' ')} MAIL_INTELLIGENCE_ALLOW_SEND=0`),
  ];
  for (const properties of conflicts) {
    await assert.rejects(commitUserReleaseEnvironment({ ...context, properties }));
    assert.equal(await readFile(join(input.dataDir, 'runtime.env'), 'utf8'), input.original);
  }
  assert.throws(() => assertEffectiveRelease({
    ...context, runtimeText: runtimeText + ' MAIL_INTELLIGENCE_DATA_DIR=/synthetic/other\n',
  }), /DATA_DIR/);
  assert.throws(() => assertEffectiveRelease({
    ...context, runtimeText: runtimeText + ' MAIL_INTELLIGENCE_ALLOW_SEND="1"\n',
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
  assertEffectiveRelease({ ...context, runtimeText: env, managerEnvironment });
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
