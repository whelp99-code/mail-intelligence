export const WORKLINK_CANDIDATE_SOURCE = 'notion-worklink';
export const WORKLINK_PROJECTION_PROVIDER = 'notion-worklink';
export const WORKLINK_PROJECTION_VERSION = 'worklink-projection-v1';

export function isWorkLinkDerivedClassification(classification) {
  if (!classification) return false;
  const candidate = classification.projectCandidate || {};
  return classification.provider === WORKLINK_PROJECTION_PROVIDER
    || classification.promptVersion === WORKLINK_PROJECTION_VERSION
    || candidate.source === WORKLINK_CANDIDATE_SOURCE;
}

export function isProtectedWorkLinkProjection(classification) {
  if (!classification) return false;
  if (classification.source === 'user-corrected') return true;
  if (classification.reviewStatus === 'confirmed' || classification.reviewStatus === 'corrected') return true;
  if (classification.projectResolution === 'confirmed') return true;
  if (!isWorkLinkDerivedClassification(classification) && classification.projectResolution !== 'unassigned') {
    return true;
  }
  return false;
}

export function workLinkCandidateProjection(link, revision = null) {
  if (!link) {
    return {
      source: WORKLINK_CANDIDATE_SOURCE,
      cleared: true,
      revision: revision || null,
    };
  }
  return {
    label: link.name,
    system: link.system,
    externalId: link.externalId,
    objectType: link.objectType,
    source: WORKLINK_CANDIDATE_SOURCE,
    confidence: link.confidence,
    revision: revision || null,
  };
}

export function classificationWritePayload(current, overrides = {}) {
  return {
    workState: current.workState,
    nextActor: current.nextActor,
    priority: current.priority,
    dueText: current.dueText || '',
    dueAt: current.dueAt || null,
    duePrecision: current.duePrecision || 'none',
    primaryProjectId: current.primaryProjectId || null,
    projectResolution: current.projectResolution,
    projectCandidate: current.projectCandidate || {},
    signals: current.signals || [],
    evidence: current.evidence || {},
    confidence: current.confidence || {},
    reviewReasons: current.reviewReasons || [],
    source: current.source || 'rules',
    provider: current.provider || 'rules',
    model: current.model || '',
    promptVersion: current.promptVersion || '',
    reviewStatus: current.reviewStatus || 'auto',
    analyzedAt: current.analyzedAt,
    correctedAt: current.correctedAt || null,
    ...overrides,
  };
}

export function workLinkProjectionAgreement(messages, links, classifications) {
  const linksByGraphId = new Map();
  for (const link of links) {
    if (link.status !== 'candidate') continue;
    const existing = linksByGraphId.get(link.graphId) || [];
    existing.push(link);
    linksByGraphId.set(link.graphId, existing);
  }
  const disagreements = [];
  for (const message of messages) {
    const graphId = message.id || message.graphId;
    const cls = classifications[graphId] || null;
    if (isProtectedWorkLinkProjection(cls)) continue;
    const messageLinks = linksByGraphId.get(graphId) || [];
    const expectedId = messageLinks[0]?.externalId || null;
    const actualId = cls?.projectCandidate?.externalId || null;
    if (expectedId) {
      if (!cls || cls.projectResolution !== 'candidate' || actualId !== expectedId) {
        disagreements.push({ graphId, expectedId, actualId, projectResolution: cls?.projectResolution || null });
      }
    } else if (cls && isWorkLinkDerivedClassification(cls) && (cls.projectResolution !== 'unassigned' || actualId)) {
      disagreements.push({
        graphId,
        expectedId: null,
        actualId,
        projectResolution: cls.projectResolution,
      });
    }
  }
  return {
    ok: disagreements.length === 0,
    disagreements,
    linkedCandidate: linksByGraphId.size,
  };
}
