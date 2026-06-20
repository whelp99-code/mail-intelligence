/**
 * Maps standalone analyze output to AIOS v1 contract shapes (read-only portal bridge).
 */

import { resolveEntityForMessage, toEntityCandidates } from './entityResolution.mjs';

export { toEntityCandidates };

function lanePriority(lane) {
  return lane === 'urgent' ? 'high' : 'normal';
}

function domainFromAddress(from = '') {
  const email = String(from).match(/<([^>]+)>/)?.[1] || String(from).trim();
  const domain = email.split('@')[1] || '';
  return domain.toLowerCase();
}

export function toMailMessageMeta(message) {
  return {
    id: message.id,
    subject: message.subject || '(제목 없음)',
    fromAddress: message.from || '',
    receivedAt: message.receivedAt || new Date().toISOString(),
    groupKey: message.aiGroupKey || message.mailGroupSortKey || undefined,
    preview: message.bodyPreview || undefined
  };
}

export function toMailGroups(threadGroups = []) {
  return threadGroups.map((group) => ({
    key: group.key || group.label || 'general',
    label: group.label || group.key || 'general',
    messageCount: group.count || group.messageIds?.length || 0
  }));
}

export function toTaskCandidates({ messages = [], messageInsights = [], threadGroups = [] }) {
  const insightById = new Map((messageInsights || []).map((item) => [item.id, item]));
  const candidates = [];
  const seen = new Set();

  for (const group of threadGroups || []) {
    if (group.userReplied) continue;
    const repId = group.messageIds?.[0];
    const message = messages.find((item) => item.id === repId) || messages[0];
    if (!message || seen.has(message.id)) continue;
    const insight = insightById.get(message.id);
    const lane = insight?.effectiveStatus || insight?.status || 'active';
    if (!['urgent', 'active', 'waiting'].includes(lane)) continue;

    const blob = `${message.subject || ''} ${message.bodyPreview || ''}`.toLowerCase();
    const entityHint = resolveEntityForMessage(message, { mailboxUser: '' });
    let entityType = entityHint?.entityRole;
    if (!entityType && /견적|quote|po\b|invoice/.test(blob)) entityType = 'customer';
    if (!entityType && /partner|협력|총판/.test(blob)) entityType = 'partner';

    candidates.push({
      mailMessageId: message.id,
      title: group.label || message.subject || 'Follow up',
      summary: insight?.summary?.[0] || message.bodyPreview || message.subject || '',
      priority: lanePriority(lane),
      entityType,
      entityId: entityType ? (entityHint?.domain || domainFromAddress(message.from)) : undefined
    });
    seen.add(message.id);
  }

  for (const insight of messageInsights || []) {
    if (seen.has(insight.id)) continue;
    const lane = insight.effectiveStatus || insight.status;
    if (!['urgent', 'active'].includes(lane)) continue;
    const message = messages.find((item) => item.id === insight.id);
    if (!message) continue;
    candidates.push({
      mailMessageId: message.id,
      title: `Follow up: ${message.subject || '(제목 없음)'}`,
      summary: insight.summary?.[0] || message.bodyPreview || '',
      priority: lanePriority(lane)
    });
    seen.add(insight.id);
  }

  return candidates.slice(0, 50);
}

export function toInsightThreads({ threadGroups = [], messages = [], messageInsights = [], mailboxUser = '' }) {
  const insightById = new Map((messageInsights || []).map((item) => [item.id, item]));

  return (threadGroups || [])
    .filter((group) => (group.count || 0) >= 1)
    .map((group) => {
      const repId = group.messageIds?.[0];
      const rep = messages.find((item) => item.id === repId);
      const insight = rep ? insightById.get(rep.id) : null;
      const nextActions = (group.messageIds || [])
        .flatMap((id) => insightById.get(id)?.nextActions || [])
        .slice(0, 8)
        .map((action) => ({
          recommendedAction: action.recommendedAction || action.title,
          owner: action.owner,
          due: action.due
        }));

      const domains = [...new Set((group.participants || []).map(domainFromAddress).filter(Boolean))];

      return {
        threadKey: group.key || group.label || repId || 'thread',
        threadTitle: group.label || rep?.subject || 'Mail thread',
        sourceProvider: 'mail-intelligence',
        accountEmail: mailboxUser || undefined,
        messageCount: group.count || group.messageIds?.length || 0,
        messageIds: group.messageIds || [],
        latestReceivedAt: rep?.receivedAt,
        status: group.userReplied ? 'waiting' : insight?.status || 'active',
        effectiveStatus: group.userReplied ? 'waiting' : insight?.effectiveStatus || insight?.status,
        aiEnhanced: Boolean(group.aiGrouped),
        summary: insight?.summary?.join(' ') || rep?.bodyPreview || group.label || '',
        nextActions,
        evidenceItems: insight?.summary || [],
        revenueOpsTags: [],
        participantDomains: domains,
        metadata: {
          userReplied: Boolean(group.userReplied),
          aiGrouped: Boolean(group.aiGrouped),
          sources: group.sources || []
        }
      };
    });
}

export function filterThreadsForIngest(threads = [], options = {}) {
  const minMessages = options.minMessages ?? 3;
  return threads.filter((thread) => {
    if ((thread.messageCount || 0) < minMessages) return false;
    if (thread.metadata?.userReplied) return false;
    const status = thread.effectiveStatus || thread.status;
    if (!['urgent', 'active'].includes(status)) return false;
    return true;
  });
}

export function toAttachmentRef(entry) {
  if (!entry?.id) return null;
  return {
    id: String(entry.id),
    name: String(entry.name || entry.fileName || 'attachment'),
    messageId: entry.messageId ? String(entry.messageId) : undefined,
    subject: entry.subject ? String(entry.subject) : undefined,
    fromAddress: entry.from || entry.fromName ? String(entry.from || entry.fromName) : undefined,
    receivedAt: entry.receivedAt ? String(entry.receivedAt) : undefined,
    sizeBytes: typeof entry.size === 'number' ? entry.size : undefined,
    category: entry.category ? String(entry.category) : undefined,
    hasDownload: Boolean(entry.hasDownload),
    contentHash: entry.contentHash ? String(entry.contentHash).slice(0, 16) : undefined,
    proxyPath: '/api/outlook/attachments'
  };
}

export function toAttachmentRefs(archive = {}) {
  const entries = Array.isArray(archive.entries) ? archive.entries : [];
  return entries.map(toAttachmentRef).filter(Boolean);
}

export function toMailSyncResult(payload) {
  const messages = payload.messages || [];
  const threadGroups = payload.threadGroups || payload.result?.threadGroups || [];
  const messageInsights = payload.result?.messageInsights || [];
  const mailboxUser = payload.mailboxUser || payload.sync?.mailboxUser || '';

  return {
    accounts: payload.connected ? 1 : 0,
    messages: payload.sync?.totalCached ?? messages.length,
    groups: toMailGroups(threadGroups),
    taskCandidates: toTaskCandidates({ messages, messageInsights, threadGroups }),
    entityCandidates: toEntityCandidates({ messages, threadGroups, mailboxUser }),
    connected: payload.connected !== false,
    syncedAt: payload.sync?.lastSyncedAt || payload.sync?.syncedAt || payload.analyzedAt || undefined
  };
}

export function toCalendarHints(payload) {
  const calendar = payload.result?.calendar || payload.calendar || [];
  return (Array.isArray(calendar) ? calendar : []).slice(0, 25).map((item) => ({
    title: item.title || item.subject || '일정',
    when: item.when || item.due || '',
    owner: item.owner || '',
    lane: item.lane || 'active',
    messageId: item.messageId,
    receivedAt: item.receivedAt,
    webLink: item.webLink
  }));
}
/**
 * Returns the approval gate and evidence writer contract metadata for AIOS v1/v2 integration.
 * This is a read-only descriptor; it does not mutate any state.
 */
export function toApprovalContract() {
  return {
    approvalGate: {
      enabled: process.env.MAIL_REQUIRE_APPROVAL === 'true',
      mechanism: 'X-Aios-Approval-ID + X-Mail-Internal-Key headers',
      destructivePaths: [
        { path: '/api/outlook/send', method: 'POST', description: '메일 발송' },
        { path: '/api/outlook/read', method: 'POST', description: '읽음 상태 변경' },
        { path: '/api/outlook/config', method: 'DELETE', description: '설정 초기화' }
      ],
      responseOnDenied: {
        statusCode: 403,
        body: { success: false, approvalStatus: 'pending', destructive: true }
      }
    },
    evidenceWriter: {
      feedbackPath: '/api/outlook/feedback',
      portalFeedbackPath: '/api/portal/feedback-sync',
      candidatePushPath: '/api/portal/push-candidates',
      description: '분류 보정 피드백은 AIOS evidence writer로 전달되어 다음 분석 기준에 반영됩니다.'
    },
    approvalStatusEndpoint: '/api/outlook/approval-status',
    sendRequestEndpoint: '/api/outlook/send-request',
    sendRequestStatusEndpoint: '/api/outlook/send-requests/:id',
    sendRequestCompleteEndpoint: '/api/outlook/send-requests/:id/complete'
  };
}
