import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { companyMemoryDonorNames, parseCompanyMemoryDonorEnvironment } from '../src/application/company-memory-donor-bind.js';

export const releaseDropInName = 'zz-mail-intelligence-release.conf';
const productionDataDir = '/home/jm/orca/projects/mail-intelligence/data';

/** Exact ordered contract; synthetic deployments never resolve operational paths. */
export function releaseEnvironmentFilePaths(dataDir) {
  assert(typeof dataDir === 'string' && isAbsolute(dataDir) && resolve(dataDir) === dataDir,
    'Canonical absolute data directory is required');
  return dataDir === productionDataDir
    ? [`${dataDir}/runtime.env`, '/home/jm/.config/mail-intelligence/mail-send.env',
      '/home/jm/.local/state/mail-intelligence/rollback-20261009/hold.env']
    : [`${dataDir}/runtime.env`, `${dataDir}/mail-send.env`, `${dataDir}/hold.env`];
}

export function assertEnvironmentFileInputs(environmentFiles, dataDir) {
  const paths = releaseEnvironmentFilePaths(dataDir);
  assert(Array.isArray(environmentFiles) && environmentFiles.length === paths.length
    && environmentFiles.every((file, index) => file?.path === paths[index] && typeof file.text === 'string'),
  'EnvironmentFile inputs must match the exact ordered contract');
}

export function applyEnvironmentFiles(environment, environmentFiles, dataDir) {
  assertEnvironmentFileInputs(environmentFiles, dataDir);
  for (const file of environmentFiles) {
    for (const record of environmentFileRecords(file.text)) {
      assert(!record.donor || (record.key && donorNames.includes(record.key)), 'EnvironmentFile donor assignment is unknown or non-native');
      if (record.key) environment[record.key] = record.value;
    }
  }
  return environment;
}

export const donorNames = companyMemoryDonorNames;

export function releaseEnvironment(dataDir, commit) {
  return {
    MAIL_INTELLIGENCE_DATA_DIR: dataDir,
    MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
    MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
    MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
    MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
    MAIL_INTELLIGENCE_RELEASE_COMMIT: commit,
  };
}

/** Logical EnvironmentFile records: quotes are special only at the start of a value. */
export function environmentFileRecords(text) {
  assert(!/[\0\uFEFF]/u.test(text), 'Invalid EnvironmentFile encoding');
  const records = [];
  let position = 0;
  while (position < text.length) {
    const start = position;
    const newline = text.indexOf('\n', start);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(start, lineEnd);
    const equal = line.indexOf('=');
    if (/^[ \t\r]*[;#]/.test(line) || equal < 0) {
      position = newline < 0 ? text.length : newline + 1;
      records.push({ raw: text.slice(start, position) });
      continue;
    }
    const name = line.slice(0, equal).replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    // Export and quoted donor aliases are not native assignments and must fail closed.
    const alias = name.replace(/^export[ \t]+/, '').replace(/["']/g, '').replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
    const donor = alias.startsWith('COMPANY_MEMORY_');
    position = start + equal + 1;
    while (/[ \t\r]/.test(text[position] || '\n')) position++;
    const quote = ['"', '\''].includes(text[position]) ? text[position++] : '';
    let value = '';
    let trailingWhitespace = '';
    let closed = !quote;
    while (position < text.length) {
      const character = text[position++];
      if (quote && character === quote) {
        closed = true;
        break;
      }
      if (!quote && character === '\n') break;
      if (character === '\\' && quote !== '\'') {
        assert(position < text.length, 'Unterminated EnvironmentFile escape');
        const next = text[position++];
        if (next === '\n') continue;
        value += trailingWhitespace + (!quote || ['"', '\\', '`', '$'].includes(next) ? next : `\\${next}`);
        trailingWhitespace = '';
      } else if (!quote && /[ \t\r]/.test(character)) {
        trailingWhitespace += character;
      } else {
        value += trailingWhitespace + character;
        trailingWhitespace = '';
      }
    }
    assert(closed, 'Unterminated EnvironmentFile quote');
    if (quote) {
      while (/[ \t\r]/.test(text[position] || '\n')) position++;
      assert(position === text.length || text[position] === '\n', 'Unsupported EnvironmentFile quoted suffix');
      if (text[position] === '\n') position++;
    }
    records.push({ raw: text.slice(start, position), key, donor, value });
  }
  return records;
}

/** Decode systemctl show's quoted/C-escaped list representation, not shell code. */
function propertyWords(text) {
  const result = [];
  let value = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '\\') {
      const next = text[++i];
      assert(next !== undefined, 'Invalid systemctl property escape');
      if (next === 'x') {
        const hex = text.slice(i + 1, i + 3);
        assert(/^[a-fA-F0-9]{2}$/.test(hex), 'Invalid systemctl hex escape');
        value += String.fromCharCode(parseInt(hex, 16));
        i += 2;
      } else {
        const escapes = { n: '\n', r: '\r', t: '\t', s: ' ', '\\': '\\', '"': '"', '\'': '\'' };
        assert(Object.hasOwn(escapes, next), 'Unsupported systemctl escape');
        value += escapes[next];
      }
      started = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else value += character;
    } else if (character === '"' || character === '\'') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) result.push(value);
      value = '';
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  assert(!quote, 'Invalid systemctl property quote');
  if (started) result.push(value);
  return result;
}

export function mergedProperties(text) {
  const properties = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const equal = line.indexOf('=');
    assert(equal > 0, 'Invalid systemctl property record');
    const key = line.slice(0, equal);
    const values = properties.get(key) || [];
    values.push(line.slice(equal + 1));
    properties.set(key, values);
  }
  return properties;
}

export function managerDonorNames(text) {
  return text.split('\n').map(line => line.slice(0, line.indexOf('=')))
    .filter(name => /^COMPANY_MEMORY_[A-Za-z0-9_]+$/.test(name));
}

function assertExternalActionsDisabled(environment) {
  parseCompanyMemoryDonorEnvironment(environment);
  assert(environment.MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED !== '1', 'Calendar reader must remain disabled');
  for (const name of ['ACTIONS_APPROVED', 'ALLOW_MAIL_MUTATIONS', 'ALLOW_DATA_PLANE', 'ALLOW_EXTERNAL_AI']) {
    assert(environment[`MAIL_INTELLIGENCE_${name}`] === '0', `Release environment mismatch: MAIL_INTELLIGENCE_${name}`);
  }
  assert(environment.MAIL_INTELLIGENCE_ALLOW_SEND === '0' || environment.MAIL_INTELLIGENCE_ALLOW_SEND === '1',
    'Release environment mismatch: MAIL_INTELLIGENCE_ALLOW_SEND');
}

export function assertReleaseEnvironment(environment, { dataDir, commit }) {
  assertExternalActionsDisabled(environment);
  for (const [key, value] of Object.entries(releaseEnvironment(dataDir, commit))) {
    assert(environment[key] === value, `Release environment mismatch: ${key}`);
  }
}

/** Read all repeated EnvironmentFiles fields; a base unit is not the effective unit. */
export function assertEffectiveRelease({ properties, environmentFiles, managerEnvironment = '', codeRoot, dataDir, commit, ownedDropInPath }) {
  const merged = mergedProperties(properties);
  const one = name => {
    assert(merged.get(name)?.length === 1, `Missing/ambiguous effective ${name}`);
    return merged.get(name)[0];
  };
  assert(one('WorkingDirectory') === codeRoot, 'Effective WorkingDirectory mismatch');
  const executable = one('ExecStart');
  const command = executable.match(/^\{ path=([^;]+) ; argv\[\]=([^;]+) ; ignore_errors=no ; .* \}$/);
  assert(command && command[1] === '/usr/bin/node' && command[2] === `/usr/bin/node ${codeRoot}/server.mjs`,
    'Effective ExecStart mismatch');
  assert(propertyWords(one('DropInPaths')).includes(ownedDropInPath), 'Owned release drop-in is not loaded');
  const environment = mergedEnvironment({ properties, environmentFiles, managerEnvironment, dataDir });
  assertReleaseEnvironment(environment, { dataDir, commit });
  return environment;
}

// A restored legacy release need not have VERSION.json or the new commit.
// Prove restart safety, not successful activation or immutable identity.
export function assertSafeRollback(input) {
  assertExternalActionsDisabled(mergedEnvironment(input));
}

function mergedEnvironment({ properties, environmentFiles, managerEnvironment = '', dataDir }) {
  const merged = mergedProperties(properties);
  const one = name => {
    assert(merged.get(name)?.length === 1, `Missing/ambiguous effective ${name}`);
    return merged.get(name)[0];
  };
  const files = merged.get('EnvironmentFiles');
  const tuples = [];
  for (const field of files || []) {
    const words = propertyWords(field);
    assert(words.length > 0 && words.length % 2 === 0, 'Effective EnvironmentFile chain mismatch');
    for (let index = 0; index < words.length; index += 2) {
      tuples.push({ path: words[index], flags: words[index + 1] });
    }
  }
  const paths = releaseEnvironmentFilePaths(dataDir);
  assert(tuples.length === paths.length && tuples.every((tuple, index) =>
    tuple.path === paths[index] && tuple.flags === '(ignore_errors=no)'),
  'Effective EnvironmentFile chain mismatch');
  const environment = Object.fromEntries(managerEnvironment.split('\n').filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const assignment of propertyWords(one('Environment'))) {
    const equal = assignment.indexOf('=');
    assert(equal > 0 && !assignment.startsWith('COMPANY_MEMORY_'), 'Effective Environment donor/conflict');
    environment[assignment.slice(0, equal)] = assignment.slice(equal + 1);
  }
  applyEnvironmentFiles(environment, environmentFiles, dataDir);
  // Only the explicit file chain may supply a donor binding. Manager values
  // cannot complete a partial file binding or silently enable an absent one.
  const fileEnvironment = applyEnvironmentFiles({}, environmentFiles, dataDir);
  parseCompanyMemoryDonorEnvironment(fileEnvironment);
  const unset = propertyWords(one('UnsetEnvironment'));
  for (const name of [...donorNames, ...managerDonorNames(managerEnvironment)]) {
    if (Object.hasOwn(fileEnvironment, name)) {
      assert(!unset.includes(name) && !unset.includes(`${name}=${environment[name]}`), 'Configured donor must not be unset');
    } else assert(unset.includes(name), 'Inherited donor is not explicitly neutralised');
  }
  for (const assignment of unset) {
    const equal = assignment.indexOf('=');
    if (equal < 0) delete environment[assignment];
    else if (environment[assignment.slice(0, equal)] === assignment.slice(equal + 1)) delete environment[assignment.slice(0, equal)];
  }
  return environment;
}
