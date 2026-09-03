import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { GraphMailClient } from '../adapters/microsoft-graph-mail.js';
import { MailSyncService } from './mail-sync.js';
import { MailAssistantService } from './mail-assistant.js';
import { PrecisionIntelligenceService } from './precision-intelligence.js';
import { retryOperation } from '../resilience.js';
import { createVerifiedBackup } from '../storage/backup-restore.js';
import { importLegacyMailCache } from '../storage/legacy-import.js';
import { SQLiteMailStore } from '../storage/sqlite-store.js';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export class PersistentMailMemoryRuntime {
  constructor({
    databasePath,
    migrationsDir,
    backupDirectory,
    legacyCachePaths = [],
    graphBaseUrl = 'https://graph.microsoft.com/v1.0',
    fetchImpl = globalThis.fetch,
    graphTimeoutMs = 30_000,
    graphPageSize = 50,
    graphMaxPages = 1_000,
    attachmentMetadataLimit = 10,
  }) {
    this.databasePath = resolve(databasePath);
    this.backupDirectory = resolve(backupDirectory);
    this.legacyCachePaths = [...new Set(legacyCachePaths.filter(Boolean).map((path) => resolve(path)))];
    this.graphBaseUrl = String(graphBaseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.graphTimeoutMs = graphTimeoutMs;
    this.graphPageSize = graphPageSize;
    this.graphMaxPages = graphMaxPages;
    this.store = new SQLiteMailStore({
      databasePath: this.databasePath,
      migrationsDir: resolve(migrationsDir),
    });
    this.syncService = new MailSyncService({
      store: this.store,
      attachmentMetadataLimit,
      graphClientFactory: ({ accessToken }) => new GraphMailClient({
        fetchImpl: this.fetchImpl,
        accessToken,
        graphBaseUrl: this.graphBaseUrl,
        timeoutMs: this.graphTimeoutMs,
        pageSize: this.graphPageSize,
        maxPages: this.graphMaxPages,
      }),
    });
    this.precision = new PrecisionIntelligenceService({ store: this.store });
    this.assistant = new MailAssistantService({ store: this.store, precision: this.precision });
    this.legacyImports = [];
    this.syncInFlight = new Map();
    this.backupInFlight = null;
  }

  async initialize() {
    for (const sourcePath of this.legacyCachePaths) {
      if (!(await pathExists(sourcePath))) continue;
      const result = await importLegacyMailCache({
        store: this.store,
        sourcePath,
        sourceName: basename(sourcePath),
      });
      this.legacyImports.push({ sourcePath, ...result });
    }
    const status = this.store.storageStatus();
    if (!status.ready) throw new Error('Persistent mail memory database failed integrity verification.');
    return {
      storage: status,
      legacyImports: this.legacyImports,
      precision: { processed: 0, changed: 0, reviewRequired: 0, deferred: true },
    };
  }

  ensureMailbox(mailboxUser = '') {
    const key = mailboxKey(mailboxUser);
    return this.store.ensureMailbox({
      key,
      address: mailboxUser,
      graphUser: mailboxUser,
    });
  }

  getMessages(mailboxUser = '', { limit = 50, includeDeleted = false } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.getRecentMessages(mailbox.id, { limit, includeDeleted });
  }

  getFeedbackMap(mailboxUser = '') {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.getFeedbackMap(mailbox.id);
  }

  saveFeedback(mailboxUser = '', messageId, feedback) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.saveFeedback(mailbox.id, messageId, feedback);
  }

  getAnalysis(mailboxUser = '', messageId, cacheKey) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.getAnalysis(mailbox.id, messageId, cacheKey);
  }

  saveAnalysis(mailboxUser = '', messageId, cacheKey, analysis) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.saveAnalysis(mailbox.id, messageId, cacheKey, analysis);
  }

  search(mailboxUser = '', query, { limit = 25 } = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    return this.store.searchMessages(mailbox.id, query, { limit });
  }

  listProjects(mailboxUser = '', options = {}) {
    return this.precision.listProjects(mailboxUser, options);
  }

  createProject(mailboxUser = '', project = {}, options = {}) {
    return this.precision.createProject(mailboxUser, project, options);
  }

  classifyPrecision(mailboxUser = '', messageOrId, options = {}) {
    return this.precision.classifyOne(mailboxUser, messageOrId, options);
  }

  classifyStoredPrecision(mailboxUser = '', options = {}) {
    return this.precision.classifyStored(mailboxUser, options);
  }

  getPrecisionClassification(mailboxUser = '', messageId) {
    return this.precision.getClassification(mailboxUser, messageId);
  }

  correctPrecision(mailboxUser = '', messageId, correction = {}) {
    return this.precision.correct(mailboxUser, messageId, correction);
  }

  precisionSummary(mailboxUser = '', options = {}) {
    return this.precision.summary(mailboxUser, options);
  }

  intelligentSearch(mailboxUser = '', query, options = {}) {
    return this.precision.search(mailboxUser, query, options);
  }

  intelligentSmartViews() {
    return this.precision.smartViews();
  }

  operationalSummary(mailboxUser = '') {
    return this.assistant.operationalSummary(mailboxUser);
  }

  messageSummary(mailboxUser = '', messageId) {
    return this.assistant.summary(mailboxUser, messageId);
  }

  threadSummary(mailboxUser = '', messageId, options = {}) {
    return this.assistant.threadSummary(mailboxUser, messageId, options);
  }

  meetingCandidate(mailboxUser = '', messageId, options = {}) {
    return this.assistant.meetingCandidate(mailboxUser, messageId, options);
  }

  messageAttachments(mailboxUser = '', messageId) {
    return this.assistant.attachments(mailboxUser, messageId);
  }

  attachmentSummary(mailboxUser = '', messageId, attachmentId, options = {}) {
    return this.assistant.attachmentSummary(mailboxUser, messageId, attachmentId, options);
  }

  assistantPersonality(mailboxUser = '') {
    return this.assistant.personality(mailboxUser);
  }

  saveAssistantPersonality(mailboxUser = '', value = {}) {
    return this.assistant.savePersonality(mailboxUser, value);
  }

  generateAssistantDraft(mailboxUser = '', messageId, options = {}) {
    return this.assistant.draft(mailboxUser, messageId, options);
  }

  confirmPrecisionClassification(mailboxUser = '', messageId, options = {}) {
    return this.assistant.confirmClassification(mailboxUser, messageId, options);
  }

  adjudicationCandidate(mailboxUser = '', messageId) {
    return this.assistant.adjudicationCandidate(mailboxUser, messageId);
  }

  syncStatus(mailboxUser = '') {
    const mailbox = this.ensureMailbox(mailboxUser);
    return {
      mailbox: {
        key: mailbox.mailbox_key,
        address: mailbox.address,
      },
      ...this.store.getSyncStatus(mailbox.id),
    };
  }

  storageStatus(mailboxUser = '') {
    return {
      authoritativeStore: 'sqlite',
      databaseFile: basename(this.databasePath),
      ...this.store.storageStatus(),
      sync: this.syncStatus(mailboxUser),
      legacyImports: this.legacyImports.map((item) => ({
        sourceFile: basename(item.sourcePath),
        imported: item.imported,
        skipped: item.imported === false,
        reason: item.reason || '',
        counts: item.counts || null,
      })),
      backups: this.store.listBackupManifests({ limit: 10 }),
      jobs: this.store.listOperatorJobs({ limit: 20 }),
      deadLetters: this.store.listDeadLetters({ limit: 20 }),
    };
  }

  async syncMailbox({
    accessToken,
    mailboxUser = '',
    recentLimit = 50,
    includeHiddenFolders = true,
    maxFolders = 1_000,
    forceInitial = false,
  }) {
    const key = mailboxKey(mailboxUser);
    const existing = this.syncInFlight.get(key);
    if (existing) return existing;
    const jobKey = `mail-sync:${key}:${Date.now()}:${randomUUID()}`;
    const job = this.store.createOperatorJob({
      jobKey,
      jobType: 'mail-sync',
      input: {
        mailbox: key,
        recentLimit,
        includeHiddenFolders,
        maxFolders,
        forceInitial,
      },
      maxAttempts: 2,
    });
    const operation = retryOperation(
      async (attempt) => {
        this.store.markOperatorJobRunning(jobKey, attempt);
        return this.syncService.syncMailbox({
          accessToken,
          mailboxUser,
          recentLimit,
          includeHiddenFolders,
          maxFolders,
          forceInitial,
        });
      },
      {
        attempts: 2,
        baseDelayMs: 500,
        shouldRetry: (error) => error?.retryable === true,
      },
    ).then((result) => {
      const precision = this.precision.classifyStored(mailboxUser);
      for (const failure of result.errors || []) {
        this.store.recordDeadLetter({
          jobId: job.id,
          eventType: 'mail-sync.folder.failed',
          entityType: 'mail_folder',
          entityId: failure.folderId || '',
          errorCode: failure.code || 'SYNC_FAILED',
          errorMessage: failure.message || 'Folder synchronization failed.',
          payload: {
            mailbox: key,
            displayName: failure.displayName || '',
          },
        });
      }
      this.store.completeOperatorJob(jobKey, {
        discoveredFolders: result.discoveredFolders,
        completedFolders: result.completedFolders,
        failedFolders: result.failedFolders,
        pages: result.pages,
        received: result.received,
        upserts: result.upserts,
        deletions: result.deletions,
        attachmentErrors: result.attachmentErrors,
        precision,
      });
      this.store.checkpointWal('TRUNCATE');
      return {
        ...result,
        precision,
        job: this.store.getOperatorJob(jobKey),
      };
    }).catch((error) => {
      const failedJob = this.store.failOperatorJob(jobKey, error, { deadLetter: true });
      this.store.recordDeadLetter({
        jobId: failedJob.id,
        eventType: 'mail-sync.failed',
        entityType: 'mailbox',
        entityId: key,
        errorCode: error?.code || 'SYNC_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Mailbox synchronization failed.',
        payload: { mailbox: key },
      });
      if (error && typeof error === 'object') error.operatorJob = failedJob;
      throw error;
    }).finally(() => {
      if (this.syncInFlight.get(key) === operation) this.syncInFlight.delete(key);
    });
    this.syncInFlight.set(key, operation);
    return operation;
  }

  async backup({ targetPath = '' } = {}) {
    if (this.backupInFlight) return this.backupInFlight;
    const destination = targetPath
      ? resolve(targetPath)
      : join(this.backupDirectory, `mail-intelligence-${timestampForFilename()}.sqlite`);
    const jobKey = `backup:${Date.now()}:${randomUUID()}`;
    this.store.createOperatorJob({
      jobKey,
      jobType: 'backup',
      input: { backupName: basename(destination) },
      maxAttempts: 1,
    });
    this.store.markOperatorJobRunning(jobKey, 1);
    const operation = createVerifiedBackup({ store: this.store, targetPath: destination })
      .then((result) => {
        this.store.completeOperatorJob(jobKey, {
          backupName: result.manifest.backup_name,
          checksumSha256: result.checksumSha256,
          sizeBytes: result.sizeBytes,
          schemaVersion: result.schemaVersion,
        });
        this.store.checkpointWal('TRUNCATE');
        return {
          ...result,
          job: this.store.getOperatorJob(jobKey),
        };
      })
      .catch((error) => {
        const failedJob = this.store.failOperatorJob(jobKey, error, { deadLetter: true });
        this.store.recordDeadLetter({
          jobId: failedJob.id,
          eventType: 'storage.backup.failed',
          entityType: 'backup',
          entityId: basename(destination),
          errorCode: error?.code || 'BACKUP_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Backup failed.',
          payload: { backupName: basename(destination) },
        });
        throw error;
      })
      .finally(() => {
        if (this.backupInFlight === operation) this.backupInFlight = null;
      });
    this.backupInFlight = operation;
    return operation;
  }

  close() {
    this.store.close();
  }
}

export const persistentMailMemoryInternals = {
  mailboxKey,
  pathExists,
  timestampForFilename,
};
