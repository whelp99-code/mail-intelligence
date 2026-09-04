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
    const automatic = classifyMessage(message, {
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
    const finalClassification = correction
      ? applyPrecisionCorrection(automatic, correction)
      : automatic;
    const previous = this.store.getPrecisionClassification(mailbox.id, message.id);
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
    const result = this.classifyOne(mailboxUser, messageId);
    return {
      correction: savedCorrection,
      classification: result.classification,
      events: this.store.getPrecisionEvents(mailbox.id, messageId),
    };
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
