import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker, retryOperation } from '../src/resilience.js';

test('retryOperation retries a retryable transient failure and returns success', async () => {
  let calls = 0;
  const result = await retryOperation(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('temporary'), { statusCode: 503 });
    return 'ok';
  }, {
    attempts: 2,
    baseDelayMs: 0,
    shouldRetry: (error) => error.statusCode >= 500,
    sleep: async () => {},
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryOperation does not retry a permanent failure', async () => {
  let calls = 0;
  await assert.rejects(
    retryOperation(async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { statusCode: 400 });
    }, {
      attempts: 3,
      shouldRetry: (error) => error.statusCode >= 500,
      sleep: async () => {},
    }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test('circuit opens after threshold and closes after cooldown', async () => {
  let currentTime = 1_000;
  let calls = 0;
  const circuit = createCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 500,
    now: () => currentTime,
  });
  const fail = async () => {
    calls += 1;
    throw new Error('provider down');
  };

  await assert.rejects(circuit.execute('provider', fail), /provider down/);
  await assert.rejects(circuit.execute('provider', fail), /provider down/);
  assert.equal(circuit.status('provider').open, true);
  await assert.rejects(circuit.execute('provider', fail), (error) => error.code === 'CIRCUIT_OPEN');
  assert.equal(calls, 2);

  currentTime += 501;
  const result = await circuit.execute('provider', async () => {
    calls += 1;
    return 'recovered';
  });
  assert.equal(result, 'recovered');
  assert.equal(circuit.status('provider').open, false);
  assert.equal(calls, 3);
});
