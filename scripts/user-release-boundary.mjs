import assert from 'node:assert/strict';

export const releaseDropInName = 'zz-mail-intelligence-release.conf';
export const donorNames = [
  'COMPANY_MEMORY_SB_COMPANY',
  'COMPANY_MEMORY_SB_COMPANY_CONFIG',
  'COMPANY_MEMORY_SIGNING_KEY_FILE',
  'COMPANY_MEMORY_AUTHORITY_FILE',
];

export function releaseEnvironment(dataDir, commit) {
  return {
    MAIL_INTELLIGENCE_DATA_DIR: dataDir,
    MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
    MAIL_INTELLIGENCE_ALLOW_SEND: '0',
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
    const name = line.slice(0, equal).trim();
    // export and quoted names are not native systemd names. Strip donor aliases
    // defensively, rather than silently accepting shell syntax as an assignment.
    const alias = name.replace(/^export[ \t]+/, '').replace(/["']/g, '').trim();
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

export function assertReleaseEnvironment(environment, { dataDir, commit }) {
  assert(Object.keys(environment).every(key => !key.startsWith('COMPANY_MEMORY_')), 'Donor environment must be absent');
  for (const [key, value] of Object.entries(releaseEnvironment(dataDir, commit))) {
    assert(environment[key] === value, `Release environment mismatch: ${key}`);
  }
}

/** Read all repeated EnvironmentFiles fields; a base unit is not the effective unit. */
export function assertEffectiveRelease({ properties, runtimeText, managerEnvironment = '', codeRoot, dataDir, commit, ownedDropInPath }) {
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
  const files = merged.get('EnvironmentFiles');
  assert(files?.length === 1 && files[0] === `${dataDir}/runtime.env (ignore_errors=no)`,
    'Effective EnvironmentFile chain mismatch');
  assert(propertyWords(one('DropInPaths')).includes(ownedDropInPath), 'Owned release drop-in is not loaded');
  const environment = Object.fromEntries(managerEnvironment.split('\n').filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const assignment of propertyWords(one('Environment'))) {
    const equal = assignment.indexOf('=');
    assert(equal > 0 && !assignment.startsWith('COMPANY_MEMORY_'), 'Effective Environment donor/conflict');
    environment[assignment.slice(0, equal)] = assignment.slice(equal + 1);
  }
  for (const record of environmentFileRecords(runtimeText)) {
    assert(!record.donor, 'Runtime donor assignment must be absent');
    if (record.key) environment[record.key] = record.value;
  }
  const unset = propertyWords(one('UnsetEnvironment'));
  for (const name of [...donorNames, ...managerDonorNames(managerEnvironment)]) {
    assert(unset.includes(name), 'Inherited donor is not explicitly neutralised');
  }
  for (const assignment of unset) {
    const equal = assignment.indexOf('=');
    if (equal < 0) delete environment[assignment];
    else if (environment[assignment.slice(0, equal)] === assignment.slice(equal + 1)) delete environment[assignment.slice(0, equal)];
  }
  assertReleaseEnvironment(environment, { dataDir, commit });
}
