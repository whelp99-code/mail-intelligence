import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  oauthCliProviderStatus,
  oauthProviderLoginInstructions,
  resolveOAuthCliExecutable,
  runOAuthCliProvider,
  shouldRecordOAuthProviderFailure,
} from '../src/ai/oauth-cli-provider.js';

const VALID_ANALYSIS = JSON.stringify({
  messages: [{
    id: 'message-1',
    status: 'reference',
    confidence: 0.99,
    summary: ['테스트 요약'],
    nextActions: [],
    evidenceItems: ['테스트 근거'],
    aiRationale: '테스트 판단',
  }],
});

test('operator policy blocks do not overwrite the last real provider health result', () => {
  assert.equal(shouldRecordOAuthProviderFailure({ code: 'EXTERNAL_AI_DISABLED' }), false);
  assert.equal(shouldRecordOAuthProviderFailure({ code: 'EXTERNAL_AI_OPT_IN_REQUIRED' }), false);
  assert.equal(shouldRecordOAuthProviderFailure({ code: 'PROVIDER_TIMEOUT' }), true);
  assert.equal(shouldRecordOAuthProviderFailure(new Error('network failure')), true);
});

async function fakeCli(directory, name, source) {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test('Codex OAuth status accepts ChatGPT login and rejects API-key mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chatgptCli = await fakeCli(root, 'codex-chatgpt', `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 9.9.9');
else if (args[0] === 'login' && args[1] === 'status') console.log('Logged in using ChatGPT');
else process.exitCode = 2;
`);
  const apiCli = await fakeCli(root, 'codex-api', `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 9.9.9');
else if (args[0] === 'login' && args[1] === 'status') console.log('Logged in using API key');
else process.exitCode = 2;
`);

  const status = await oauthCliProviderStatus('openai-codex-oauth', { configuredPath: chatgptCli });
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.authMode, 'chatgpt-oauth');
  assert.match(status.version, /9\.9\.9/);

  const apiStatus = await oauthCliProviderStatus('openai-codex-oauth', { configuredPath: apiCli });
  assert.equal(apiStatus.authenticated, false);
  assert.equal(apiStatus.authMode, 'api-key-not-accepted');
});

test('OAuth provider executable detection fails closed and exposes safe login instructions', async () => {
  const executable = await resolveOAuthCliExecutable('xai-grok-oauth', {
    configuredPath: '/definitely/not/here/grok',
    env: { PATH: '' },
  });
  assert.equal(executable, '');
  const instructions = oauthProviderLoginInstructions('xai-grok-oauth');
  assert.equal(instructions.command, 'grok login --device-auth');
  assert.doesNotMatch(JSON.stringify(instructions), /token|secret/i);
});

test('Codex OAuth provider runs in structured mode and returns the final JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const schemaPath = join(root, 'schema.json');
  await writeFile(schemaPath, '{}');
  const cli = await fakeCli(root, 'codex', `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.includes('mail prompt')) process.exit(4);
  fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(VALID_ANALYSIS)});
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
});
`);
  const result = await runOAuthCliProvider('openai-codex-oauth', 'mail prompt', {
    model: '',
    configuredPath: cli,
    schemaPath,
  });
  assert.equal(result.model, 'luna');
  assert.deepEqual(JSON.parse(result.text), JSON.parse(VALID_ANALYSIS));
});

test('Codex OAuth provider rejects any tool execution event', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const schemaPath = join(root, 'schema.json');
  await writeFile(schemaPath, '{}');
  const cli = await fakeCli(root, 'codex', `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(VALID_ANALYSIS)});
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }));
});
`);
  await assert.rejects(
    runOAuthCliProvider('openai-codex-oauth', 'mail prompt', {
      configuredPath: cli,
      schemaPath,
    }),
    (error) => error?.code === 'OAUTH_PROVIDER_TOOL_USE_REJECTED',
  );
});

test('Grok OAuth status and structured execution work without API keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = await fakeCli(root, 'grok', `
const args = process.argv.slice(2);
if (args[0] === 'version') console.log('grok 9.9.9');
else if (args[0] === 'models') console.log('grok-4.6');
else if (args.includes('--output-format')) console.log(JSON.stringify({ result: ${JSON.stringify(VALID_ANALYSIS)} }));
else process.exitCode = 2;
`);
  const status = await oauthCliProviderStatus('xai-grok-oauth', { configuredPath: cli });
  assert.equal(status.authenticated, true);
  assert.equal(status.authMode, 'grok-oauth');
  const result = await runOAuthCliProvider('xai-grok-oauth', 'mail prompt', {
    configuredPath: cli,
    model: 'grok-4.6',
  });
  assert.deepEqual(JSON.parse(result.text), JSON.parse(VALID_ANALYSIS));
});
