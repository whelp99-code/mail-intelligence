import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export const OAUTH_CLI_PROVIDER_VERSION = 'oauth-cli-provider-v1.2.2';
const EXTERNAL_AI_POLICY_BLOCK_CODES = new Set([
  'EXTERNAL_AI_DISABLED',
  'EXTERNAL_AI_OPT_IN_REQUIRED',
]);

export function shouldRecordOAuthProviderFailure(error) {
  return !EXTERNAL_AI_POLICY_BLOCK_CODES.has(String(error?.code || ''));
}

export const OAUTH_CLI_PROVIDERS = Object.freeze({
  'openai-codex-oauth': Object.freeze({
    id: 'openai-codex-oauth',
    label: 'OpenAI · ChatGPT OAuth',
    executable: 'codex',
    defaultModel: 'luna',
    loginCommand: 'codex login --device-auth',
    logoutCommand: 'codex logout',
  }),
  'xai-grok-oauth': Object.freeze({
    id: 'xai-grok-oauth',
    label: 'xAI · Grok OAuth',
    executable: 'grok',
    defaultModel: 'grok-4.6',
    loginCommand: 'grok login --device-auth',
    logoutCommand: 'grok logout',
  }),
});

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const FORBIDDEN_CODEX_ITEM_TYPES = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'image_generation',
]);
const GROK_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'CodeExecution',
  'ImageGeneration',
  'Task',
  'Skill',
];

function cleanText(value, max = 4000) {
  return [...String(value || '')]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, max);
}

function safeModel(value, fallback) {
  const model = cleanText(value, 120);
  if (!model) return fallback;
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) throw new Error('OAuth provider model contains unsupported characters.');
  return model;
}

function providerDefinition(provider) {
  const definition = OAUTH_CLI_PROVIDERS[String(provider || '')];
  if (!definition) throw new Error(`Unsupported OAuth CLI provider: ${provider || '(empty)'}.`);
  return definition;
}

function executableCandidates(executable, configuredPath = '', env = process.env) {
  const candidates = [];
  if (configuredPath) candidates.push(resolve(configuredPath));
  for (const directory of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, executable));
  }
  const home = String(env.HOME || '').trim();
  if (home) {
    candidates.push(join(home, '.local', 'bin', executable));
    candidates.push(join(home, '.grok', 'bin', executable));
  }
  return [...new Set(candidates)];
}

export async function resolveOAuthCliExecutable(provider, {
  configuredPath = '',
  env = process.env,
} = {}) {
  const definition = providerDefinition(provider);
  for (const candidate of executableCandidates(definition.executable, configuredPath, env)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching without exposing filesystem details.
    }
  }
  return '';
}

function childEnvironment(env = process.env) {
  const allowedKeys = [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ];
  const result = {};
  for (const key of allowedKeys) {
    if (typeof env[key] === 'string' && env[key]) result[key] = env[key];
  }
  result.NO_COLOR = '1';
  result.TERM = 'dumb';
  delete result.OPENAI_API_KEY;
  delete result.XAI_API_KEY;
  return result;
}

function appendBounded(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  state.bytes += buffer.length;
  if (state.bytes > MAX_PROCESS_OUTPUT_BYTES) {
    const error = new Error(`OAuth provider process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes.`);
    error.code = 'OAUTH_PROVIDER_OUTPUT_TOO_LARGE';
    throw error;
  }
  chunks.push(buffer);
}

export async function runCliProcess(command, args, {
  cwd,
  env = process.env,
  input = '',
  timeoutMs = 90_000,
  spawnImpl = spawn,
} = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let timer;
    let child;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };

    try {
      child = spawnImpl(command, args, {
        cwd,
        env: childEnvironment(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      const error = new Error(`OAuth provider process timed out after ${timeoutMs}ms.`);
      error.code = 'OAUTH_PROVIDER_TIMEOUT';
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      finish(error);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      try {
        appendBounded(stdout, chunk, stdoutState);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        appendBounded(stderr, chunk, stderrState);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error);
      }
    });
    child.on('close', (code, signal) => finish(null, {
      code: Number.isInteger(code) ? code : -1,
      signal: signal || null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function statusErrorMessage(result) {
  const raw = String(result.stderr || result.stdout || '');
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const message = event?.item?.message || event?.message || event?.error?.message || '';
      if (message && !messages.includes(message)) messages.push(message);
    } catch {
      // Non-JSON stderr is handled below.
    }
  }
  const useful = messages.length ? messages.join(' · ') : raw;
  return cleanText(useful, 500).replace(/(?:sk-|xai-|sess-|eyJ)[A-Za-z0-9._-]{12,}/g, '[REDACTED]');
}

async function executableVersion(command, provider, options) {
  const args = provider === 'openai-codex-oauth' ? ['--version'] : ['version'];
  const result = await runCliProcess(command, args, { ...options, timeoutMs: 10_000 });
  return result.code === 0 ? cleanText(result.stdout || result.stderr, 160) : '';
}

export async function oauthCliProviderStatus(provider, {
  configuredPath = '',
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const definition = providerDefinition(provider);
  const executable = await resolveOAuthCliExecutable(provider, { configuredPath, env });
  if (!executable) {
    return {
      provider,
      label: definition.label,
      installed: false,
      authenticated: false,
      authMode: 'not-installed',
      version: '',
      loginCommand: definition.loginCommand,
      defaultModel: definition.defaultModel,
      error: `${definition.executable} CLI is not installed.`,
    };
  }

  let result;
  if (provider === 'openai-codex-oauth') {
    result = await runCliProcess(executable, ['login', 'status'], {
      cwd,
      env,
      timeoutMs: 12_000,
      spawnImpl,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const chatgpt = result.code === 0 && /logged in using chatgpt|auth(?:entication)? mode:\s*chatgpt/i.test(output);
    const apiKey = result.code === 0 && /api key/i.test(output);
    return {
      provider,
      label: definition.label,
      installed: true,
      authenticated: chatgpt,
      authMode: chatgpt ? 'chatgpt-oauth' : apiKey ? 'api-key-not-accepted' : 'not-authenticated',
      version: await executableVersion(executable, provider, { cwd, env, spawnImpl }),
      loginCommand: definition.loginCommand,
      defaultModel: definition.defaultModel,
      error: chatgpt ? '' : statusErrorMessage(result) || 'ChatGPT OAuth login is required.',
    };
  }

  result = await runCliProcess(executable, ['models'], {
    cwd,
    env,
    timeoutMs: 15_000,
    spawnImpl,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const authenticated = result.code === 0;
  return {
    provider,
    label: definition.label,
    installed: true,
    authenticated,
    authMode: authenticated ? 'grok-oauth' : /login|authenticate|credential|unauthorized/i.test(output)
      ? 'not-authenticated'
      : 'status-unknown',
    version: await executableVersion(executable, provider, { cwd, env, spawnImpl }),
    loginCommand: definition.loginCommand,
    defaultModel: definition.defaultModel,
    error: authenticated ? '' : statusErrorMessage(result) || 'Grok OAuth login or connectivity check is required.',
  };
}

function scanCodexEvents(raw) {
  for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const itemType = String(event?.item?.type || event?.type || '').toLowerCase();
    if (FORBIDDEN_CODEX_ITEM_TYPES.has(itemType)) {
      const error = new Error(`Codex attempted a forbidden tool event: ${itemType}.`);
      error.code = 'OAUTH_PROVIDER_TOOL_USE_REJECTED';
      throw error;
    }
  }
}

function grokTextFromJson(raw) {
  const parsed = JSON.parse(String(raw || '').trim());
  const candidates = [
    parsed.output,
    parsed.response,
    parsed.result,
    parsed.text,
    parsed.content,
    parsed.message?.content,
    parsed.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  if (Array.isArray(parsed.messages)) {
    const last = [...parsed.messages].reverse().find((message) => message?.role === 'assistant');
    if (typeof last?.content === 'string' && last.content.trim()) return last.content.trim();
  }
  throw new Error('Grok CLI JSON output did not contain assistant text.');
}

export async function runOAuthCliProvider(provider, prompt, {
  model = '',
  configuredPath = '',
  schemaPath = '',
  env = process.env,
  timeoutMs = 120_000,
  spawnImpl = spawn,
} = {}) {
  const definition = providerDefinition(provider);
  const executable = await resolveOAuthCliExecutable(provider, { configuredPath, env });
  if (!executable) {
    const error = new Error(`${definition.executable} CLI is not installed.`);
    error.code = 'OAUTH_PROVIDER_NOT_INSTALLED';
    throw error;
  }
  const selectedModel = safeModel(model, definition.defaultModel);
  const executableModel = provider === 'openai-codex-oauth' && selectedModel.toLowerCase() === 'luna'
    ? ''
    : selectedModel;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-'));
  await chmod(temporaryDirectory, 0o700).catch(() => {});
  try {
    if (provider === 'openai-codex-oauth') {
      if (!schemaPath) throw new Error('Codex OAuth provider requires an output schema path.');
      const outputPath = join(temporaryDirectory, 'final.json');
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-rules',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        ...(executableModel ? ['--model', executableModel] : []),
        '--output-schema',
        resolve(schemaPath),
        '--output-last-message',
        outputPath,
        '--cd',
        temporaryDirectory,
        '-',
      ];
      const result = await runCliProcess(executable, args, {
        cwd: temporaryDirectory,
        env,
        input: prompt,
        timeoutMs,
        spawnImpl,
      });
      if (result.code !== 0) {
        const error = new Error(statusErrorMessage(result) || `Codex CLI exited with code ${result.code}.`);
        error.code = /login|auth|credential/i.test(`${result.stdout}\n${result.stderr}`)
          ? 'OAUTH_PROVIDER_NOT_AUTHENTICATED'
          : 'OAUTH_PROVIDER_EXEC_FAILED';
        throw error;
      }
      scanCodexEvents(result.stdout);
      const output = await readFile(outputPath, 'utf8');
      if (!output.trim()) throw new Error('Codex CLI returned an empty final message.');
      return { text: output, model: selectedModel, cli: definition.executable };
    }

    const args = [
      '--no-auto-update',
      '--cwd',
      temporaryDirectory,
      '--model',
      selectedModel,
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--no-plan',
      '--no-subagents',
      '--no-memory',
      '--disable-web-search',
      '--disallowed-tools',
      GROK_DISALLOWED_TOOLS.join(','),
      '-p',
      prompt,
    ];
    const result = await runCliProcess(executable, args, {
      cwd: temporaryDirectory,
      env,
      timeoutMs,
      spawnImpl,
    });
    if (result.code !== 0) {
      const error = new Error(statusErrorMessage(result) || `Grok CLI exited with code ${result.code}.`);
      error.code = /login|auth|credential|unauthorized/i.test(`${result.stdout}\n${result.stderr}`)
        ? 'OAUTH_PROVIDER_NOT_AUTHENTICATED'
        : 'OAUTH_PROVIDER_EXEC_FAILED';
      throw error;
    }
    return { text: grokTextFromJson(result.stdout), model: selectedModel, cli: definition.executable };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function oauthProviderLoginInstructions(provider) {
  const definition = providerDefinition(provider);
  return {
    provider,
    label: definition.label,
    command: definition.loginCommand,
    logoutCommand: definition.logoutCommand,
    note: 'Run this command as the same Ubuntu user that runs Mail Intelligence. The official CLI owns and refreshes its OAuth credential cache.',
  };
}

export async function writeOAuthAnalysisSchema(targetPath) {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['messages'],
    properties: {
      messages: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'confidence', 'summary', 'nextActions', 'evidenceItems', 'aiRationale'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 500 },
            status: { enum: ['urgent', 'active', 'waiting', 'done', 'reference'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            summary: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: { type: 'string', minLength: 1, maxLength: 400 },
            },
            nextActions: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['actionType', 'title', 'recommendedAction', 'owner', 'due', 'priority', 'lane', 'evidence', 'intent', 'to', 'subject', 'body'],
                properties: {
                  actionType: { enum: ['draft_reply', 'request_info', 'share_document', 'review', 'archive', 'monitor', 'create_task'] },
                  title: { type: 'string', maxLength: 180 },
                  recommendedAction: { type: 'string', minLength: 1, maxLength: 600 },
                  owner: { type: 'string', minLength: 1, maxLength: 160 },
                  due: { type: 'string', maxLength: 160 },
                  priority: { type: 'integer', minimum: 1, maximum: 9 },
                  lane: { enum: ['urgent', 'active', 'waiting'] },
                  evidence: { type: 'string', minLength: 1, maxLength: 1200 },
                  intent: { type: 'string', maxLength: 600 },
                  to: { type: 'string', maxLength: 320 },
                  subject: { type: 'string', maxLength: 500 },
                  body: { type: 'string', maxLength: 6000 },
                },
              },
            },
            evidenceItems: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { type: 'string', minLength: 1, maxLength: 1200 },
            },
            aiRationale: { type: 'string', maxLength: 1200 },
          },
        },
      },
    },
  };
  await writeFile(targetPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });
  return targetPath;
}
