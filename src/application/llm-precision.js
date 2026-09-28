import {
  PRECISION_LLM_PROMPT_VERSION,
  buildPrecisionLlmPrompt,
  parsePrecisionLlmResponse,
} from '../domain/precision-llm.js';

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function failure(message, error) {
  return {
    messageId: String(message?.id || ''),
    code: String(error?.code || 'LLM_PROVIDER_FAILED').slice(0, 80),
    message: String(error?.message || 'LLM provider failed.').slice(0, 300),
  };
}

export async function classifyPrecisionBatch({
  messages = [],
  runProvider,
  provider = 'unknown',
  model = '',
  promptVersion = PRECISION_LLM_PROMPT_VERSION,
  batchSize = 5,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof runProvider !== 'function') throw new Error('runProvider is required.');
  const safeBatch = Number.isInteger(batchSize) && batchSize > 0 ? Math.min(batchSize, 8) : 5;
  const accepted = [];
  const rejected = [];
  for (const batch of chunks(messages.filter((message) => message?.id), safeBatch)) {
    let raw = '';
    let executionModel = model;
    try {
      const execution = await runProvider(buildPrecisionLlmPrompt(batch, { promptVersion }), batch);
      raw = typeof execution === 'string' ? execution : execution?.text;
      executionModel = execution?.model || model;
    } catch (error) {
      rejected.push(...batch.map((message) => failure(message, error)));
      continue;
    }
    const parsed = parsePrecisionLlmResponse(raw, batch);
    accepted.push(...parsed.accepted.map((item) => ({
      ...item,
      provider,
      model: executionModel,
      promptVersion,
    })));
    rejected.push(...parsed.rejected);
  }
  return {
    provider,
    model,
    promptVersion,
    analyzedAt: now(),
    accepted,
    rejected,
  };
}
