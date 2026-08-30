import { setTimeout as delay } from 'node:timers/promises';

const circuits = new Map();

function stateFor(provider) {
  if (!circuits.has(provider)) circuits.set(provider, { failures: 0, openedUntil: 0 });
  return circuits.get(provider);
}

function isRetryable(error) {
  const code = String(error?.code || '');
  if (['EXTERNAL_ACTION_DISABLED', 'REMOTE_AI_SERVICE_DISABLED', 'AI_CIRCUIT_OPEN'].includes(code)) return false;
  const status = Number(error?.statusCode || 0);
  if (status >= 400 && status < 500) return false;
  return true;
}

function circuitOpenError(provider, openedUntil) {
  const error = new Error(`AI provider circuit is open for ${provider} until ${new Date(openedUntil).toISOString()}.`);
  error.code = 'AI_CIRCUIT_OPEN';
  error.statusCode = 503;
  error.provider = provider;
  error.openedUntil = openedUntil;
  return error;
}

export async function withAiResilience(provider, operation, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250));
  const failureThreshold = Math.max(1, Number(options.failureThreshold ?? 3));
  const cooldownMs = Math.max(1, Number(options.cooldownMs ?? 60_000));
  const now = Date.now();
  const state = stateFor(provider);

  if (state.openedUntil > now) throw circuitOpenError(provider, state.openedUntil);
  if (state.openedUntil && state.openedUntil <= now) {
    state.openedUntil = 0;
    state.failures = 0;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await operation({ attempt: attempt + 1, provider });
      state.failures = 0;
      state.openedUntil = 0;
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) throw error;
      if (attempt >= retries) break;
      await delay(retryDelayMs * (attempt + 1));
    }
  }

  state.failures += 1;
  if (state.failures >= failureThreshold) {
    state.openedUntil = Date.now() + cooldownMs;
  }
  throw lastError;
}

export function aiCircuitStatus(provider) {
  const state = stateFor(provider);
  return { provider, failures: state.failures, openedUntil: state.openedUntil || null };
}

export function resetAiResilience(provider) {
  if (provider) circuits.delete(provider);
  else circuits.clear();
}
