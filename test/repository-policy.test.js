import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFile(join(root, path), 'utf8');

async function exists(path) {
  try {
    await access(join(root, path), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('approved planning baseline, historical release, current release and project rules remain present', async () => {
  const required = [
    'AGENTS.md',
    'docs/planning/README.md',
    'docs/planning/00-PROJECT-DEFINITION.md',
    'docs/planning/01-REQUIREMENTS.md',
    'docs/planning/02-DATA-AND-ARCHITECTURE.md',
    'docs/planning/03-DEVELOPMENT-PLAN.md',
    'docs/planning/04-TEST-AND-RELEASE-GATES.md',
    'docs/releases/v1.0.1-IMPLEMENTATION-REPORT.md',
    'docs/releases/v1.0.1-RELEASE-CHECKLIST.md',
    'docs/releases/v1.2.0-IMPLEMENTATION-REPORT.md',
    'docs/releases/v1.2.0-RELEASE-CHECKLIST.md',
    'docs/planning/V1.2.0-PRECISION-CLASSIFICATION-PLAN.md',
    'docs/releases/v1.2.0-IMPLEMENTATION-REPORT.md',
    'docs/releases/v1.2.0-RELEASE-CHECKLIST.md',
    'docs/releases/v1.2.0-TAILNET-EXPOSURE-REPORT.md',
    'docs/planning/V1.2.1-OAUTH-LLM-PROVIDERS.md',
    'docs/planning/V1.2.2-OPERATIONAL-CLASSIFICATION-STABILIZATION.md',
    'docs/qa/ASIDE-V1.2.2-FINAL-INDEPENDENT-RELEASE-QA-INSTRUCTIONS.md',
    'docs/planning/V1.2.1-QA-FIX5-ACCURACY-DESIGN.md',
    'docs/planning/V1.2.1-QA-FIX7-EVENT-CLASSIFICATION-DESIGN.md',
    'docs/releases/v1.2.1-QA-FIX5-ACCURACY-IMPLEMENTATION-REPORT.md',
    'docs/qa/ASIDE-V1.2.1-REVALIDATION-ROUND-4-INSTRUCTIONS.md',
    'docs/releases/v1.2.1-IMPLEMENTATION-REPORT.md',
    'docs/releases/v1.2.1-QA-FIX7-IMPLEMENTATION-REPORT.md',
    'docs/qa/ASIDE-V1.2.1-QA-FIX7-BLIND-REVALIDATION-INSTRUCTIONS.md',
    'docs/releases/v1.2.1-RELEASE-CHECKLIST.md',
    'docs/handover/CHATGPT-WORK-INSTRUCTIONS.md',
    'docs/runbooks/PERSISTENT-MAIL-MEMORY.md',
    'docs/runbooks/UBUNTU-DEPLOYMENT.md',
    'deploy/systemd/mail-intelligence-tailnet.service',
    'src/security/tcp-allowlist-proxy.js',
    'scripts/activate-tailnet-proxy.sh',
    'scripts/run-tailnet-proxy.mjs',
    'scripts/verify-tailnet-exposure.mjs',
    'scripts/verify-fresh-extract.sh',
    'scripts/verify-working-copy-snapshot.sh',
    'test/tcp-allowlist-proxy.test.js',
    'test/fixtures/precision-evaluation.json',
    'test/fixtures/aside-round3-fixed-50.json',
    'test/fixtures/README.md',
    'test/fixtures/aside-qafix5-blind-fixed-50.json',
    'test/fixtures/aside-qafix6-blind-fixed-50.json',
    'scripts/evaluate-precision-classification.mjs',
    'scripts/evaluate-independent-ground-truth.mjs',
    'scripts/prepare-blind-holdout.mjs',
    'scripts/inspect-blind-holdout.mjs',
    'scripts/finalize-blind-holdout.mjs',
    'scripts/prepare-incident-security-supplement.mjs',
  ];
  for (const path of required) assert.equal(await exists(path), true, `${path} must exist`);

  const agents = await read('AGENTS.md');
  assert.match(agents, /INGEST -> NORMALIZE -> LINK -> EXTRACT -> RECONCILE -> STORE/);
  assert.match(agents, /CORRECT\/APPROVE -> LEARN -> RE-EVALUATE/);
});

test('package release contract is pinned to v1.2.2 verification', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const packageLock = JSON.parse(await read('package-lock.json'));
  assert.equal(packageJson.version, '1.2.2');
  assert.equal(packageLock.version, '1.2.2');
  assert.equal(packageLock.packages[''].version, '1.2.2');
  assert.match(packageJson.scripts.check, /ai-contract\.js/);
  assert.match(packageJson.scripts.check, /safety\.js/);
  assert.match(packageJson.scripts.check, /persistent-mail-memory\.js/);
  assert.match(packageJson.scripts.check, /precision-intelligence\.js/);
  assert.match(packageJson.scripts.check, /precision-classifier\.js/);
  assert.match(packageJson.scripts.check, /mail-event-extractor\.js/);
  assert.match(packageJson.scripts.check, /search-semantic-ranker\.js/);
  assert.match(packageJson.scripts.check, /intelligent-search\.js/);
  assert.match(packageJson.scripts.check, /operational-classification\.js/);
  assert.match(packageJson.scripts.check, /mail-assistant-tools\.js/);
  assert.match(packageJson.scripts.check, /mail-assistant\.js/);
  assert.match(packageJson.scripts.check, /verify-v1\.2\.2-operational-safety\.mjs/);
  assert.match(packageJson.scripts.check, /tcp-allowlist-proxy\.js/);
  assert.match(packageJson.scripts.check, /verify-tailnet-exposure\.mjs/);
  assert.match(packageJson.scripts.check, /oauth-cli-provider\.js/);
  assert.match(packageJson.scripts.check, /oauth-provider-admin\.mjs/);
  assert.match(packageJson.scripts.check, /backup-restore\.js/);
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.match(packageJson.scripts['verify:v1.2.2'], /verify:health:full/);
  assert.match(packageJson.scripts['verify:v1.2.2'], /verify:safety/);
  assert.match(packageJson.scripts['verify:v1.2.2'], /npm run audit/);
  assert.match(packageJson.scripts['verify:v1.2.2'], /evaluate:precision/);
  assert.match(packageJson.scripts['verify:v1.2.2'], /verify:oauth/);
  assert.match(packageJson.scripts['verify:v1.2.2'], /verify:qa:v1\.2\.2/);
  assert.equal(packageJson.scripts['verify:qa:v1.2.2'], 'node scripts/verify-v1.2.2-operational-safety.mjs');
  assert.equal(packageJson.scripts['verify:tailnet'], 'node scripts/verify-tailnet-exposure.mjs');
  assert.equal(packageJson.scripts['tailnet:activate'], 'bash scripts/activate-tailnet-proxy.sh');
  assert.equal(packageJson.scripts['verify:fresh'], 'bash scripts/verify-fresh-extract.sh');
  assert.equal(packageJson.scripts['verify:live:delta-twice'], 'node scripts/verify-live-delta-twice.mjs');
  assert.equal(packageJson.scripts['verify:backup:isolated'], 'node scripts/verify-isolated-backup-restore.mjs');
  assert.equal(packageJson.scripts['verify:snapshot'], 'bash scripts/verify-working-copy-snapshot.sh');
  assert.match(packageJson.scripts['evaluate:independent:round3'], /aside-round3-fixed-50\.json/);
  assert.match(packageJson.scripts['verify:qa:known-acceptance'], /evaluate:independent:round3/);
  assert.match(packageJson.scripts['verify:qa:known-acceptance'], /evaluate:independent:qafix5-blind/);
  assert.match(packageJson.scripts['verify:qa:known-acceptance'], /evaluate:independent:qafix6-blind/);
  assert.match(packageJson.scripts['evaluate:independent:qafix5-blind'], /aside-qafix5-blind-fixed-50\.json/);
  assert.match(packageJson.scripts['verify:qa:known-acceptance'], /evaluate:independent:qafix5-blind/);
  assert.equal(packageJson.scripts['qa:holdout:prepare'], 'node scripts/prepare-blind-holdout.mjs');
  assert.equal(packageJson.scripts['qa:holdout:inspect'], 'node scripts/inspect-blind-holdout.mjs');
  assert.equal(packageJson.scripts['qa:holdout:finalize'], 'node scripts/finalize-blind-holdout.mjs');
  assert.equal(packageJson.scripts['qa:holdout:prepare:incident'], 'node scripts/prepare-incident-security-supplement.mjs');
  assert.match(packageJson.scripts['qa:holdout:prepare:qafix7'], /aside-qafix6-blind-fixed-50\.json/);
  assert.match(packageJson.scripts['qa:holdout:prepare:qafix7'], /qa-fix7-blind-holdout-template\.json/);
  assert.match(packageJson.scripts['qa:holdout:prepare:qafix7-incident'], /qa-fix7-incident-security-supplement-template\.json/);
  assert.match(packageJson.scripts.check, /prepare-blind-holdout\.mjs/);
  assert.match(packageJson.scripts.check, /inspect-blind-holdout\.mjs/);
  assert.match(packageJson.scripts.check, /finalize-blind-holdout\.mjs/);
  assert.match(packageJson.scripts.check, /prepare-incident-security-supplement\.mjs/);
  assert.equal(packageJson.scripts.verify, 'npm run verify:v1.2.2');
});

test('blind QA tooling shares one version contract and supports the five-message incident supplement', async () => {
  const prepare = await read('scripts/prepare-blind-holdout.mjs');
  const incident = await read('scripts/prepare-incident-security-supplement.mjs');
  const finalize = await read('scripts/finalize-blind-holdout.mjs');
  const evaluate = await read('scripts/evaluate-independent-ground-truth.mjs');

  for (const source of [prepare, incident, finalize]) {
    assert.match(source, /independent-ground-truth-draft-v1/);
  }
  assert.match(finalize, /--expected-count/);
  assert.match(evaluate, /--expected-count/);
  assert.match(evaluate, /importantActionMiss/);
  assert.match(evaluate, /importantPriorityMiss/);
});

test('independent QA contracts keep importance separate and exclude all known benchmarks', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const evaluator = await read('scripts/evaluate-independent-ground-truth.mjs');
  const holdout = await read('scripts/prepare-blind-holdout.mjs');
  const audit = await read('scripts/audit-ground-truth-consistency.mjs');
  assert.match(evaluator, /important-priority-and-action-v3/);
  assert.match(evaluator, /expected\.priority !== 'low'/);
  assert.match(evaluator, /importantActionMiss = expectedActionable/);
  assert.match(evaluator, /legacyImportantLowRate/);
  assert.match(holdout, /aside-qafix5-blind-fixed-50\.json/);
  assert.match(holdout, /aside-qafix6-blind-fixed-50\.json/);
  assert.match(packageJson.scripts['evaluate:independent:qafix6-blind'], /aside-qafix6-blind-fixed-50\.json/);
  assert.match(holdout, /excludedKnownBenchmarks/);
  assert.match(holdout, /exclusionFiles/);
  assert.match(audit, /conflictingTemplatesAreNotValidStrictRegressionGates/);
  assert.match(audit, /freshBlindHoldoutRemainsReleaseDecisive/);
  assert.match(packageJson.scripts['qa:ground-truth:audit'], /audit-ground-truth-consistency/);
  assert.match(packageJson.scripts['evaluate:independent:qafix5-blind:report'], /--report-only/);
});

test('deployment verification uses a private project-local temp directory', async () => {
  const deploy = await read('scripts/deploy-user-service.sh');
  assert.match(deploy, /MAIL_INTELLIGENCE_TEST_TMP_DIR/);
  assert.match(deploy, /data\/deploy-test-runtime/);
  assert.match(deploy, /chmod 0700/);
  assert.match(deploy, /export TMPDIR/);
});

test('CI is blocking and CD only creates a manually verified package', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const cd = await read('.github/workflows/cd.yml');
  const combined = `${ci}\n${cd}`;

  assert.doesNotMatch(combined, /\|\|\s*true/);
  for (const command of [
    'npm ci',
    'npm run check',
    'npm test',
    'npm run lint',
    'npm run validate:html',
    'npm run validate:css',
    'npm run verify:health:full',
    'npm audit --audit-level=high',
  ]) {
    assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(cd, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(cd, /^\s{2}push:/m);
  assert.doesNotMatch(cd, /\bsecrets\./i);
  assert.doesNotMatch(cd, /^\s*(?:ssh|scp|sudo|systemctl|pm2|nohup|pkill)\b/im);
  assert.doesNotMatch(cd, /environment:\s*(?:production|staging)/i);
  assert.match(cd, /npm run verify:v1\.2\.2/);
  assert.match(cd, /No SSH, server restart, deployment, mail mutation, or external publication was performed/);
});

test('runtime source keeps the read-only boundary and authoritative SQLite contract', async () => {
  const server = await read('server.mjs');
  const app = await read('src/app.js');
  const html = await read('src/index.html');
  const safety = await read('src/safety.js');
  const oauthProvider = await read('src/ai/oauth-cli-provider.js');
  const proxy = await read('src/security/tcp-allowlist-proxy.js');
  const proxyUnit = await read('deploy/systemd/mail-intelligence-tailnet.service');
  const activateUserService = await read('scripts/activate-user-service.sh');

  assert.doesNotMatch(server, /\/sendMail\b/);
  assert.doesNotMatch(server, /method:\s*['"]PATCH['"]/);
  assert.doesNotMatch(server, /Mail\.Send|Mail\.ReadWrite/);
  assert.doesNotMatch(server, /notifyDataPlaneHook/);
  assert.doesNotMatch(app, /\/api\/outlook\/(?:send|read)\b/);
  assert.doesNotMatch(app, /oauth\/start\?/);
  assert.match(app, /apiFetch\('\/api\/outlook\/oauth\/start',\s*\{\s*method:\s*'POST'/s);
  assert.doesNotMatch(app, /markMessageRead\s*\(/);
  assert.match(app, /function safeExternalUrl/);
  assert.match(app, /parsed\.protocol === 'https:'/);
  assert.match(app, /초안 복사/);
  assert.match(html, /v1\.2\.2 읽기 전용 운영 안정화/);
  assert.match(html, /프로젝트는 자동 생성하지 않습니다/);
  assert.match(html, /id="precisionIntelligence"/);
  assert.match(html, /id="persistentMemory"/);
  assert.match(html, /value="rules" selected/);
  assert.match(server, /aiProvider:\s*'rules'/);
  assert.match(server, /PersistentMailMemoryRuntime/);
  assert.match(server, /mail-intelligence\.sqlite/);
  assert.doesNotMatch(server, /function loadMailCache|function updateMailCache/);
  assert.doesNotMatch(server, /\/api\/storage\/restore/);
  assert.match(app, /\/api\/storage\/status/);
  assert.match(app, /\/api\/intelligence\/search/);
  assert.match(app, /\/api\/intelligence\/correct/);
  assert.match(server, /\/api\/intelligence\/projects/);
  assert.match(server, /PRECISION_CLASSIFICATION_VERSION/);
  assert.match(server, /\/api\/ai\/oauth\/status/);
  assert.match(server, /\/api\/ai\/oauth\/test/);
  assert.match(server, /openai-codex-oauth/);
  assert.match(server, /xai-grok-oauth/);
  assert.match(server, /MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS/);
  assert.match(server, /parseTailnetAllowedHosts/);
  assert.match(safety, /mailSend:\s*false/);
  assert.match(safety, /dataPlaneWrite:\s*false/);
  assert.match(safety, /read-only-v1\.2\.2/);
  assert.match(safety, /normalizeLoopbackHost/);
  assert.match(oauthProvider, /codex login --device-auth/);
  assert.match(oauthProvider, /grok login --device-auth/);
  assert.match(oauthProvider, /--ignore-user-config/);
  assert.match(oauthProvider, /GROK_DISALLOWED_TOOLS/);
  assert.doesNotMatch(oauthProvider, /OPENAI_API_KEY\s*=/);
  assert.doesNotMatch(oauthProvider, /XAI_API_KEY\s*=/);
  assert.match(proxy, /100\.64\.0\.0\/10/);
  assert.match(proxy, /Proxy bind host must be one explicit non-loopback IPv4 address/);
  assert.match(proxy, /Proxy target host must remain on IPv4 loopback/);
  assert.match(proxy, /clientAddressAllowed/);
  assert.doesNotMatch(proxy, /server\.listen\([^\n]*['"]0\.0\.0\.0['"]/);
  assert.match(proxyUnit, /tailnet-only TCP exposure/);
  assert.match(proxyUnit, /NoNewPrivileges=true/);
  assert.doesNotMatch(proxyUnit, /User=root/);
  assert.match(activateUserService, /tailnet-proxy\.env/);
  assert.match(activateUserService, /MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS=\$ALLOWED_PROXY_HOSTS/);
  assert.match(activateUserService, /parseTailnetAllowedHosts/);
});

test('obsolete duplicate entrypoints remain removed', async () => {
  for (const path of ['app.js', 'index.html', 'styles.css', 'architecture.html']) {
    assert.equal(await exists(path), false, `${path} must remain removed`);
  }
  for (const path of ['src/app.js', 'src/index.html', 'src/styles.css']) {
    assert.equal(await exists(path), true, `${path} is canonical`);
  }
});

test('README declares the current v1.2.2 operational-classification contract', async () => {
  const readme = await read('README.md');
  assert.match(readme, /Version: 1\.2\.2/);
  assert.match(readme, /Mail\.Read/);
  assert.match(readme, /Mail\.Send.*요청하지 않습니다/s);
  assert.match(readme, /authoritative SQLite/i);
  assert.match(readme, /Delta/);
  assert.match(readme, /memory:backup/);
  assert.match(readme, /세분화가 아니라 정밀화/);
  assert.match(readme, /REVIEW_REQUIRED/);
  assert.match(readme, /DO_NOW/);
  assert.match(readme, /WAITING/);
  assert.match(readme, /ARCHIVE/);
  assert.match(readme, /Silent Action Miss/);
  assert.match(readme, /ASIDE-V1\.2\.2-FINAL-INDEPENDENT-RELEASE-QA-INSTRUCTIONS/);
  assert.match(readme, /프로젝트.*자동 생성하지/s);
  assert.match(readme, /지능형 탐색/);
  assert.match(readme, /Tailnet 전용 포트/);
  assert.match(readme, /100\.64\.0\.0\/10/);
  assert.match(readme, /Outlook 전체 메일을 지속적으로 분석해 프로젝트·업무/);
  assert.match(readme, /실제 Microsoft OAuth 연결/);
  assert.match(readme, /openai-codex-oauth/);
  assert.match(readme, /xai-grok-oauth/);
  assert.match(readme, /OAuth Access Token이나 Refresh Token을 읽거나 복사해 자체 DB에 저장하지 않습니다/);
  assert.match(readme, /Provider 간 자동 폴백.*하지 않음/s);
});
