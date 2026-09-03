#!/usr/bin/env node

import { join } from 'node:path';
import {
  OAUTH_CLI_PROVIDERS,
  oauthCliProviderStatus,
  oauthProviderLoginInstructions,
  runOAuthCliProvider,
} from '../src/ai/oauth-cli-provider.js';
import { parseAiAnalysis } from '../src/ai-contract.js';

const command = String(process.argv[2] || 'status').trim().toLowerCase();
const provider = String(process.argv[3] || '').trim();
const providers = provider ? [provider] : Object.keys(OAUTH_CLI_PROVIDERS);

function assertProvider(value) {
  if (!OAUTH_CLI_PROVIDERS[value]) {
    throw new Error(`Provider must be one of: ${Object.keys(OAUTH_CLI_PROVIDERS).join(', ')}.`);
  }
}

if (command === 'status') {
  const statuses = [];
  for (const item of providers) {
    assertProvider(item);
    statuses.push(await oauthCliProviderStatus(item, { cwd: process.cwd() }));
  }
  console.log(JSON.stringify({ oauthProviders: statuses }, null, 2));
} else if (command === 'instructions') {
  const instructions = [];
  for (const item of providers) {
    assertProvider(item);
    instructions.push(oauthProviderLoginInstructions(item));
  }
  console.log(JSON.stringify({ instructions }, null, 2));
} else if (command === 'test') {
  assertProvider(provider);
  if (String(process.env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI || '') !== '1') {
    throw new Error('Set MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=1 explicitly before a live OAuth provider test.');
  }
  const model = String(process.argv[4] || OAUTH_CLI_PROVIDERS[provider].defaultModel).trim();
  const source = 'OAuth provider live connection test. No real email content is included.';
  const prompt = [
    'Return only JSON matching the supplied output schema.',
    'Message ID: oauth-admin-test',
    'Subject: OAuth provider live connection test',
    `Body: ${source}`,
    'Classify as reference, return no next actions, and quote the exact body sentence as evidence.',
  ].join('\n');
  const result = await runOAuthCliProvider(provider, prompt, {
    model,
    schemaPath: join(process.cwd(), 'schemas', 'mail-analysis.schema.json'),
    timeoutMs: 180_000,
  });
  const parsed = parseAiAnalysis(result.text, {
    expectedMessageIds: ['oauth-admin-test'],
    sourceTextById: { 'oauth-admin-test': `OAuth provider live connection test\n${source}` },
  });
  console.log(JSON.stringify({
    liveOAuthTest: 'PASS',
    provider,
    model: result.model,
    messageCount: parsed.messages.length,
    evidenceVerified: parsed.messages.every((item) => item.evidenceVerified === true),
  }, null, 2));
} else {
  throw new Error('Usage: oauth-provider-admin.mjs status [provider] | instructions [provider] | test <provider> [model]');
}
