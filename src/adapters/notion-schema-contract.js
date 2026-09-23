import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const CONFIDENCE_SELECT = Object.freeze(['높음', '보통', '낮음']);
export const REVIEW_SELECT = Object.freeze(['검증완료', '연결검토', '제외']);
export const EVIDENCE_TIER_SELECT = Object.freeze(['확인된 사실', 'AI 추론', '사용자 제안', '가정', '기각', '이전 버전']);

export const ACTIVITY_PROPERTY_MAP = Object.freeze({
  evidencePointer: '출처 ID/경로',
  evidenceTier: '근거등급',
  confidenceDisplay: '확신도',
  reviewStatus: '검토상태',
  naturalKey: '자연키',
});

export const ACTIVITY_PROPERTY_TYPES = Object.freeze({
  evidencePointer: 'rich_text',
  evidenceTier: 'select',
  confidenceDisplay: 'select',
  reviewStatus: 'select',
  naturalKey: 'rich_text',
});

const REVIEW_DISPLAY_ALIASES = Object.freeze({
  confirmed: '검증완료',
  rejected: '제외',
  검증완료: '검증완료',
  제외: '제외',
  연결검토: '연결검토',
});

function allowedSelectOptions(property, contractValues) {
  const options = Array.isArray(property?.options) ? property.options : [];
  return contractValues.filter((value) => options.includes(value));
}

function resolveReviewDisplay(status) {
  if (typeof status !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(REVIEW_DISPLAY_ALIASES, status)
    ? REVIEW_DISPLAY_ALIASES[status]
    : null;
}

export function loadDeidentifiedSchema(schemaOrPath) {
  let schema;
  if (schemaOrPath && typeof schemaOrPath === 'object' && !Array.isArray(schemaOrPath)) {
    schema = schemaOrPath;
  } else {
    const path = String(schemaOrPath || '').trim();
    const absolute = isAbsolute(path) ? path : resolve(path);
    schema = JSON.parse(readFileSync(absolute, 'utf8'));
  }
  const identity = validateSchemaIdentity(schema);
  if (!identity.ok) {
    throw Object.assign(new Error(identity.message), { code: identity.code });
  }
  return schema;
}

export function schemaHash(schema) {
  const canonical = JSON.stringify({
    logicalDatabase: schema.logicalDatabase,
    properties: (schema.properties || []).map((item) => ({
      name: item.name,
      type: item.type,
      options: item.options || [],
    })),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function displayConfidence(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return '낮음';
  if (numeric >= 0.8) return '높음';
  if (numeric >= 0.5) return '보통';
  return '낮음';
}

export function displayReviewStatus(status) {
  if (status === 'confirmed' || status === '검증완료') return '검증완료';
  if (status === 'rejected' || status === '제외') return '제외';
  return '연결검토';
}

export function validateSchemaIdentity(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, code: 'SCHEMA_MISSING', message: 'De-identified schema fixture is missing.' };
  }
  const captured = String(schema.capturedAt || schema.captured_at || '').trim();
  if (!captured || Number.isNaN(Date.parse(captured))) {
    return {
      ok: false,
      code: 'SCHEMA_CAPTURED_AT_MISSING',
      message: 'De-identified schema fixture requires capturedAt.',
    };
  }
  const expected = schemaHash(schema);
  const provided = String(schema.schemaHash || '').trim();
  if (!provided) {
    return {
      ok: false,
      code: 'SCHEMA_HASH_MISSING',
      message: 'De-identified schema fixture requires schemaHash.',
    };
  }
  if (provided !== expected) {
    return {
      ok: false,
      code: 'SCHEMA_HASH_MISMATCH',
      message: 'De-identified schema hash does not match the logical properties.',
    };
  }
  return {
    ok: true,
    schemaHash: expected,
    capturedAt: captured,
    workspaceId: schema.workspaceId || null,
  };
}

export function validateSchemaAccess(schema, { permission = 'read' } = {}) {
  if (permission !== 'read' && permission !== 'schema_read') {
    return {
      ok: false,
      code: 'INSUFFICIENT_READ_PERMISSION',
      message: 'Phase 1B requires read permission on the logical Activity schema.',
    };
  }
  if (!schema || !Array.isArray(schema.properties) || !schema.properties.length) {
    return { ok: false, code: 'SCHEMA_MISSING', message: 'De-identified schema fixture is missing properties.' };
  }
  const identity = validateSchemaIdentity(schema);
  if (!identity.ok) return identity;
  return { ok: true };
}

export function validateActivityProposal(schema, proposal = {}) {
  const access = validateSchemaAccess(schema, { permission: proposal.permission || 'read' });
  if (!access.ok) return access;

  const byName = new Map((schema.properties || []).map((item) => [item.name, item]));
  const errors = [];

  for (const [logicalKey, logical] of Object.entries(ACTIVITY_PROPERTY_MAP)) {
    if (!byName.has(logical) && !proposal.allowMissingLogical) {
      errors.push({ code: 'RENAMED_PROPERTY', property: logical });
    }
    const property = byName.get(logical);
    const expectedType = ACTIVITY_PROPERTY_TYPES[logicalKey];
    if (property && expectedType && property.type !== expectedType) {
      errors.push({
        code: expectedType === 'select' ? 'SELECT_TYPE_MISMATCH' : 'FIELD_TYPE_MISMATCH',
        property: logical,
        expected: expectedType,
        actual: property.type,
      });
    }
  }

  const confidenceProperty = byName.get(ACTIVITY_PROPERTY_MAP.confidenceDisplay);
  if (confidenceProperty?.type === 'select') {
    const allowed = allowedSelectOptions(confidenceProperty, CONFIDENCE_SELECT);
    if (proposal.confidenceDisplay != null && !allowed.includes(proposal.confidenceDisplay)) {
      errors.push({
        code: 'SELECT_TYPE_MISMATCH',
        property: ACTIVITY_PROPERTY_MAP.confidenceDisplay,
        value: proposal.confidenceDisplay,
      });
    }
    if (typeof proposal.confidence === 'number') {
      const display = displayConfidence(proposal.confidence);
      if (!allowed.includes(display)) {
        errors.push({ code: 'SELECT_TYPE_MISMATCH', property: ACTIVITY_PROPERTY_MAP.confidenceDisplay, value: display });
      }
      if (proposal.confidenceDisplay && proposal.confidenceDisplay !== display) {
        errors.push({ code: 'SELECT_TYPE_MISMATCH', property: ACTIVITY_PROPERTY_MAP.confidenceDisplay, value: proposal.confidenceDisplay });
      }
    }
  }

  const reviewProperty = byName.get(ACTIVITY_PROPERTY_MAP.reviewStatus);
  if (reviewProperty?.type === 'select' && proposal.reviewStatus != null) {
    const display = resolveReviewDisplay(proposal.reviewStatus);
    const allowed = allowedSelectOptions(reviewProperty, REVIEW_SELECT);
    if (display == null || !allowed.includes(display)) {
      errors.push({ code: 'SELECT_TYPE_MISMATCH', property: ACTIVITY_PROPERTY_MAP.reviewStatus, value: proposal.reviewStatus });
    }
  }

  const evidenceProperty = byName.get(ACTIVITY_PROPERTY_MAP.evidenceTier);
  if (evidenceProperty?.type === 'select' && proposal.evidenceTier != null) {
    const allowed = allowedSelectOptions(evidenceProperty, EVIDENCE_TIER_SELECT);
    if (typeof proposal.evidenceTier !== 'string' || !allowed.includes(proposal.evidenceTier)) {
      errors.push({
        code: 'SELECT_TYPE_MISMATCH',
        property: ACTIVITY_PROPERTY_MAP.evidenceTier,
        value: proposal.evidenceTier,
      });
    }
  }

  if (proposal.evidencePointer != null && typeof proposal.evidencePointer !== 'string') {
    errors.push({
      code: 'FIELD_TYPE_MISMATCH',
      property: ACTIVITY_PROPERTY_MAP.evidencePointer,
      expected: 'rich_text',
      value: proposal.evidencePointer,
    });
  }
  if (proposal.naturalKey != null && typeof proposal.naturalKey !== 'string') {
    errors.push({
      code: 'FIELD_TYPE_MISMATCH',
      property: ACTIVITY_PROPERTY_MAP.naturalKey,
      expected: 'rich_text',
      value: proposal.naturalKey,
    });
  }

  const relationNames = ['프로젝트', '고객·파트너'];
  for (const name of relationNames) {
    const property = byName.get(name);
    const value = proposal.relations?.[name];
    if (!property || value == null) continue;
    if (property.type !== 'relation') {
      errors.push({ code: 'BAD_RELATION', property: name });
      continue;
    }
    const ids = Array.isArray(value) ? value : [value];
    const known = new Set(proposal.knownRelationIds || []);
    if (ids.some((id) => !known.has(id))) {
      errors.push({ code: 'BAD_RELATION', property: name, value: ids });
    }
  }

  if (proposal.naturalKey && Array.isArray(proposal.existingNaturalKeys) && proposal.existingNaturalKeys.includes(proposal.naturalKey)) {
    errors.push({ code: 'NATURAL_KEY_DUPLICATE', property: ACTIVITY_PROPERTY_MAP.naturalKey, value: proposal.naturalKey });
  }

  if (proposal.properties) {
    for (const name of Object.keys(proposal.properties)) {
      if (!byName.has(name)) errors.push({ code: 'RENAMED_PROPERTY', property: name });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    confidenceDisplay: typeof proposal.confidence === 'number' ? displayConfidence(proposal.confidence) : proposal.confidenceDisplay || null,
    rawConfidenceStoredAt: ['work_links.confidence', 'precision_classifications.project_candidate_json.confidence'],
  };
}
