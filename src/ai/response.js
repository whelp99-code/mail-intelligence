const VALID_STATUSES = new Set(['urgent', 'active', 'waiting', 'done', 'reference']);

export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI response was empty.');
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain a JSON object.');
    return JSON.parse(match[0]);
  }
}

export function normalizeAiStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['urgent', '긴급'].includes(value)) return 'urgent';
  if (['waiting', '대기'].includes(value)) return 'waiting';
  if (['done', 'complete', 'completed', '완료'].includes(value)) return 'done';
  if (['reference', '참고', 'none', 'no-action'].includes(value)) return 'reference';
  return 'active';
}

function strings(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, max);
}

function normalizeAction(action = {}) {
  const lane = normalizeAiStatus(action.lane || action.status);
  return {
    recommendedAction: String(action.recommendedAction || action.action || '').trim(),
    owner: String(action.owner || '미지정').trim() || '미지정',
    due: String(action.due || '').trim(),
    priority: Math.min(Math.max(Number(action.priority || (lane === 'urgent' ? 1 : 4)), 1), 6),
    lane: lane === 'reference' ? 'active' : lane,
    evidence: String(action.evidence || '').trim(),
    intent: String(action.intent || '').trim(),
    to: String(action.to || '').trim(),
    subject: String(action.subject || '').trim(),
    body: String(action.body || '').trim()
  };
}

export function parseAiResponse(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    throw new Error('AI response schema invalid: messages must be an array.');
  }

  const messages = parsed.messages.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`AI response schema invalid: messages[${index}] must be an object.`);
    }
    const id = String(item.id || '').trim();
    if (!id) throw new Error(`AI response schema invalid: messages[${index}].id is required.`);
    const status = normalizeAiStatus(item.status);
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`AI response schema invalid: messages[${index}].status is invalid.`);
    }
    return {
      id,
      status,
      summary: strings(item.summary, 4),
      nextActions: Array.isArray(item.nextActions) ? item.nextActions.slice(0, 2).map(normalizeAction) : [],
      evidenceItems: strings(item.evidenceItems, 6),
      aiRationale: String(item.aiRationale || '').trim()
    };
  });

  return { messages };
}
