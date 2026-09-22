import { createHash } from 'node:crypto';

const PROMPT_INJECTION = /(?:ignore|disregard|override)\s+(?:previous|system|safety)|reveal\s+(?:the|your)\s+(?:prompt|system message)|send\s+(?:this|an)\s+email\s+now/i;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read-only journey projection; it records evidence and never grants authority. */
export function buildMailJourney({ request, work, draft, review, provider, followUp } = {}) {
  const sourceText = [request?.subject, request?.body].filter(Boolean).join('\n');
  return {
    traceId: String(request?.traceId || digest({ request, work, draft }).slice(0, 32)),
    stages: [
      { name: 'request', status: request ? 'complete' : 'missing', evidence: request?.evidence || [] },
      { name: 'work', status: work ? 'candidate' : 'unassigned', evidence: work?.evidence || [] },
      { name: 'draft', status: draft ? draft.status || 'present' : 'none', evidence: draft?.evidence || [] },
      { name: 'review', status: review?.status || 'pending', evidence: review?.evidence || [] },
      { name: 'provider', status: provider?.status || 'unknown', evidence: provider?.evidence || [] },
      { name: 'follow-up', status: followUp?.status || 'none', evidence: followUp?.evidence || [] },
    ],
    safety: {
      promptInjectionDetected: PROMPT_INJECTION.test(sourceText),
      externalMutationAllowed: false,
    },
    evidenceDigest: digest({ request, work, draft, review, provider, followUp }),
  };
}
