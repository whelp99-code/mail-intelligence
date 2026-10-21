import { resolveProject, projectResolutionMetadata, applyPrecisionCorrection } from '../domain/precision-classifier.js';
import { bestLearningPolicy } from '../domain/correction-generalization.js';

const projectFields = ['primaryProjectId', 'projectResolution', 'projectCandidate'];

function evaluateProject(message, projects, previous, correction, policy) {
  const resolved = resolveProject(message, projects);
  const overrides = (correction || policy)?.overrides || {};
  const project = Object.fromEntries(projectFields.map((field) => [field,
    Object.hasOwn(overrides, field) ? overrides[field] : resolved[field]]));
  // A protected projection without its correction/policy provenance cannot be safely replaced.
  const protectedOrphan = previous && ['user-corrected', 'hybrid'].includes(previous.source) && !correction && !policy;
  if (protectedOrphan) {
    for (const field of projectFields) project[field] = previous[field];
  }
  let reviewStatus = previous?.reviewStatus || 'auto';
  if (!['confirmed', 'corrected'].includes(reviewStatus) && project.projectResolution === 'review_required') reviewStatus = 'review_required';
  if (previous && !protectedOrphan) {
    const metadata = projectResolutionMetadata(message, { ...resolved, ...project }, previous.workState);
    const projectOverrides = Object.fromEntries(projectFields.filter((field) => Object.hasOwn(overrides, field))
      .map((field) => [field, overrides[field]]));
    if (Object.keys(projectOverrides).length) {
      // Reuse correction evidence construction, but never apply its non-project fields to storage.
      const corrected = applyPrecisionCorrection(previous, {
        ...(correction || policy), overrides: projectOverrides,
        reasonCode: correction ? correction.reasonCode : policy.reasonCode || 'learned-correction',
        note: correction ? correction.note : policy.note || '유사 메일 보정',
      });
      metadata.evidence = corrected.evidence?.project ?? null;
      metadata.confidence = corrected.confidence?.project ?? 0;
    }
    return { ...project, reviewStatus, projectEvidence: metadata.evidence,
      projectConfidence: metadata.confidence, projectReviewReasons: metadata.reviewReasons };
  }
  return { ...project, reviewStatus };
}

export function projectReclassificationCount(db, mailboxId) {
  return db.prepare('SELECT count(*) AS count FROM messages WHERE mailbox_id = ? AND deleted_at IS NULL')
    .get(mailboxId).count;
}

export function reclassifyProjectAnalysis(store, mailbox, expectedCount) {
  return store.transaction(() => {
    const count = projectReclassificationCount(store.db, mailbox.id);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || count !== expectedCount) {
      throw Object.assign(new Error('Reclassification denominator changed.'), { code: 'RECLASSIFICATION_COUNT_DRIFT' });
    }
    const projects = store.listProjects(mailbox.id);
    const policies = store.listLearningPolicies(mailbox.id);
    const result = { target: count, processed: 0, changed: 0, unchanged: 0,
      confirmed: 0, review_required: 0, candidate: 0, unassigned: 0 };
    for (let offset = 0; offset < count; offset += 250) {
      const messages = store.getMessagePage(mailbox.id, { limit: 250, offset });
      for (const message of messages) {
        const previous = store.getPrecisionClassification(mailbox.id, message.id);
        const correction = store.getPrecisionCorrection(mailbox.id, message.id);
        const policy = correction ? null : bestLearningPolicy(message, policies);
        const project = evaluateProject(message, projects, previous, correction, policy);
        if (store.updatePrecisionProjectResolution(mailbox.id, message.id, project)) result.changed += 1;
        else result.unchanged += 1;
        result[project.projectResolution] += 1;
        result.processed += 1;
      }
    }
    if (result.processed !== count || projectReclassificationCount(store.db, mailbox.id) !== count) {
      throw Object.assign(new Error('Reclassification denominator changed.'), { code: 'RECLASSIFICATION_COUNT_DRIFT' });
    }
    return result;
  });
}
