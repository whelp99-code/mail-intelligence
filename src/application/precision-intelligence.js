import {
  applyLearnedPolicy,
  bestLearningPolicy,
  feedbackStatusForOverrides,
  policyFromCorrection,
  policyMatches,
  subjectTokens,
  MAX_GENERALIZED_MESSAGES,
} from '../domain/correction-generalization.js';
import {
  labelLlmFailure,
  mergeLlmClassification,
} from '../domain/precision-llm.js';
import {
  applyPrecisionCorrection,
  classifyMessage,
  normalizePrecisionCorrection,
  precisionSummary as summarizeClassifications,
} from '../domain/precision-classifier.js';
import {
  explainIntelligentMatch,
  intelligentSmartViews,
  parseIntelligentQuery,
} from '../domain/intelligent-search.js';
import { evaluateSemanticSearchResults } from '../domain/search-semantic-ranker.js';

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function llmCacheKey(message = {}, meta = {}) {
  return [
    String(message.id || ''),
    String(message.changeKey || message.receivedAt || ''),
    String(meta.provider || 'llm'),
    String(meta.model || ''),
    String(meta.promptVersion || 'precision-llm'),
  ].join('::');
}

function boundedLimit(value, fallback = 250, max = 1000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function validatedSearchDecision(decision, results) {
  const hasResults = Array.isArray(results) && results.length > 0;
  if (!decision
    || decision.answerable !== hasResults
    || decision.abstained !== !hasResults
    || !['direct_result', 'no_safe_result'].includes(decision.reason)
    || (hasResults && decision.reason !== 'direct_result')
    || (!hasResults && decision.reason !== 'no_safe_result')) {
    throw new Error('Invalid semantic search decision.');
  }
  return decision;
}

export class PrecisionIntelligenceService {
  constructor({ store, now = () => new Date() }) {
    if (!store) throw new Error('store is required.');
    this.store = store;
    this.now = now;
  }

  ensureMailbox(mailboxUser = '') {
    const key = mailboxKey(mailboxUser);
    return this.store.ensureMailbox({
      key,
      address: mailboxUser,
      graphUser: mailboxUser,
    });
  }

  listProjects(mailboxUser = '', options = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.listProjects(mailbox.id, options);
  }

  createProject(mailboxUser = '', project = {}, { reclassify = true } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const created = this.store.createProject(mailbox.id, project);
    const classification = reclassify
      ? this.classifyStored(mailboxUser, { force: true })
      : { processed: 0, changed: 0, reviewRequired: 0 };
    return { project: created, reclassification: classification };
  }

  classifyOne(mailboxUser = '', messageOrId, options = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const message = typeof messageOrId === 'string'
      ? this.store.getMessage(mailbox.id, messageOrId)
      : messageOrId;
    if (!message?.id) throw new Error('Precision classification requires a stored message.');
    const projects = this.store.listProjects(mailbox.id);
    const mailboxAddresses = this.store.getMailboxSenderAliases(mailbox.id);
    const previous = this.store.getPrecisionClassification(mailbox.id, message.id);
    const keepAi = previous?.source === 'ai'
      && previous.provider
      && previous.provider !== 'rules'
      && options.replaceAi !== true;
    const automatic = keepAi
      ? previous
      : classifyMessage(message, {
        projects,
        mailboxAddress: mailbox.address || mailboxUser,
        mailboxAddresses,
        now: options.now || this.now(),
        source: options.source || 'rules',
        provider: options.provider || 'rules',
        model: options.model || '',
        promptVersion: options.promptVersion,
      });
    const correction = this.store.getPrecisionCorrection(mailbox.id, message.id);
    const learnedPolicy = correction ? null : this.matchingPolicy(mailbox.id, message);
    const finalClassification = correction
      ? applyPrecisionCorrection(automatic, correction)
      : learnedPolicy
        ? applyLearnedPolicy(automatic, learnedPolicy)
        : automatic;
    const saved = this.store.savePrecisionClassification(mailbox.id, message.id, finalClassification);
    return {
      classification: saved,
      automatic,
      correction,
      changed: !previous || previous.fingerprint !== saved.fingerprint,
    };
  }

  classifyMessages(mailboxUser = '', messages = [], options = {}) {
    let changed = 0;
    let reviewRequired = 0;
    const results = [];
    for (const message of messages) {
      const result = this.classifyOne(mailboxUser, message, options);
      results.push(result.classification);
      if (result.changed) changed += 1;
      if (result.classification.reviewStatus === 'review_required') reviewRequired += 1;
    }
    return {
      processed: results.length,
      changed,
      reviewRequired,
      classifications: results,
    };
  }

  classifyStored(mailboxUser = '', {
    force = false,
    batchSize = 250,
    maxMessages = 50_000,
  } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const safeBatch = boundedLimit(batchSize, 250, 1000);
    const safeMax = boundedLimit(maxMessages, 50_000, 100_000);
    let processed = 0;
    let changed = 0;
    let reviewRequired = 0;
    let offset = 0;

    while (processed < safeMax) {
      const remaining = Math.min(safeBatch, safeMax - processed);
      const messages = force
        ? this.store.getMessagePage(mailbox.id, { limit: remaining, offset })
        : this.store.getMessagesNeedingPrecision(mailbox.id, { limit: remaining });
      if (!messages.length) break;
      const batch = this.classifyMessages(mailboxUser, messages);
      processed += batch.processed;
      changed += batch.changed;
      reviewRequired += batch.reviewRequired;
      if (force) offset += messages.length;
      if (messages.length < remaining) break;
    }

    const walCheckpoint = typeof this.store.checkpointWal === 'function'
      ? this.store.checkpointWal('TRUNCATE')
      : null;

    return {
      processed,
      changed,
      reviewRequired,
      truncated: processed >= safeMax,
      walCheckpoint,
    };
  }

  getClassification(mailboxUser = '', messageId) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const current = this.store.getPrecisionClassification(mailbox.id, messageId);
    if (current) {
      return {
        classification: current,
        correction: this.store.getPrecisionCorrection(mailbox.id, messageId),
        events: this.store.getPrecisionEvents(mailbox.id, messageId),
      };
    }
    const result = this.classifyOne(mailboxUser, messageId);
    return {
      classification: result.classification,
      correction: result.correction,
      events: this.store.getPrecisionEvents(mailbox.id, messageId),
    };
  }

  correct(mailboxUser = '', messageId, input = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const correction = normalizePrecisionCorrection(input);
    if (correction.overrides.primaryProjectId != null) {
      const project = this.store.getProject(mailbox.id, correction.overrides.primaryProjectId);
      if (!project || project.status !== 'active') {
        throw new Error('Precision correction project must reference an active project in the same mailbox.');
      }
      correction.overrides.projectResolution = 'confirmed';
      correction.overrides.projectCandidate = {
        projectId: project.id,
        projectKey: project.projectKey,
        name: project.name,
        source: 'user-correction',
        confidence: 1,
      };
    }
    const savedCorrection = this.store.savePrecisionCorrection(mailbox.id, messageId, correction);
    const message = this.store.getMessage(mailbox.id, messageId);
    const feedback = this.recordCorrectionFeedback(mailbox.id, message, savedCorrection);
    const policyInput = message ? policyFromCorrection(message, savedCorrection) : null;
    const policy = policyInput ? this.store.saveLearningPolicy(mailbox.id, policyInput) : null;
    const generalized = policy && message
      ? this.applyPolicyToSimilar(mailboxUser, mailbox.id, message, policy)
      : { applied: [], skippedExplicit: [], truncated: false };
    const result = this.classifyOne(mailboxUser, messageId);
    return {
      correction: savedCorrection,
      classification: result.classification,
      events: this.store.getPrecisionEvents(mailbox.id, messageId),
      feedback,
      learningPolicy: policy,
      generalized,
    };
  }

  matchingPolicy(mailboxId, message) {
    return bestLearningPolicy(message, this.store.listLearningPolicies(mailboxId));
  }

  recordCorrectionFeedback(mailboxId, message, correction) {
    if (!message?.id) return null;
    const userStatus = feedbackStatusForOverrides(correction?.overrides || {});
    if (!userStatus) return null;
    return this.store.saveFeedback(mailboxId, message.id, {
      userStatus,
      reasonCode: correction.reasonCode || userStatus,
      reasonLabel: correction.note || correction.reasonCode || userStatus,
      note: correction.note || '',
      sender: message.from || '',
      subject: message.subject || '',
      subjectTokens: subjectTokens(message.subject),
      savedAt: correction.savedAt,
    });
  }

  applyPolicyToSimilar(mailboxUser, mailboxId, message, policy) {
    const candidates = this.store.listMessagesBySender(mailboxId, policy.senderEmail);
    const applied = [];
    const skippedExplicit = [];
    let considered = 0;
    for (const candidate of candidates) {
      if (!candidate?.id || candidate.id === message.id) continue;
      if (!policyMatches(candidate, policy)) continue;
      considered += 1;
      if (this.store.getPrecisionCorrection(mailboxId, candidate.id)) {
        skippedExplicit.push(candidate.id);
        continue;
      }
      if (applied.length >= MAX_GENERALIZED_MESSAGES) continue;
      this.classifyOne(mailboxUser, candidate);
      applied.push(candidate.id);
    }
    return {
      applied,
      skippedExplicit,
      truncated: considered > applied.length + skippedExplicit.length,
    };
  }

  acceptLlmObservations(mailboxUser, observations = [], meta = {}) {
    const accepted = [];
    const skipped = [];
    for (const observation of observations) {
      const message = this.store.getMessage(this.ensureMailbox(mailboxUser).id, observation.messageId);
      if (!message) {
        skipped.push({ messageId: observation.messageId, reason: 'missing-message' });
        continue;
      }
      const mailbox = this.ensureMailbox(mailboxUser);
      if (this.store.getPrecisionCorrection(mailbox.id, message.id)) {
        skipped.push({ messageId: message.id, reason: 'explicit-correction' });
        continue;
      }
      const rules = this.rulesClassification(mailboxUser, message);
      const merged = mergeLlmClassification(rules, observation, {
        provider: meta.provider || observation.provider,
        model: meta.model || observation.model,
        promptVersion: meta.promptVersion || observation.promptVersion,
        analyzedAt: meta.analyzedAt,
      });
      const policy = this.matchingPolicy(mailbox.id, message);
      const finalClassification = policy ? applyLearnedPolicy(merged, policy) : merged;
      const saved = this.store.savePrecisionClassification(mailbox.id, message.id, finalClassification);
      this.store.saveAnalysis(mailbox.id, message.id, llmCacheKey(message, meta), {
        source: 'ai',
        provider: meta.provider || observation.provider,
        model: meta.model || observation.model,
        promptVersion: meta.promptVersion || observation.promptVersion,
        status: observation.legacyStatus || 'active',
        confidence: observation.confidence,
        summary: [observation.rationale || observation.workState],
        evidenceItems: [observation.evidence?.exactText || ''],
        nextActions: [],
        aiRationale: observation.rationale || '',
      });
      this.store.saveObservation(mailbox.id, message.id, {
        observationType: 'precision-classification',
        value: {
          workState: observation.workState,
          nextActor: observation.nextActor,
          priority: observation.priority,
        },
        evidence: [observation.evidence?.exactText || ''],
        source: 'ai',
        provider: meta.provider || observation.provider,
        model: meta.model || observation.model,
        promptVersion: meta.promptVersion || observation.promptVersion,
        confidence: observation.confidence,
        reviewStatus: 'accepted',
        createdAt: meta.analyzedAt,
      });
      accepted.push(saved);
    }
    return { accepted, skipped };
  }

  recordLlmFailures(mailboxUser, failures = [], meta = {}) {
    const recorded = [];
    for (const failure of failures) {
      const mailbox = this.ensureMailbox(mailboxUser);
      const message = this.store.getMessage(mailbox.id, failure.messageId);
      if (!message) continue;
      const rules = this.rulesClassification(mailboxUser, message);
      const labeled = labelLlmFailure(rules, failure);
      const policy = this.matchingPolicy(mailbox.id, message);
      const finalClassification = policy ? applyLearnedPolicy(labeled, policy) : labeled;
      const saved = this.store.savePrecisionClassification(mailbox.id, message.id, finalClassification);
      this.store.saveAnalysis(mailbox.id, message.id, `${llmCacheKey(message, meta)}::failed`, {
        source: 'rules-fallback',
        provider: meta.provider || '',
        model: meta.model || '',
        promptVersion: meta.promptVersion || '',
        status: labeled.legacyStatus || 'active',
        confidence: null,
        summary: [failure.message || failure.code || 'llm-failed'],
        evidenceItems: [],
        nextActions: [],
        aiRationale: '',
        errorCode: failure.code || 'LLM_FAILED',
        errorMessage: failure.message || '',
      });
      this.store.saveObservation(mailbox.id, message.id, {
        observationType: 'precision-classification',
        value: { code: failure.code || 'LLM_FAILED' },
        evidence: [],
        source: 'ai',
        provider: meta.provider || '',
        model: meta.model || '',
        promptVersion: meta.promptVersion || '',
        reviewStatus: 'rejected',
        createdAt: meta.analyzedAt,
      });
      recorded.push(saved);
    }
    return recorded;
  }

  rulesClassification(mailboxUser, message) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return classifyMessage(message, {
      projects: this.store.listProjects(mailbox.id),
      mailboxAddress: mailbox.address || mailboxUser,
      mailboxAddresses: this.store.getMailboxSenderAliases(mailbox.id),
      now: this.now(),
      source: 'rules',
      provider: 'rules',
      model: '',
    });
  }

  summary(mailboxUser = '', { classifyPending = true } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const classificationRun = classifyPending ? this.classifyStored(mailboxUser) : null;
    const classifications = Object.values(this.store.getPrecisionClassificationMap(mailbox.id));
    const storedSummary = this.store.precisionSummary(mailbox.id);
    const calculated = summarizeClassifications(classifications);
    return {
      ...storedSummary,
      calculated,
      projects: this.store.listProjects(mailbox.id).length,
      classificationRun,
    };
  }

  search(mailboxUser = '', query, { limit = 25, now = this.now() } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    this.classifyStored(mailboxUser);
    const parsedQuery = parseIntelligentQuery(query, { now });
    const searchOptions = {
      limit: boundedLimit(limit, 25, 100),
    };
    let evaluated = evaluateSemanticSearchResults(
      parsedQuery.originalQuery,
      this.store.intelligentSearch(mailbox.id, parsedQuery, searchOptions),
    );
    let results = evaluated.results;
    let effectiveParsedQuery = parsedQuery;
    let fallbackApplied = false;
    if (results.length === 0 && parsedQuery.searchPlan?.fallbackPolicy?.allowed) {
      effectiveParsedQuery = {
        ...parsedQuery,
        searchMode: 'coverage',
      };
      evaluated = evaluateSemanticSearchResults(
        parsedQuery.originalQuery,
        this.store.intelligentSearch(mailbox.id, effectiveParsedQuery, searchOptions),
      );
      results = evaluated.results;
      fallbackApplied = true;
    }
    const decision = validatedSearchDecision(evaluated.decision, results);
    return {
      parsedQuery,
      fallbackApplied,
      effectiveResidualOperator: effectiveParsedQuery.searchMode === 'coverage' ? 'COVERAGE' : effectiveParsedQuery.residualOperator,
      softTokenCount: parsedQuery.searchPlan?.softTokens?.length || 0,
      ...decision,
      results: results.map((result) => ({
        ...result,
        matchedBecause: explainIntelligentMatch(result, effectiveParsedQuery),
      })),
    };
  }

  smartViews(now = this.now()) {
    return intelligentSmartViews(now);
  }
}

export const precisionIntelligenceInternals = {
  boundedLimit,
  mailboxKey,
};
