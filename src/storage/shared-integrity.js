import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Same cadence as the existing company-memory tick. A status read shares that
// generation instead of starting another full scan on the request thread.
export const SHARED_INTEGRITY_MAX_AGE_MS = 30_000;

export function createSharedIntegrity({ check, now = () => Date.now(), maxAgeMs = SHARED_INTEGRITY_MAX_AGE_MS } = {}) {
  if (typeof check !== 'function') throw new TypeError('integrity check is required');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new TypeError('integrity max age is invalid');
  let completed = null;
  let inflight = null;
  let started = 0;
  function start() {
    if (inflight) return inflight;
    started += 1;
    inflight = Promise.resolve().then(() => check()).then((result) => {
      completed = { ok: result?.ok === true, at: now() };
      return completed;
    }, () => {
      completed = { ok: false, at: now() };
      return completed;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }
  return {
    read() {
      const fresh = completed !== null && now() - completed.at < maxAgeMs;
      if (!fresh) start();
      return completed;
    },
    started: () => started,
    settled: () => inflight ?? Promise.resolve(completed),
  };
}

export function jarvisReaderStatus(integrity, countRows) {
  const snapshot = integrity.read();
  const counts = countRows();
  return {
    ready: snapshot?.ok === true,
    counts: {
      messages: Number(counts.messages ?? 0),
      threads: Number(counts.threads ?? 0),
    },
  };
}

export function createReadonlyIntegrityCheck(databasePath) {
  let worker = null;
  let pending = null;
  function fail(error) {
    const reject = pending?.reject;
    pending = null;
    worker = null;
    reject?.(error);
  }
  function spawn() {
    worker = new Worker(fileURLToPath(new URL('./integrity-worker.js', import.meta.url)), {
      workerData: { databasePath },
    });
    worker.unref();
    worker.on('message', (message) => {
      const resolve = pending?.resolve;
      pending = null;
      resolve?.(message);
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (pending) fail(new Error(`integrity worker exited ${code}`));
      else worker = null;
    });
  }
  function run() {
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error('integrity check already running'));
        return;
      }
      if (!worker) spawn();
      pending = { resolve, reject };
      worker.postMessage('check');
    });
  }
  run.close = () => worker?.terminate();
  return run;
}
