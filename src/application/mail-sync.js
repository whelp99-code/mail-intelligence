import { createHash } from 'node:crypto';
import { graphItemLacksContent, normalizeGraphAttachment, normalizeGraphMessage } from '../domain/mail-normalizer.js';
import { retryOperation } from '../resilience.js';

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function uniqueMessageIds(ids = []) {
  const seen = new Set();
  const unique = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function safeMessage(error) {
  return String(error?.message || 'Mail synchronization failed.').slice(0, 1000);
}

function auditStatusCode(error) {
  return Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599
    ? error.statusCode
    : 0;
}

export class MailSyncService {
  constructor({ store, graphClientFactory, attachmentMetadataLimit = 10, retrySleep = null }) {
    if (!store) throw new Error('store is required.');
    if (typeof graphClientFactory !== 'function') throw new Error('graphClientFactory is required.');
    this.store = store;
    this.graphClientFactory = graphClientFactory;
    this.attachmentMetadataLimit = Math.min(Math.max(Number(attachmentMetadataLimit) || 0, 0), 50);
    this.retrySleep = typeof retrySleep === 'function' ? retrySleep : null;
  }

  async syncFolder({
    accessToken,
    mailboxUser = '',
    folderId = 'inbox',
    wellKnownName = '',
    displayName = 'Inbox',
    parentGraphId = '',
    forceInitial = false,
    recentLimit = 50,
  }) {
    const key = mailboxKey(mailboxUser);
    const mailbox = this.store.ensureMailbox({
      key,
      address: mailboxUser,
      graphUser: mailboxUser,
    });
    let folder = this.store.ensureFolder({
      mailboxId: mailbox.id,
      graphId: folderId,
      wellKnownName,
      displayName,
      parentGraphId,
    });
    const mailboxPath = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : '/me';
    const client = this.graphClientFactory({ accessToken });

    if (forceInitial) {
      this.store.clearFolderCursor(folder.id);
      folder = this.store.getFolder({ mailboxId: mailbox.id, graphId: folderId });
    }

    const committedIds = [];
    const retainCommitted = (error) => {
      if (Array.isArray(error?.upsertedMessageIds)) committedIds.push(...error.upsertedMessageIds);
      if (error && typeof error === 'object') error.upsertedMessageIds = uniqueMessageIds(committedIds);
    };
    const folderReceipt = (result, extra = {}) => ({
      ...result,
      ...extra,
      upsertedMessageIds: uniqueMessageIds(committedIds),
      mailbox,
      folder: this.store.getFolder({ mailboxId: mailbox.id, graphId: folderId }),
      messages: this.store.getRecentMessages(mailbox.id, { limit: recentLimit }),
    });

    try {
      const result = await this.runSync({
        client,
        mailbox,
        folder,
        mailboxPath,
        folderId,
      });
      committedIds.push(...(result.upsertedMessageIds || []));
      return folderReceipt(result);
    } catch (error) {
      retainCommitted(error);
      if (error?.code !== 'DELTA_CURSOR_EXPIRED' || forceInitial) throw error;
      try {
        this.store.clearFolderCursor(folder.id, {
          errorCode: 'DELTA_CURSOR_EXPIRED',
          errorMessage: 'Expired delta cursor was reset before a fresh synchronization.',
        });
        folder = this.store.getFolder({ mailboxId: mailbox.id, graphId: folderId });
        const resetResult = await this.runSync({
          client,
          mailbox,
          folder,
          mailboxPath,
          folderId,
          forcedRunType: 'cursor-reset',
        });
        committedIds.push(...(resetResult.upsertedMessageIds || []));
        return folderReceipt(resetResult, { cursorReset: true });
      } catch (resetError) {
        retainCommitted(resetError);
        throw resetError;
      }
    }
  }

  async syncMailbox({
    accessToken,
    mailboxUser = '',
    includeHiddenFolders = true,
    maxFolders = 1_000,
    recentLimit = 50,
    forceInitial = false,
  }) {
    const key = mailboxKey(mailboxUser);
    const mailbox = this.store.ensureMailbox({
      key,
      address: mailboxUser,
      graphUser: mailboxUser,
    });
    const mailboxPath = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : '/me';
    const discoveryClient = this.graphClientFactory({ accessToken });
    const folders = await discoveryClient.listMailFolders({
      mailboxPath,
      includeHidden: includeHiddenFolders,
      maxFolders,
    });
    const folderResults = [];
    const errors = [];
    const upsertedMessageIds = [];
    for (const folder of folders) {
      const committedIds = [];
      try {
        const result = await retryOperation(
          async () => {
            try {
              const folderResult = await this.syncFolder({
                accessToken,
                mailboxUser,
                folderId: folder.id,
                displayName: folder.displayName || folder.id,
                parentGraphId: folder.parentFolderId || '',
                recentLimit: 1,
                forceInitial,
              });
              committedIds.push(...(folderResult.upsertedMessageIds || []));
              return folderResult;
            } catch (error) {
              if (Array.isArray(error?.upsertedMessageIds)) committedIds.push(...error.upsertedMessageIds);
              throw error;
            }
          },
          {
            attempts: 3,
            baseDelayMs: 250,
            shouldRetry: (error) => error?.retryable === true,
            ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
          },
        );
        folderResults.push({
          folderId: folder.id,
          displayName: folder.displayName,
          runType: result.runType,
          pages: result.pages,
          received: result.received,
          upserts: result.upserts,
          deletions: result.deletions,
          attachmentErrors: result.attachmentErrors,
          cursorReset: Boolean(result.cursorReset),
        });
      } catch (error) {
        errors.push({
          folderId: folder.id,
          displayName: folder.displayName,
          code: error?.code || 'SYNC_FAILED',
          message: safeMessage(error),
        });
      }
      upsertedMessageIds.push(...committedIds);
    }
    const totals = folderResults.reduce((acc, item) => ({
      pages: acc.pages + item.pages,
      received: acc.received + item.received,
      upserts: acc.upserts + item.upserts,
      deletions: acc.deletions + item.deletions,
      attachmentErrors: acc.attachmentErrors + item.attachmentErrors,
    }), { pages: 0, received: 0, upserts: 0, deletions: 0, attachmentErrors: 0 });
    this.store.audit('mailbox.sync.completed', {
      entityType: 'mailbox',
      entityId: mailbox.id,
      payload: {
        discoveredFolders: folders.length,
        completedFolders: folderResults.length,
        failedFolders: errors.length,
        ...totals,
      },
    });
    return {
      mailbox,
      discoveredFolders: folders.length,
      completedFolders: folderResults.length,
      failedFolders: errors.length,
      folderResults,
      errors,
      ...totals,
      messages: this.store.getRecentMessages(mailbox.id, { limit: recentLimit }),
      upsertedMessageIds: uniqueMessageIds(upsertedMessageIds),
    };
  }

  async runSync({ client, mailbox, folder, mailboxPath, folderId, forcedRunType = '' }) {
    const startUrl = folder.next_link || folder.delta_link || '';
    const runType = forcedRunType || (folder.next_link ? 'resume' : folder.delta_link ? 'delta' : 'initial');
    const syncRunId = this.store.startSyncRun({
      mailboxId: mailbox.id,
      folderId: folder.id,
      runType,
      cursorStart: startUrl,
    });
    const totals = { pages: 0, received: 0, upserts: 0, deletions: 0, attachmentErrors: 0 };
    const upsertedMessageIds = [];
    let lastCursor = startUrl;
    let attachmentsRemaining = this.attachmentMetadataLimit;

    try {
      for await (const page of client.iterateDelta({
        mailboxPath,
        folderId,
        startUrl,
      })) {
        const normalized = [];
        const pageIds = [];
        for (const raw of page.items) {
          let payload = raw;
          if (raw && !raw['@removed'] && graphItemLacksContent(raw)) {
            if (typeof client.fetchMessage !== 'function') {
              throw new Error('Graph client cannot re-fetch a partial delta item.');
            }
            payload = await retryOperation(
              () => client.fetchMessage({
                mailboxPath,
                messageId: raw.id,
              }),
              {
                attempts: 2,
                baseDelayMs: 200,
                shouldRetry: (error) => error?.retryable === true,
              },
            );
          }
          const item = normalizeGraphMessage(payload);
          if (
            item.kind === 'upsert'
            && item.hasAttachments
            && item.attachments === null
            && attachmentsRemaining > 0
          ) {
            attachmentsRemaining -= 1;
            try {
              const metadata = await retryOperation(
                () => client.fetchAttachmentMetadata({
                  mailboxPath,
                  messageId: item.graphId,
                }),
                {
                  attempts: 2,
                  baseDelayMs: 200,
                  shouldRetry: (error) => error?.retryable === true,
                },
              );
              item.attachments = metadata.map(normalizeGraphAttachment);
            } catch (error) {
              totals.attachmentErrors += 1;
              this.store.audit('attachment.metadata.failed', {
                entityType: 'message',
                entityId: item.graphId,
                payload: {
                  code: error?.code || 'ATTACHMENT_METADATA_FAILED',
                  statusCode: auditStatusCode(error),
                  retryable: error?.retryable === true,
                },
              });
            }
          }
          normalized.push(item);
          if (item.kind === 'upsert' && item.graphId) pageIds.push(item.graphId);
        }
        const applied = this.store.applyDeltaPage({
          mailboxId: mailbox.id,
          folderId: folder.id,
          syncRunId,
          pageIndex: page.pageIndex,
          requestUrl: page.requestUrl,
          items: normalized,
          nextLink: page.nextLink,
          deltaLink: page.deltaLink,
        });
        upsertedMessageIds.push(...pageIds);
        totals.pages += 1;
        totals.received += applied.items;
        totals.upserts += applied.upserts;
        totals.deletions += applied.deletions;
        lastCursor = page.deltaLink || page.nextLink || lastCursor;
      }
      this.store.completeSyncRun(syncRunId, folder.id, lastCursor);
      this.store.audit('mail.sync.completed', {
        entityType: 'mail_folder',
        entityId: folder.id,
        payload: { runType, ...totals },
      });
      return { syncRunId, runType, ...totals, upsertedMessageIds };
    } catch (error) {
      if (error && typeof error === 'object') error.upsertedMessageIds = upsertedMessageIds.slice();
      const status = error?.retryable ? 'interrupted' : 'failed';
      this.store.recordSyncFailure(syncRunId, folder.id, error, status);
      this.store.audit('mail.sync.failed', {
        entityType: 'mail_folder',
        entityId: folder.id,
        payload: {
          runType,
          code: error?.code || 'SYNC_FAILED',
          messageDigest: createHash('sha256').update(safeMessage(error)).digest('hex'),
          pages: totals.pages,
        },
      });
      throw error;
    }
  }
}
