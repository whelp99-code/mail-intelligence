// REQ-INT-009 / REQ-INT-011: identity-only diagnostics, never registration or replay.
function uuidValue(value) {
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)) return null;
  return value.toLowerCase().replace(/-/g, '');
}

function validText(value, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0)
    && value.length <= 200 && !/[\r\n\0]/.test(value);
}

export function diagnoseProjectRegistry({ notionProjects, miProjects } = {}) {
  if (!Array.isArray(notionProjects) || !Array.isArray(miProjects)
    || notionProjects.some(p => !p || !validText(p.sourceId) || !validText(p.projectKey, true))
    || miProjects.some(p => !p || !Number.isSafeInteger(p.id) || p.id < 1
      || !validText(p.projectKey) || !['active', 'archived'].includes(p.status))
    || new Set(miProjects.map(p => p.id)).size !== miProjects.length) {
    throw new Error('Invalid project identity projection.');
  }
  const sourceIdentity = p => uuidValue(p.sourceId) || p.sourceId;
  const sourceCounts = new Map();
  const businessKeyCounts = new Map();
  for (const p of notionProjects) {
    const key = sourceIdentity(p);
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
    if (p.projectKey !== '') {
      businessKeyCounts.set(p.projectKey, (businessKeyCounts.get(p.projectKey) || 0) + 1);
    }
  }
  // The local key may be a Notion page UUID or an exact business project key.
  // Name, alias, fuzzy matching, status filtering and inferred identities are forbidden.
  const candidates = notionProjects.map(n => miProjects.filter(m =>
    (uuidValue(n.sourceId) !== null && uuidValue(n.sourceId) === uuidValue(m.projectKey))
    || (n.projectKey !== '' && n.projectKey === m.projectKey)));
  const references = new Map();
  for (const matches of candidates) {
    for (const m of matches) references.set(m.id, (references.get(m.id) || 0) + 1);
  }
  const projects = notionProjects.map((n, i) => {
    const matches = candidates[i];
    const ambiguous = sourceCounts.get(sourceIdentity(n)) > 1
      || businessKeyCounts.get(n.projectKey) > 1 || matches.length > 1
      || matches.some(m => references.get(m.id) > 1);
    return {
      sourceId: n.sourceId, projectKey: n.projectKey,
      status: ambiguous ? 'ambiguous' : matches.length === 0 ? 'missing_in_mi' : 'matched',
      miProjects: matches.map(m => ({ id: m.id, projectKey: m.projectKey, status: m.status })),
    };
  });
  const unmatchedMiProjects = miProjects.filter(m => !references.has(m.id))
    .map(m => ({ id: m.id, projectKey: m.projectKey, status: m.status }));
  return {
    readOnly: true,
    counts: {
      notion: notionProjects.length, mi: miProjects.length,
      matched: projects.filter(p => p.status === 'matched').length,
      missingInMi: projects.filter(p => p.status === 'missing_in_mi').length,
      ambiguous: projects.filter(p => p.status === 'ambiguous').length,
      matchedArchived: projects.filter(p => p.status === 'matched' && p.miProjects[0].status === 'archived').length,
      unmatchedMi: unmatchedMiProjects.length,
    },
    projects, unmatchedMiProjects,
    semantics: 'Only explicit identity projections; exact business key or UUID value. Missing is relative to supplied scope, not proof of operational absence. No registration, sync or classification.',
  };
}
