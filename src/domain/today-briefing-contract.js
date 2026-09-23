export const BRIEFING_MAX_ITEMS = 5;
export const BRIEFING_UNIVERSE = 'all_in_progress_crm_projects';

export const NEXT_ACTION_KINDS = Object.freeze({
  INTERNAL_NEXT_ACTION: 'internal_next_action',
  EXTERNAL_CONFIRMED_COMMITMENT: 'external_confirmed_commitment',
  EXTERNAL_EXPECTED_CONFIRM: 'external_expected_confirm',
});

export const SCORE_SIGNALS = Object.freeze([
  'deadline',
  'slip',
  'external_dep',
  'stall',
  'importance',
  'mail_risk',
]);

export function isInProgressProject(project = {}) {
  const status = String(project.status || '').trim();
  return status === 'in_progress' || status === '진행' || status === 'active';
}

export function collectBriefingUniverse(projects = []) {
  return (projects || []).filter(isInProgressProject);
}

export function classifyNextAction(item = {}) {
  if (item.kind && Object.values(NEXT_ACTION_KINDS).includes(item.kind)) return item.kind;
  if (item.confirmed === true && item.audience === 'external') return NEXT_ACTION_KINDS.EXTERNAL_CONFIRMED_COMMITMENT;
  if (item.expectedConfirmAt && item.audience === 'external') return NEXT_ACTION_KINDS.EXTERNAL_EXPECTED_CONFIRM;
  return NEXT_ACTION_KINDS.INTERNAL_NEXT_ACTION;
}

export function scoreBriefingProject(project, mailRisk = 0) {
  const weights = {
    deadline: Number(project.deadlineScore || 0),
    slip: Number(project.slipScore || 0),
    external_dep: Number(project.externalDepScore || 0),
    stall: Number(project.stallScore || 0),
    importance: Number(project.importanceScore || 0),
    mail_risk: Number(mailRisk || 0),
  };
  const total = SCORE_SIGNALS.reduce((sum, key) => sum + (Number.isFinite(weights[key]) ? weights[key] : 0), 0);
  return { total, weights, nextActionKind: classifyNextAction(project.nextAction || {}) };
}

export function rankTodayBriefing(projects = [], mailRiskByProject = {}, { max = BRIEFING_MAX_ITEMS } = {}) {
  const universe = collectBriefingUniverse(projects);
  const scored = universe.map((project) => {
    const id = project.id || project.externalId;
    return {
      id,
      name: project.name,
      ...scoreBriefingProject(project, mailRiskByProject[id] || 0),
      hasDoNow: Boolean(project.hasDoNow),
      hasNextAction: Boolean(project.nextAction?.text || project.nextAction?.kind),
    };
  });
  scored.sort((left, right) => right.total - left.total || String(left.id).localeCompare(String(right.id)));
  const items = scored.filter((item) => item.total > 0).slice(0, max);
  const selected = new Set(items.map((item) => item.id));
  const excluded = scored
    .filter((item) => !selected.has(item.id))
    .map((item) => ({
      id: item.id,
      name: item.name,
      reason: item.total <= 0 ? 'no_risk_or_deadline_signal' : 'below_top_n',
    }));
  return {
    universe: BRIEFING_UNIVERSE,
    source: 'union_in_progress_plus_mail_risk',
    max,
    items,
    excluded,
  };
}
