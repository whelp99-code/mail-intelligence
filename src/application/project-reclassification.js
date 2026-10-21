import { PrecisionIntelligenceService } from './precision-intelligence.js';

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
    const service = new PrecisionIntelligenceService({ store });
    const result = { target: count, processed: 0, changed: 0, unchanged: 0,
      confirmed: 0, review_required: 0, candidate: 0, unassigned: 0 };
    for (let offset = 0; offset < count; offset += 250) {
      const messages = store.getMessagePage(mailbox.id, { limit: 250, offset });
      for (const message of messages) {
        const evaluated = service.evaluateOne(mailbox, message, { refreshProjects: true });
        if (!evaluated.previous || evaluated.previous.fingerprint !== evaluated.classification.fingerprint) {
          store.savePrecisionClassification(mailbox.id, message.id, evaluated.classification);
          result.changed += 1;
        } else result.unchanged += 1;
        result[evaluated.classification.projectResolution] += 1;
        result.processed += 1;
      }
    }
    if (result.processed !== count || projectReclassificationCount(store.db, mailbox.id) !== count) {
      throw Object.assign(new Error('Reclassification denominator changed.'), { code: 'RECLASSIFICATION_COUNT_DRIFT' });
    }
    return result;
  });
}
