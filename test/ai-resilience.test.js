import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiCircuitStatus,
  resetAiResilience,
  withAiResilience
} from '../src/ai/resilience.js';

test.afterEach(() => resetAiResilience());

test('일시 오류는 한 번 재시도한 뒤 성공할 수 있다', async () => {
  let attempts = 0;
  const result = await withAiResilience('retry-provider', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary failure');
    return 'ok';
  }, { retries: 1, retryDelayMs: 1 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(aiCircuitStatus('retry-provider'), {
    provider: 'retry-provider',
    failures: 0,
    openedUntil: null
  });
});

test('권한 차단 오류는 재시도하지 않는다', async () => {
  let attempts = 0;
  const denied = new Error('disabled');
  denied.code = 'EXTERNAL_ACTION_DISABLED';
  denied.statusCode = 403;

  await assert.rejects(
    withAiResilience('denied-provider', async () => {
      attempts += 1;
      throw denied;
    }, { retries: 5, retryDelayMs: 1 }),
    /disabled/
  );
  assert.equal(attempts, 1);
});

test('연속 실패가 임계값을 넘으면 회로를 열고 다음 호출을 즉시 차단한다', async () => {
  let attempts = 0;
  const operation = async () => {
    attempts += 1;
    throw new Error('provider unavailable');
  };

  await assert.rejects(
    withAiResilience('open-provider', operation, {
      retries: 0,
      failureThreshold: 1,
      cooldownMs: 60_000
    }),
    /provider unavailable/
  );
  const attemptsAfterFailure = attempts;
  await assert.rejects(
    withAiResilience('open-provider', operation, {
      retries: 0,
      failureThreshold: 1,
      cooldownMs: 60_000
    }),
    (error) => error.code === 'AI_CIRCUIT_OPEN'
  );
  assert.equal(attempts, attemptsAfterFailure);
  assert.ok(aiCircuitStatus('open-provider').openedUntil > Date.now());
});
