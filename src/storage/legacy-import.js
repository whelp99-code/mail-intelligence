import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalizeLegacyCachedMessage } from '../domain/mail-normalizer.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function chunks(values, size = 200) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function mailboxAddress(key) {
  return key === 'me' ? '' : key;
}

function analysisMessageId(cacheKey) {
  return String(cacheKey || '').split('::')[0] || '';
}

function analysisProvider(cacheKey, value) {
  if (value?.aiProvider) return value.aiProvider;
  const parts = String(cacheKey || '').split('::');
  return parts.at(-1) || 'legacy';
}

export async function importLegacyMailCache({ store, sourcePath, sourceName = '' }) {
  if (!store) throw new Error('store is required.');
  if (!sourcePath) throw new Error('sourcePath is required.');
  const raw = await readFile(sourcePath);
  const sourceDigest = digest(raw);
  if (store.hasLegacyImport(sourceDigest)) {
    return { imported: false, reason: 'already-imported', sourceDigest };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const error = new Error('Legacy mail cache is not valid JSON.');
    error.code = 'LEGACY_CACHE_INVALID';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Legacy mail cache root must be an object.');
  }
  const mailboxes = parsed.mailboxes && typeof parsed.mailboxes === 'object' && !Array.isArray(parsed.mailboxes)
    ? parsed.mailboxes
    : {};
  const totals = {
    imported: true,
    sourceDigest,
    mailboxCount: 0,
    messageCount: 0,
    feedbackCount: 0,
    analysisCount: 0,
  };

  for (const [key, value] of Object.entries(mailboxes)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const mailbox = store.ensureMailbox({
      key,
      address: mailboxAddress(key),
      graphUser: mailboxAddress(key),
    });
    const folder = store.ensureFolder({
      mailboxId: mailbox.id,
      graphId: 'inbox',
      wellKnownName: 'inbox',
      displayName: 'Inbox',
    });
    totals.mailboxCount += 1;
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const normalizedMessages = messages
      .filter((message) => message?.id)
      .map(normalizeLegacyCachedMessage);
    const runId = store.startSyncRun({
      mailboxId: mailbox.id,
      folderId: folder.id,
      runType: 'legacy-import',
      cursorStart: sourceDigest,
    });
    try {
      const batches = chunks(normalizedMessages);
      if (!batches.length) {
        store.completeSyncRun(runId, folder.id, sourceDigest);
      } else {
        batches.forEach((items, pageIndex) => {
          store.applyDeltaPage({
            mailboxId: mailbox.id,
            folderId: folder.id,
            syncRunId: runId,
            pageIndex,
            requestUrl: `legacy://${sourceDigest}/${pageIndex}`,
            items,
          });
        });
        store.completeSyncRun(runId, folder.id, sourceDigest);
      }
      totals.messageCount += normalizedMessages.length;
    } catch (error) {
      store.recordSyncFailure(runId, folder.id, error, 'failed');
      throw error;
    }

    const feedback = value.feedback && typeof value.feedback === 'object' && !Array.isArray(value.feedback)
      ? value.feedback
      : {};
    for (const [messageId, item] of Object.entries(feedback)) {
      if (!store.getMessageRecord(mailbox.id, messageId) || !item?.userStatus) continue;
      store.saveFeedback(mailbox.id, messageId, {
        userStatus: item.userStatus,
        reasonCode: item.reasonCode || item.userStatus,
        reasonLabel: item.reasonLabel || '',
        note: item.note || '',
        sender: item.sender || '',
        subject: item.subject || '',
        subjectTokens: item.subjectTokens || [],
        savedAt: item.savedAt || undefined,
      });
      totals.feedbackCount += 1;
    }

    const analysis = value.analysis && typeof value.analysis === 'object' && !Array.isArray(value.analysis)
      ? value.analysis
      : {};
    for (const [cacheKey, item] of Object.entries(analysis)) {
      const messageId = analysisMessageId(cacheKey);
      if (!messageId || !store.getMessageRecord(mailbox.id, messageId) || !item) continue;
      store.saveAnalysis(mailbox.id, messageId, `legacy:${cacheKey}`, {
        source: 'ai-cache',
        provider: analysisProvider(cacheKey, item),
        model: item.aiModel || '',
        promptVersion: item.promptVersion || 'legacy-pre-v1.0.1',
        status: item.status || 'active',
        summary: item.summary || [],
        evidenceItems: item.evidenceItems || [],
        nextActions: item.nextActions || [],
        aiRationale: item.aiRationale || '',
      });
      totals.analysisCount += 1;
    }
  }

  store.recordLegacyImport({
    sourceName: sourceName || basename(sourcePath),
    sourceDigest,
    mailboxCount: totals.mailboxCount,
    messageCount: totals.messageCount,
    feedbackCount: totals.feedbackCount,
    analysisCount: totals.analysisCount,
  });
  store.audit('legacy.cache.imported', {
    entityType: 'legacy_import',
    entityId: sourceDigest,
    payload: {
      sourceName: sourceName || basename(sourcePath),
      mailboxCount: totals.mailboxCount,
      messageCount: totals.messageCount,
      feedbackCount: totals.feedbackCount,
      analysisCount: totals.analysisCount,
    },
  });
  return totals;
}

export const legacyImportInternals = {
  analysisMessageId,
  analysisProvider,
  digest,
};
