#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { INTELLIGENT_SEARCH_VERSION } from '../src/domain/intelligent-search.js';
import { PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const dataRoot = resolve(projectRoot, process.env.MAIL_INTELLIGENCE_DATA_DIR || 'data');
const tempRoot = resolve(dataRoot, 'tmp');
const databasePath = resolve(dataRoot, 'mail-intelligence.sqlite');
const walPath = `${databasePath}-wal`;
const pidPath = resolve(tempRoot, 'qa-fix8-stability.pid');
const logPath = resolve(tempRoot, 'qa-fix8-stability.log');
const jsonlPath = resolve(tempRoot, 'qa-fix8-stability.jsonl');
const summaryPath = resolve(tempRoot, 'qa-fix8-stability-summary.json');
const samplesRequested = boundedInteger(process.env.MI_STABILITY_SAMPLES, 31, 1, 120);
const intervalMs = boundedInteger(process.env.MI_STABILITY_INTERVAL_MS, 60_000, 1_000, 3_600_000);
const expectedSafetyFlags = Object.freeze({
  MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
  MAIL_INTELLIGENCE_ALLOW_SEND: '0',
  MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
  MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
  MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
});
const userId = typeof process.getuid === 'function' ? process.getuid() : 1000;
const commandEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${userId}`,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${userId}/bus`,
};

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function ensureRuntimeDirectory() {
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const mode = statSync(tempRoot).mode & 0o777;
  if (mode !== 0o700) throw new Error(`Stability runtime directory must be mode 0700, got ${mode.toString(8)}.`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function currentObserverPid() {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function processSafeFlags(pid) {
  const values = {};
  for (const name of Object.keys(expectedSafetyFlags)) values[name] = null;
  if (!Number.isInteger(pid) || pid <= 0) return values;
  try {
    const entries = readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    for (const entry of entries) {
      const offset = entry.indexOf('=');
      if (offset < 1) continue;
      const name = entry.slice(0, offset);
      if (Object.hasOwn(values, name)) values[name] = entry.slice(offset + 1);
    }
  } catch {
    // The contract fails closed when the active process environment cannot be read.
  }
  return values;
}

async function startObserver() {
  ensureRuntimeDirectory();
  const existingPid = currentObserverPid();
  if (isProcessAlive(existingPid)) {
    console.log(JSON.stringify({
      stabilityObserver: 'ALREADY_RUNNING',
      pid: existingPid,
      summaryPath,
      jsonlPath,
      logPath,
    }, null, 2));
    return;
  }

  for (const path of [pidPath, logPath, jsonlPath, summaryPath]) rmSync(path, { force: true });
  const logFd = openSync(logPath, 'w', 0o600);
  const child = spawn(process.execPath, [scriptPath, '--observe'], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      TMPDIR: tempRoot,
      MI_STABILITY_SAMPLES: String(samplesRequested),
      MI_STABILITY_INTERVAL_MS: String(intervalMs),
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('Failed to start stability observer.');
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    stabilityObserver: 'STARTED',
    pid: child.pid,
    samplesRequested,
    intervalMs,
    expectedDurationSeconds: Math.round(((samplesRequested - 1) * intervalMs) / 1000),
    summaryPath,
    jsonlPath,
    logPath,
  }, null, 2));
}

function observerStatus() {
  ensureRuntimeDirectory();
  const pid = currentObserverPid();
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') summary = { status: 'UNREADABLE', error: error?.message || 'summary_error' };
  }
  console.log(JSON.stringify({
    stabilityObserver: isProcessAlive(pid) ? 'RUNNING' : summary?.status || 'NOT_STARTED',
    pid: pid || null,
    processAlive: isProcessAlive(pid),
    summary,
    summaryPath,
    jsonlPath,
    logPath,
  }, null, 2));
}

function systemctlShow(unit) {
  const result = spawnSync('systemctl', [
    '--user', 'show', unit,
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts',
    '-p', 'ActiveEnterTimestamp', '--no-pager',
  ], { encoding: 'utf8', env: commandEnv });
  const values = {};
  for (const line of String(result.stdout || '').split('\n')) {
    const offset = line.indexOf('=');
    if (offset < 1) continue;
    values[line.slice(0, offset)] = line.slice(offset + 1);
  }
  const mainPid = Number(values.MainPID || 0);
  return {
    commandExit: result.status,
    activeState: values.ActiveState || '',
    subState: values.SubState || '',
    mainPid,
    nRestarts: Number(values.NRestarts || 0),
    activeEnterTimestamp: values.ActiveEnterTimestamp || '',
    safeFlags: processSafeFlags(mainPid),
  };
}

async function getHealth(url, timeoutMs = 5_000) {
  return await new Promise((resolveHealth) => {
    const request = http.get(url, { headers: { Connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = {};
        }
        resolveHealth({
          ok: response.statusCode === 200 && body.ok === true,
          status: response.statusCode || 0,
          service: body.service || '',
          version: body.version || '',
          classifier: body.precisionClassificationVersion || '',
          search: body.intelligentSearchVersion || '',
          safetyMode: body.safety?.mode || '',
          externalActionsAllowed: body.externalActionsAllowed,
          graphConsent: Array.isArray(body.graphConsent) ? body.graphConsent : [],
          error: '',
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('health_timeout')));
    request.on('error', (error) => resolveHealth({
      ok: false,
      status: 0,
      service: '',
      version: '',
      classifier: '',
      search: '',
      safetyMode: '',
      externalActionsAllowed: null,
      graphConsent: [],
      error: error?.code || error?.message || 'health_error',
    }));
  });
}

async function processMetrics(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { rssKb: 0, cpuPercent: 0 };
  let rssKb = 0;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    rssKb = Number(match?.[1] || 0);
  } catch {
    rssKb = 0;
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf8' });
  return { rssKb, cpuPercent: Number(String(ps.stdout || '').trim() || 0) };
}

function databaseMetrics() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS active_messages,
        (SELECT COUNT(*) FROM precision_classifications pc JOIN messages m ON m.id = pc.message_id WHERE m.deleted_at IS NULL) AS active_classifications,
        (SELECT COUNT(*) FROM operator_jobs) AS operator_jobs,
        (SELECT COUNT(*) FROM dead_letter_events) AS dead_letters,
        (SELECT COUNT(*) FROM (SELECT graph_id FROM messages WHERE deleted_at IS NULL GROUP BY graph_id HAVING COUNT(*) > 1)) AS duplicate_graph_ids,
        (SELECT COUNT(*) FROM precision_classifications pc JOIN messages m ON m.id = pc.message_id WHERE m.deleted_at IS NULL AND pc.prompt_version = ?) AS expected_version
    `).get(PRECISION_CLASSIFICATION_VERSION);
    const quickCheck = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all().length;
    return {
      activeMessages: Number(counts.active_messages || 0),
      activeClassifications: Number(counts.active_classifications || 0),
      operatorJobs: Number(counts.operator_jobs || 0),
      deadLetters: Number(counts.dead_letters || 0),
      duplicateGraphIds: Number(counts.duplicate_graph_ids || 0),
      expectedVersion: Number(counts.expected_version || 0),
      quickCheck,
      foreignKeyErrors,
    };
  } finally {
    db.close();
  }
}

async function fileSize(path) {
  try {
    return Number((await stat(path)).size || 0);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function safeFlagsPass(unit) {
  return Object.entries(expectedSafetyFlags).every(([name, value]) => unit.safeFlags[name] === value);
}

async function captureSample(index, samples, jsonlTarget) {
  const backend = systemctlShow('mail-intelligence.service');
  const tailnet = systemctlShow('mail-intelligence-tailnet.service');
  const [localHealth, tailnetHealth, backendProcess, tailnetProcess, walSizeBytes] = await Promise.all([
    getHealth('http://127.0.0.1:3010/api/health'),
    getHealth('http://100.87.81.57:3010/api/health'),
    processMetrics(backend.mainPid),
    processMetrics(tailnet.mainPid),
    fileSize(walPath),
  ]);
  const database = databaseMetrics();
  const sample = {
    index,
    observedAt: new Date().toISOString(),
    localHealth,
    tailnetHealth,
    backend: { ...backend, ...backendProcess },
    tailnet: { ...tailnet, ...tailnetProcess },
    database,
    walSizeBytes,
    contracts: {
      servicesActive: backend.activeState === 'active' && backend.subState === 'running'
        && tailnet.activeState === 'active' && tailnet.subState === 'running',
      healthVersions: localHealth.classifier === PRECISION_CLASSIFICATION_VERSION
        && localHealth.search === INTELLIGENT_SEARCH_VERSION
        && tailnetHealth.classifier === PRECISION_CLASSIFICATION_VERSION
        && tailnetHealth.search === INTELLIGENT_SEARCH_VERSION,
      readOnly: localHealth.safetyMode === 'read-only'
        && tailnetHealth.safetyMode === 'read-only'
        && localHealth.externalActionsAllowed === false
        && tailnetHealth.externalActionsAllowed === false,
      graphReadOnly: localHealth.graphConsent.includes('Mail.Read')
        && !localHealth.graphConsent.includes('Mail.Send')
        && !localHealth.graphConsent.includes('Mail.ReadWrite'),
      safetyFlags: safeFlagsPass(backend),
      countParity: database.activeMessages === database.activeClassifications,
      versionPurity: database.expectedVersion === database.activeClassifications,
      sqliteIntegrity: database.quickCheck.length === 1 && database.quickCheck[0] === 'ok'
        && database.foreignKeyErrors === 0,
      noDuplicateGraphIds: database.duplicateGraphIds === 0,
      noRestarts: backend.nRestarts === 0 && tailnet.nRestarts === 0,
    },
  };
  samples.push(sample);
  await appendFile(jsonlTarget, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
}

function journalMetrics(startedAt) {
  const since = `@${Math.floor(startedAt.getTime() / 1000)}`;
  const result = spawnSync('journalctl', [
    '--user', '-u', 'mail-intelligence.service', '-u', 'mail-intelligence-tailnet.service',
    '--since', since, '--no-pager', '-o', 'cat',
  ], { encoding: 'utf8', env: commandEnv, maxBuffer: 4 * 1024 * 1024 });
  const lines = String(result.stdout || '').split('\n').filter(Boolean);
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  return {
    journalExit: result.status,
    totalLines: lines.length,
    fatalUnhandledOom: count(/fatal|unhandled|uncaught|out[ -]?of[ -]?memory|\boom\b/i),
    graphErrors: count(/graph[^\n]*(?:429|5\d\d|error|failed)|(?:429|5\d\d|error|failed)[^\n]*graph/i),
    oauthErrors: count(/oauth[^\n]*(?:error|failed|retry)|(?:error|failed|retry)[^\n]*oauth/i),
    retrySignals: count(/\bretr(?:y|ies|ied|ying)\b/i),
  };
}

function numericRange(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length
    ? { min: Math.min(...finite), max: Math.max(...finite), first: finite[0], last: finite.at(-1) }
    : null;
}

async function observe() {
  ensureRuntimeDirectory();
  const startedAt = new Date();
  const samples = [];
  await writeFile(jsonlPath, '', { mode: 0o600 });
  await writeFile(summaryPath, JSON.stringify({
    status: 'RUNNING',
    startedAt: startedAt.toISOString(),
    samplesRequested,
    intervalMs,
    classifierVersion: PRECISION_CLASSIFICATION_VERSION,
    searchVersion: INTELLIGENT_SEARCH_VERSION,
  }, null, 2), { mode: 0o600 });

  let fatalError = null;
  try {
    for (let index = 1; index <= samplesRequested; index += 1) {
      if (index > 1) await delay(intervalMs);
      await captureSample(index, samples, jsonlPath);
    }
  } catch (error) {
    fatalError = {
      name: error?.name || 'Error',
      code: error?.code || '',
      message: error?.message || 'observer_failed',
    };
  }

  const journal = journalMetrics(startedAt);
  const backendPids = [...new Set(samples.map((sample) => sample.backend.mainPid).filter(Boolean))];
  const tailnetPids = [...new Set(samples.map((sample) => sample.tailnet.mainPid).filter(Boolean))];
  const healthyCount = samples.filter((sample) => sample.localHealth.ok && sample.tailnetHealth.ok).length;
  const contractPassCount = samples.filter((sample) => Object.values(sample.contracts).every(Boolean)).length;
  const first = samples[0] || null;
  const last = samples.at(-1) || null;
  const summary = {
    status: fatalError ? 'FAILED' : samples.length === samplesRequested ? 'COMPLETE' : 'INCOMPLETE',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    samplesRequested,
    samplesCaptured: samples.length,
    intervalMs,
    classifierVersion: PRECISION_CLASSIFICATION_VERSION,
    searchVersion: INTELLIGENT_SEARCH_VERSION,
    healthyCount,
    contractPassCount,
    backendPids,
    tailnetPids,
    backendNRestarts: numericRange(samples.map((sample) => sample.backend.nRestarts)),
    tailnetNRestarts: numericRange(samples.map((sample) => sample.tailnet.nRestarts)),
    backendRssKb: numericRange(samples.map((sample) => sample.backend.rssKb)),
    tailnetRssKb: numericRange(samples.map((sample) => sample.tailnet.rssKb)),
    backendCpuPercent: numericRange(samples.map((sample) => sample.backend.cpuPercent)),
    tailnetCpuPercent: numericRange(samples.map((sample) => sample.tailnet.cpuPercent)),
    walSizeBytes: numericRange(samples.map((sample) => sample.walSizeBytes)),
    activeMessages: numericRange(samples.map((sample) => sample.database.activeMessages)),
    activeClassifications: numericRange(samples.map((sample) => sample.database.activeClassifications)),
    operatorJobs: numericRange(samples.map((sample) => sample.database.operatorJobs)),
    deadLetters: numericRange(samples.map((sample) => sample.database.deadLetters)),
    countMismatchSamples: samples.filter((sample) => !sample.contracts.countParity).length,
    versionPurityFailures: samples.filter((sample) => !sample.contracts.versionPurity).length,
    integrityFailures: samples.filter((sample) => !sample.contracts.sqliteIntegrity).length,
    duplicateGraphIdFailures: samples.filter((sample) => !sample.contracts.noDuplicateGraphIds).length,
    serviceContractFailures: samples.filter((sample) => !sample.contracts.servicesActive).length,
    readOnlyContractFailures: samples.filter((sample) => !sample.contracts.readOnly
      || !sample.contracts.graphReadOnly || !sample.contracts.safetyFlags).length,
    unexpectedRestart: backendPids.length > 1 || tailnetPids.length > 1
      || samples.some((sample) => !sample.contracts.noRestarts),
    deadLetterDelta: first && last ? last.database.deadLetters - first.database.deadLetters : null,
    journal,
    fatalError,
  };
  summary.automaticGate = summary.status === 'COMPLETE'
    && healthyCount === samplesRequested
    && contractPassCount === samplesRequested
    && !summary.unexpectedRestart
    && summary.deadLetterDelta === 0
    && journal.fatalUnhandledOom === 0;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
  try {
    const recordedPid = currentObserverPid();
    if (recordedPid === process.pid) await unlink(pidPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.automaticGate) process.exitCode = 1;
}

const mode = process.argv[2] || '--status';
if (mode === '--start') {
  await startObserver();
} else if (mode === '--status') {
  observerStatus();
} else if (mode === '--observe') {
  await observe();
} else {
  console.error(`Unsupported mode: ${mode}`);
  process.exitCode = 2;
}
