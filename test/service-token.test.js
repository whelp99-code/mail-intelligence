import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SERVICE_SCOPES,
  extractPresentedServiceToken,
  hasServiceScope,
  isUsableServiceToken,
  loadServiceTokens,
  matchServicePrincipal,
  servicePrincipalFromHeaders,
} from '../src/security/service-token.js';

const DRAFT = 'grok-draft-token-0123456789abcdef01234567';
const SERVICE = 'grok-service-token-0123456789abcdef0123';

test('draft token file grants read and draft-create', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'draft.token');
  await writeFile(file, `${DRAFT}\n`, { mode: 0o600 });

  const catalog = loadServiceTokens({
    MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE: file,
  });
  assert.equal(catalog.configured, true);
  const principal = matchServicePrincipal(DRAFT, catalog);
  assert.equal(principal.id, 'grok-draft');
  assert.equal(principal.source, 'grok-bot');
  assert.equal(hasServiceScope(principal, SERVICE_SCOPES.read), true);
  assert.equal(hasServiceScope(principal, SERVICE_SCOPES.draftCreate), true);
});

test('dedicated service token is read-only and distinct from draft token', async () => {
  const catalog = loadServiceTokens({
    MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: DRAFT,
    MAIL_INTELLIGENCE_GROK_SERVICE_TOKEN: SERVICE,
  });
  const service = matchServicePrincipal(SERVICE, catalog);
  const draft = matchServicePrincipal(DRAFT, catalog);
  assert.deepEqual(service.scopes, [SERVICE_SCOPES.read]);
  assert.equal(hasServiceScope(draft, SERVICE_SCOPES.draftCreate), true);
  assert.equal(matchServicePrincipal('wrong-token-0123456789abcdef0123456789', catalog), null);
});

test('Bearer and dedicated headers are accepted; short tokens are rejected', () => {
  assert.equal(isUsableServiceToken('short'), false);
  assert.equal(extractPresentedServiceToken({
    authorization: `Bearer ${DRAFT}`,
  }), DRAFT);
  const principal = servicePrincipalFromHeaders({
    'x-mail-intelligence-service-token': DRAFT,
  }, loadServiceTokens({ MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: DRAFT }));
  assert.equal(principal.id, 'grok-draft');
});
