import { createHash } from 'node:crypto';
import { normalizeGraphAttachment, normalizeGraphMessage } from '../domain/mail-normalizer.js';
import { retryOperation } from '../resilience.js';

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function safeMessage(error) {
  return String(error?.message || 'Mail synchronization failed.').slice(0, 1000);
}

export class MailSyncService {
  constructor({ store, graphClientFactory, attachmentMetadataLimit = 10 }) {
    if (!store) throw new Error('store is required.');
    if (typeof graphClientFactory !== 'function') throw new Error('graphClientFactory is required.');
    this.store = store;
    this.graphClientFactory = graphClientFactory;
    this.attachmentMetadataLimit = Math.min(Math.max(Number(attachmentMetadataLimit) || 0, 0), 50);
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

    try {
      const result = await this.runSync({
        client,
        mailbox,
        folder,
        mailboxPath,
        folderId,
      });
      return {
        ...result,
        mailbox,
        folder: this.store.getFolder({ mailboxId: mailbox.id, graphId: folderId }),
        messages: this.store.getRecentMessages(mailbox.id, { limit: recentLimit }),
      };
    } catch (error) {
      if (error?.code !== 'DELTA_CURSOR_EXPIRED' || forceInitial) throw error;
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
      return {
        ...resetResult,
        cursorReset: true,
        mailbox,
        folder: this.store.getFolder({ mailboxId: mailbox.id, graphId: folderId }),
        messages: this.store.getRecentMessages(mailbox.id, { limit: recentLimit }),
      };
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
    for (const folder of folders) {
      try {
        const result = await retryOperation(
          () => this.syncFolder({
            accessToken,
            mailboxUser,
            folderId: folder.id,
            displayName: folder.displayName || folder.id,
            parentGraphId: folder.parentFolderId || '',
            recentLimit: 1,
            forceInitial,
          }),
          {
            attempts: 3,
            baseDelayMs: 250,
            shouldRetry: (error) => error?.retryable === true,
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
    let lastCursor = startUrl;
    let attachmentsRemaining = this.attachmentMetadataLimit;

    try {
      for await (const page of client.iterateDelta({
        mailboxPath,
        folderId,
        startUrl,
      })) {
        const normalized = [];
        for (const raw of page.items) {
          const item = normalizeGraphMessage(raw);
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
                payload: { code: error?.code || 'ATTACHMENT_METADATA_FAILED' },
              });
            }
          }
          normalized.push(item);
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
      return { syncRunId, runType, ...totals };
    } catch (error) {
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
