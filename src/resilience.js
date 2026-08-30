import { setTimeout as delay } from 'node:timers/promises';

export async function retryOperation(operation, {
  attempts = 2,
  baseDelayMs = 100,
  shouldRetry = () => false,
  sleep = delay,
} = {}) {
  const boundedAttempts = Math.min(Math.max(Number(attempts) || 1, 1), 5);
  let lastError;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= boundedAttempts || !shouldRetry(error)) throw error;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

export function createCircuitBreaker({
  failureThreshold = 3,
  cooldownMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const states = new Map();
  const threshold = Math.max(Number(failureThreshold) || 1, 1);
  const cooldown = Math.max(Number(cooldownMs) || 1, 1);

  function stateFor(key) {
    if (!states.has(key)) states.set(key, { failures: 0, openUntil: 0 });
    return states.get(key);
  }

  return {
    async execute(key, operation) {
      const state = stateFor(key);
      const currentTime = now();
      if (state.openUntil > currentTime) {
        const error = new Error(`Circuit for ${key} is open until ${new Date(state.openUntil).toISOString()}.`);
        error.code = 'CIRCUIT_OPEN';
        error.retryAfterMs = state.openUntil - currentTime;
        throw error;
      }
      if (state.openUntil && state.openUntil <= currentTime) {
        state.openUntil = 0;
        state.failures = 0;
      }

      try {
        const result = await operation();
        state.failures = 0;
        state.openUntil = 0;
        return result;
      } catch (error) {
        state.failures += 1;
        if (state.failures >= threshold) state.openUntil = currentTime + cooldown;
        throw error;
      }
    },

    status(key) {
      const state = stateFor(key);
      return {
        failures: state.failures,
        open: state.openUntil > now(),
        openUntil: state.openUntil || null,
      };
    },

    reset(key) {
      if (key === undefined) states.clear();
      else states.delete(key);
    },
  };
}
