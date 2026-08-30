export const AI_PROMPT_VERSION = 'mail-intelligence-email-analysis-v1.0.1';

// Compatibility name used by the server and persisted analysis records.
// Keep it tied to the prompt contract so cache entries are invalidated when
// the AI schema or prompt changes.
export const AI_PIPELINE_VERSION = AI_PROMPT_VERSION;
export const MAX_AI_RESPONSE_BYTES = 512 * 1024;

const STATUSES = new Set(['urgent', 'active', 'waiting', 'done', 'reference']);
const ACTION_TYPES = new Set([
  'draft_reply',
  'request_info',
  'share_document',
  'review',
  'archive',
  'monitor',
  'create_task',
]);

function text(value, max = 1000) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function multiline(value, max = 6000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requiredStringArray(value, field, minItems, maxItems, maxLength) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length < minItems || value.length > maxItems) {
    throw new Error(`${field} must contain ${minItems}-${maxItems} items.`);
  }
  const normalized = value.map((item) => text(item, maxLength));
  if (normalized.some((item) => !item)) throw new Error(`${field} must contain only non-empty strings.`);
  return normalized;
}

function requiredConfidence(value, messageId) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`AI message ${messageId} confidence must be a number between 0 and 1.`);
  }
  return value;
}

function strictStatus(value, field = 'status') {
  const status = String(value || '').trim().toLowerCase();
  if (!STATUSES.has(status)) throw new Error(`${field} must be one of urgent, active, waiting, done, reference.`);
  return status;
}

export function extractJsonObject(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('AI response is empty.');
  if (new TextEncoder().encode(raw).byteLength > MAX_AI_RESPONSE_BYTES) {
    throw new Error(`AI response exceeds ${MAX_AI_RESPONSE_BYTES} bytes.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) throw new Error('AI response did not contain a JSON object.');
    return JSON.parse(raw.slice(first, last + 1));
  }
}

export function normalizeAiStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['urgent', '긴급'].includes(status)) return 'urgent';
  if (['waiting', '대기'].includes(status)) return 'waiting';
  if (['done', 'complete', 'completed', '완료'].includes(status)) return 'done';
  if (['reference', '참고', 'none', 'no_action', 'no-action'].includes(status)) return 'reference';
  return 'active';
}

function normalizeAction(action, index, messageId) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error(`AI message ${messageId} action at index ${index} must be an object.`);
  }
  const actionType = String(action.actionType || '').trim();
  if (!ACTION_TYPES.has(actionType)) {
    throw new Error(`AI message ${messageId} action at index ${index} has an unsupported actionType.`);
  }
  const recommendedAction = text(action.recommendedAction, 600);
  if (!recommendedAction) {
    throw new Error(`AI message ${messageId} action at index ${index} requires recommendedAction.`);
  }
  const lane = strictStatus(action.lane, `AI message ${messageId} action lane`);
  if (!['urgent', 'active', 'waiting'].includes(lane)) {
    throw new Error(`AI message ${messageId} action lane must be urgent, active, or waiting.`);
  }
  const priority = Number(action.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) {
    throw new Error(`AI message ${messageId} action priority must be an integer between 1 and 9.`);
  }
  const evidence = text(action.evidence, 1200);
  if (!evidence) {
    throw new Error(`AI message ${messageId} action at index ${index} requires source evidence.`);
  }
  return {
    id: text(action.id, 200) || `ai-action-${index + 1}`,
    actionType,
    title: text(action.title, 180),
    recommendedAction,
    owner: text(action.owner, 160) || '미지정',
    due: text(action.due, 160),
    priority,
    lane,
    evidence,
    intent: text(action.intent, 600),
    to: text(action.to, 320),
    subject: text(action.subject, 500),
    body: multiline(action.body, 6000),
  };
}

export function validateAiPayload(payload, allowedMessageIds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('AI response root must be an object.');
  }
  if (!Array.isArray(payload.messages)) {
    throw new Error('AI response must contain a messages array.');
  }

  const allowed = new Set(allowedMessageIds.map(String));
  const seen = new Set();
  const messages = payload.messages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`AI message at index ${index} must be an object.`);
    }
    const id = text(item.id, 500);
    if (!allowed.has(id)) throw new Error(`AI response referenced an unknown message id: ${id || '(empty)'}.`);
    if (seen.has(id)) throw new Error(`AI response contained duplicate message id: ${id}.`);
    seen.add(id);

    const status = strictStatus(item.status, `AI message ${id} status`);
    const summary = requiredStringArray(item.summary, `AI message ${id} summary`, 1, 4, 400);
    const evidenceItems = requiredStringArray(item.evidenceItems, `AI message ${id} evidenceItems`, 1, 6, 1200);
    const confidence = requiredConfidence(item.confidence, id);
    if (!Array.isArray(item.nextActions)) {
      throw new Error(`AI message ${id} nextActions must be an array.`);
    }
    if (item.nextActions.length > 3) {
      throw new Error(`AI message ${id} nextActions must contain at most 3 items.`);
    }
    if (['done', 'reference'].includes(status) && item.nextActions.length !== 0) {
      throw new Error(`AI message ${id} with status ${status} must not include next actions.`);
    }
    if (['urgent', 'active', 'waiting'].includes(status) && item.nextActions.length < 1) {
      throw new Error(`AI message ${id} with status ${status} requires at least one next action.`);
    }
    const nextActions = item.nextActions.map((action, actionIndex) => normalizeAction(action, actionIndex, id));

    return {
      id,
      status,
      summary,
      nextActions,
      evidenceItems,
      aiRationale: text(item.aiRationale, 1200),
      confidence,
    };
  });

  const missingIds = [...allowed].filter((id) => !seen.has(id));
  if (missingIds.length) {
    throw new Error(`AI response omitted message ids: ${missingIds.join(', ')}.`);
  }
  return { messages };
}

export function parseAndValidateAiResponse(raw, allowedMessageIds) {
  return validateAiPayload(extractJsonObject(raw), allowedMessageIds);
}

export function analysisIdentity(provider, model) {
  return `${String(provider || 'rules')}:${String(model || 'unknown')}:${AI_PROMPT_VERSION}`;
}

export function providerModel(provider, config = {}) {
  const selected = String(provider || 'rules').trim().toLowerCase();
  if (selected === 'rules') return 'rules';
  if (selected === 'gemini') return text(config.geminiModel, 200) || 'gemini-2.5-flash';
  if (selected === 'lmstudio' || selected === 'f-aios-v3') {
    return text(config.lmstudioModel, 200) || 'qwen/qwen3.5-9b';
  }
  return 'unknown';
}

export function buildAnalysisCacheKey({
  message = {},
  provider = 'rules',
  model = 'rules',
  pipelineVersion = AI_PIPELINE_VERSION,
} = {}) {
  const revision = message.changeKey || message.receivedAt || '';
  return [
    text(message.id, 1000),
    text(revision, 1000),
    text(provider, 200) || 'rules',
    text(model, 300) || 'unknown',
    text(pipelineVersion, 200) || AI_PIPELINE_VERSION,
  ].join('::');
}

export function parseAiAnalysis(raw, {
  expectedMessageIds = [],
  sourceTextById = {},
} = {}) {
  const parsed = parseAndValidateAiResponse(raw, expectedMessageIds.map(String));
  return {
    messages: parsed.messages.map((message) => {
      const source = String(sourceTextById?.[message.id] || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const citedEvidence = [
        ...message.evidenceItems,
        ...message.nextActions.map((action) => action.evidence),
      ];
      const unsupportedEvidence = citedEvidence.filter((item) => {
        const normalized = String(item || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return !normalized || !source.includes(normalized);
      });
      if (unsupportedEvidence.length) {
        throw new Error(`AI message ${message.id} cited evidence that was not found in the source mail.`);
      }
      return { ...message, evidenceVerified: true };
    }),
  };
}

export function failedAiRun(error, {
  provider = 'unknown',
  model = 'unknown',
  attempts = [],
} = {}) {
  return {
    enabled: false,
    status: 'failed',
    provider: text(provider, 200) || 'unknown',
    model: text(model, 300) || 'unknown',
    pipelineVersion: AI_PIPELINE_VERSION,
    code: text(error?.code, 160) || 'AI_ANALYSIS_FAILED',
    error: text(error instanceof Error ? error.message : error, 500) || 'AI analysis failed.',
    attempts: Array.isArray(attempts) ? attempts.slice(0, 8) : [],
    fallbackFrom: null,
  };
}

export async function executeAiProvider({
  requestedProvider,
  prompt,
  allowedMessageIds,
  callProvider,
  getModelName,
}) {
  if (typeof callProvider !== 'function') throw new Error('callProvider is required.');
  if (typeof getModelName !== 'function') throw new Error('getModelName is required.');
  const requested = String(requestedProvider || '').trim();
  if (!['f-aios-v3', 'lmstudio', 'gemini'].includes(requested)) {
    throw new Error(`Unsupported AI provider: ${requested || '(empty)'}.`);
  }

  let actualProvider = requested;
  let fallbackFrom = null;
  let raw;
  try {
    raw = await callProvider(requested, prompt);
  } catch (error) {
    if (requested !== 'f-aios-v3') throw error;
    actualProvider = 'lmstudio';
    fallbackFrom = requested;
    try {
      raw = await callProvider(actualProvider, prompt);
    } catch (fallbackError) {
      throw new Error(
        `AI analysis failed for ${requested}: ${error instanceof Error ? error.message : String(error)}. ` +
        `LM Studio fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }

  const payload = parseAndValidateAiResponse(raw, allowedMessageIds);
  return {
    payload,
    requestedProvider: requested,
    actualProvider,
    fallbackFrom,
    model: getModelName(actualProvider),
  };
}
