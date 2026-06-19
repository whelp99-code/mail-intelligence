import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMessages, urgencyScore } from './src/analyzer.js';
import {
  groupMessagesByThread,
  normalizedSubjectKey,
  userRepliedInThread
} from './src/threadIdentity.mjs';
import {
  applyAssignments,
  applyRuleBasedGroupKeys,
  assignmentsFromThreads,
  buildThreadGroupingPrompt,
  messagesNeedingAiGrouping,
  parseThreadGroupingResponse,
  summarizeThreadGroups,
  unifyGroupKeysBySubject
} from './src/threadGrouping.mjs';
import { DATA_FILES, ensureDataDir, resolveDataPath } from './src/dataPaths.mjs';
import { checkDestructiveApproval, isDestructiveApi } from './src/destructiveApi.mjs';
import { createSendRequestStore, toSendRequestResponse } from './src/sendRequests.mjs';
import {
  filterThreadsForIngest,
  toAttachmentRefs,
  toCalendarHints,
  toEntityCandidates,
  toInsightThreads,
  toMailSyncResult,
  toTaskCandidates,
  toApprovalContract
} from './src/portalBridge.mjs';
import { runDeltaSync } from './src/graphDelta.mjs';
import { scheduleDebouncedAnalyze } from './src/webhookDebounce.mjs';
import { syncAttachmentsFromMessages } from './src/attachmentSync.mjs';
import {
  applyAccountToRuntimeConfig,
  findAccountById,
  listAccountsFromStore
} from './src/accountRegistry.mjs';
import {
  loadCallRecordings,
  processCallRecording,
  matchCallWithEmails,
  createConversationThread,
  batchProcessRecordings,
  parseCallFilename
} from './src/callAnalysis.mjs';
import {
  groupByConversation,
  matchReplyPair,
  analyzeConversationPatterns,
  generateConversationSummary
} from './src/conversationLearning.mjs';

const root = fileURLToPath(new URL('./src', import.meta.url));
const appRoot = dirname(fileURLToPath(import.meta.url));
let configPath = '';
let mailCachePath = '';
let attachmentArchivePath = '';
let attachmentArchiveMetaPath = '';
let outlookAccountsPath = '';
const port = Number(process.env.PORT || 3010);
const graphBaseUrl = 'https://graph.microsoft.com/v1.0';
const delegatedScopes = 'openid profile offline_access User.Read Mail.Read Mail.Send';
const FEEDBACK_STATUSES = new Set(['urgent', 'active', 'waiting', 'done']);
const FEEDBACK_REASONS = {
  urgent: '마감/장애/고객 리스크',
  active: '우리가 처리해야 할 작업 있음',
  waiting: '상대방 회신/승인/자료 필요',
  done: '이미 처리/발송/종료됨',
  hold: '보류: 지금 처리하지 않고 추후 확인'
};
const FEEDBACK_REASON_CODES = new Set(Object.keys(FEEDBACK_REASONS));
const runtimeConfig = {
  accessToken: '',
  tenantId: '',
  clientId: '',
  clientSecret: '',
  mailboxUser: '',
  loginTenant: 'common',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  refreshToken: '',
  expiresAt: 0,
  // F-AIOS-v3 Integration
  aiProvider: 'f-aios-v3',  // 'f-aios-v3' | 'gemini' | 'lmstudio' | 'mimo'
  faiosServerUrl: 'http://localhost:3201',
  lmstudioUrl: 'http://localhost:1234',
  lmstudioModel: 'qwen/qwen3.5-9b',
  // MiMo Integration
  mimoApiKey: '',
  mimoModel: 'MiMo-V2.5',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1'
};
const pendingOAuth = new Map();
const sendRequestStore = createSendRequestStore();

async function initDataPaths() {
  await ensureDataDir();
  configPath = await resolveDataPath(DATA_FILES.config, DATA_FILES.legacyConfig);
  mailCachePath = await resolveDataPath(DATA_FILES.mailCache, DATA_FILES.legacyMailCache);
  attachmentArchivePath = await resolveDataPath(DATA_FILES.attachmentArchive, '.attachment-archive.json');
  attachmentArchiveMetaPath = await resolveDataPath(
    DATA_FILES.attachmentArchiveMeta,
    '.attachment-archive-meta.json'
  );
  outlookAccountsPath = await resolveDataPath(DATA_FILES.outlookAccounts, '.outlook-accounts.json');
}

async function loadPersistedConfig() {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const key of Object.keys(runtimeConfig)) {
      if (typeof parsed[key] === 'string') runtimeConfig[key] = parsed[key];
      if (key === 'expiresAt' && typeof parsed[key] === 'number') runtimeConfig[key] = parsed[key];
    }
  } catch {
    // First run or unreadable config: keep environment/default values.
  }
}

async function savePersistedConfig() {
  await writeFile(configPath, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Some filesystems do not support chmod; ignore.
  }
}

async function loadMailCache() {
  try {
    const raw = await readFile(mailCachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      mailboxes: parsed.mailboxes && typeof parsed.mailboxes === 'object' ? parsed.mailboxes : {}
    };
  } catch {
    return { version: 1, mailboxes: {} };
  }
}

async function saveMailCache(cache) {
  await writeFile(mailCachePath, JSON.stringify(cache, null, 2), 'utf8');
  try {
    await chmod(mailCachePath, 0o600);
  } catch {
    // Some filesystems do not support chmod; ignore.
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mailboxCacheKey(mailboxUser) {
  return (mailboxUser || 'me').toLowerCase();
}

function currentMailboxKey() {
  return mailboxCacheKey(getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER'));
}

function emailAddress(value = '') {
  return String(value).match(/<([^>]+)>/)?.[1]?.trim() || String(value).trim();
}

function compactText(value = '', max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function subjectTokens(subject = '') {
  return compactText(subject, 200)
    .toLowerCase()
    .replace(/[()[\]{}<>,.;:!?'"`~@#$%^&*_+=|\\/]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function feedbackForPrompt(feedback = {}) {
  return Object.values(feedback)
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
    .slice(0, 30)
    .map((item) => ({
      sender: item.sender || '',
      subjectHint: compactText(item.subject || '', 80),
      subjectTokens: item.subjectTokens || [],
      userStatus: item.userStatus,
      reason: FEEDBACK_REASONS[item.reasonCode] || item.reasonCode || '',
      note: compactText(item.note || '', 120)
    }));
}

function feedbackSimilarity(message, feedbackItem) {
  let score = 0;
  const sender = emailAddress(message.from || '').toLowerCase();
  const feedbackSender = String(feedbackItem.sender || '').toLowerCase();
  
  // 발신자 일치 (가중치 증가: 2 → 4)
  if (sender && sender === feedbackSender) score += 4;
  
  // 발신자 도메인 일치 (새로 추가)
  const senderDomain = sender.split('@')[1] || '';
  const feedbackDomain = feedbackSender.split('@')[1] || '';
  if (senderDomain && senderDomain === feedbackDomain) score += 2;
  
  // 제목 토큰 일치
  const currentTokens = new Set(subjectTokens(message.subject));
  for (const token of feedbackItem.subjectTokens || []) {
    if (currentTokens.has(String(token).toLowerCase())) score += 1;
  }
  
  // 본문 패턴 매칭
  const text = `${message.subject || ''} ${message.bodyPreview || ''} ${message.body || ''}`.toLowerCase();
  if (feedbackItem.reasonCode === 'waiting' && /승인|회신|자료|대기|확인\s*부탁|pending|waiting/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'urgent' && /긴급|마감|오늘|금일|장애|critical|asap/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'done' && /완료|발송|처리|종료|resolved|completed|done/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'active' && /진행|검토|준비|공유|작성|review|follow/.test(text)) score += 1;
  
  // 피드백 빈도 기반 신뢰도 (새로 추가)
  const feedbackCount = feedbackItem.count || 1;
  score += Math.min(feedbackCount - 1, 3); // 최대 +3
  
  return score;
}

function inferredFeedbackStatus(message, feedback = {}) {
  const candidates = Object.values(feedback)
    .filter((item) => FEEDBACK_STATUSES.has(item.userStatus))
    .map((item) => ({ item, score: feedbackSimilarity(message, item) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// 스마트 규칙 학습: 발신자별 패턴 분석
function analyzeSenderPatterns(feedback = {}) {
  const senderStats = {};
  
  Object.values(feedback).forEach(item => {
    const sender = String(item.sender || '').toLowerCase();
    if (!sender) return;
    
    if (!senderStats[sender]) {
      senderStats[sender] = { total: 0, statuses: {}, lastUsed: null };
    }
    
    senderStats[sender].total++;
    senderStats[sender].statuses[item.userStatus] = (senderStats[sender].statuses[item.userStatus] || 0) + 1;
    senderStats[sender].lastUsed = item.savedAt;
  });
  
  // 발신자별 선호 상태 계산
  const senderRules = {};
  Object.entries(senderStats).forEach(([sender, stats]) => {
    if (stats.total >= 2) { // 최소 2회 이상 피드백
      const sortedStatuses = Object.entries(stats.statuses)
        .sort(([,a], [,b]) => b - a);
      if (sortedStatuses.length > 0) {
        senderRules[sender] = {
          preferredStatus: sortedStatuses[0][0],
          confidence: sortedStatuses[0][1] / stats.total,
          totalFeedback: stats.total
        };
      }
    }
  });
  
  return senderRules;
}

// 스마트 규칙 적용
function applySmartRules(message, feedback = {}) {
  const sender = emailAddress(message.from || '').toLowerCase();
  const senderRules = analyzeSenderPatterns(feedback);
  
  // 발신자별 규칙 적용
  if (senderRules[sender] && senderRules[sender].confidence >= 0.7) {
    return {
      status: senderRules[sender].preferredStatus,
      confidence: senderRules[sender].confidence,
      source: 'sender-pattern'
    };
  }
  
  // 도메인별 규칙 적용
  const domain = sender.split('@')[1] || '';
  const domainRules = Object.entries(senderRules)
    .filter(([s]) => s.endsWith(`@${domain}`))
    .reduce((acc, [, rule]) => {
      acc[rule.preferredStatus] = (acc[rule.preferredStatus] || 0) + rule.totalFeedback;
      return acc;
    }, {});
  
  const domainStatus = Object.entries(domainRules)
    .sort(([,a], [,b]) => b - a)[0];
  
  if (domainStatus && domainStatus[1] >= 3) {
    return {
      status: domainStatus[0],
      confidence: 0.6,
      source: 'domain-pattern'
    };
  }
  
  return null;
}

function mailboxPathForCurrentUser(messageId = '') {
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const encodedId = encodeURIComponent(messageId);
  return mailboxUser
    ? `/users/${encodeURIComponent(mailboxUser)}/messages/${encodedId}`
    : `/me/messages/${encodedId}`;
}

function mailboxBaseForCurrentUser() {
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  return mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : '/me';
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function resolvePath(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  return join(root, safePath === '/' ? 'index.html' : safePath);
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getConfigValue(key, envKey) {
  return runtimeConfig[key]?.trim() || process.env[envKey]?.trim() || '';
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function redirectUri(req) {
  const host = req.headers.host || `localhost:${port}`;
  return `http://${host}/auth/callback`;
}

function configStatus() {
  const hasToken = Boolean(getConfigValue('accessToken', 'OUTLOOK_GRAPH_ACCESS_TOKEN'));
  const hasAppCredentials = Boolean(
    getConfigValue('tenantId', 'MICROSOFT_TENANT_ID') &&
    getConfigValue('clientId', 'MICROSOFT_CLIENT_ID') &&
    getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET')
  );
  return {
    connected: hasToken || hasAppCredentials,
    authMode: hasToken ? 'access-token' : hasAppCredentials ? 'client-credentials' : 'not-configured',
    mailboxUser: getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER') || null,
    loginTenant: runtimeConfig.loginTenant || 'common',
    tenantId: getConfigValue('tenantId', 'MICROSOFT_TENANT_ID') || '',
    clientId: getConfigValue('clientId', 'MICROSOFT_CLIENT_ID') || '',
    geminiModel: runtimeConfig.geminiModel || 'gemini-2.5-flash',
    // AI Provider settings
    aiProvider: runtimeConfig.aiProvider || 'f-aios-v3',
    faiosServerUrl: runtimeConfig.faiosServerUrl || 'http://localhost:3201',
    lmstudioUrl: getLmStudioUrl(),
    lmstudioModel: runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b',
    hasAccessToken: hasToken,
    hasTenantId: Boolean(getConfigValue('tenantId', 'MICROSOFT_TENANT_ID')),
    hasClientId: Boolean(getConfigValue('clientId', 'MICROSOFT_CLIENT_ID')),
    hasClientSecret: Boolean(getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET')),
    hasGeminiApiKey: Boolean(getConfigValue('geminiApiKey', 'GEMINI_API_KEY')),
    // MiMo settings
    mimoModel: runtimeConfig.mimoModel || 'MiMo-V2.5',
    mimoBaseUrl: runtimeConfig.mimoBaseUrl || 'https://api.xiaomimimo.com/v1',
    hasMiMoApiKey: Boolean(runtimeConfig.mimoApiKey || getConfigValue('mimoApiKey', 'MIMO_API_KEY'))
  };
}

function stripHtml(value = '') {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|table|blockquote)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isPromotionalMessage(message) {
  const text = `${message.subject || ''} ${message.from?.emailAddress?.address || ''} ${message.bodyPreview || ''}`.toLowerCase();
  return /unsubscribe|수신거부|광고|newsletter|promotion|마케팅|이벤트|쿠폰|할인|webinar|세미나|광고성/.test(text);
}

function normalizeGraphMessage(message, mailFolder = 'inbox') {
  return {
    id: message.id,
    changeKey: message.changeKey || '',
    conversationId: message.conversationId || '',
    internetMessageId: message.internetMessageId || '',
    lastModifiedAt: message.lastModifiedDateTime || message.receivedDateTime || '',
    mailFolder,
    subject: message.subject || '(제목 없음)',
    from: message.from?.emailAddress?.address || message.sender?.emailAddress?.address || 'unknown',
    fromName: message.from?.emailAddress?.name || message.sender?.emailAddress?.name || '',
    to: (message.toRecipients || []).map((item) => item.emailAddress?.address).filter(Boolean),
    cc: (message.ccRecipients || []).map((item) => item.emailAddress?.address).filter(Boolean),
    receivedAt: message.receivedDateTime,
    importance: message.importance,
    isRead: message.isRead,
    hasAttachments: Boolean(message.hasAttachments),
    attachmentNames: [],
    isPromotional: isPromotionalMessage(message),
    bodyPreview: message.bodyPreview || '',
    body: stripHtml(message.body?.content || message.bodyPreview || ''),
    bodyHtml: message.body?.contentType === 'html' ? String(message.body?.content || '') : '',
    bodyContentType: message.body?.contentType || 'text',
    webLink: message.webLink
  };
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
}

function latestReceivedAt(messages) {
  return sortMessages(messages).find((message) => message.receivedAt)?.receivedAt || '';
}

function latestModifiedAt(messages) {
  const latest = [...messages]
    .sort((a, b) => new Date(b.lastModifiedAt || b.receivedAt || 0) - new Date(a.lastModifiedAt || a.receivedAt || 0))
    .find((message) => message.lastModifiedAt || message.receivedAt);
  return latest?.lastModifiedAt || latest?.receivedAt || '';
}

function sliceDisplayMessages(messages, top) {
  const requestedTop = Math.min(Math.max(Number(top) || 25, 1), 100);
  return sortMessages(messages).slice(0, requestedTop);
}

function mergeMessages(existingMessages, incomingMessages) {
  const byId = new Map();
  for (const message of existingMessages || []) {
    if (message?.id) byId.set(message.id, message);
  }
  let newCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  for (const message of incomingMessages || []) {
    if (!message?.id) continue;
    if (message.removed || message['@removed']) {
      if (byId.delete(message.id)) removedCount += 1;
      continue;
    }
    const previous = byId.get(message.id);
    if (!previous) {
      newCount += 1;
      byId.set(message.id, message);
    } else if (message.changeKey && previous.changeKey !== message.changeKey) {
      updatedCount += 1;
      byId.set(message.id, { ...previous, ...message });
    }
  }
  return {
    messages: sortMessages([...byId.values()]),
    newCount,
    updatedCount,
    removedCount
  };
}

async function readFeedbackContext() {
  const cache = await loadMailCache();
  const cacheKey = currentMailboxKey();
  const mailboxCache = cache.mailboxes[cacheKey] || {};
  const feedback = mailboxCache.feedback && typeof mailboxCache.feedback === 'object' ? mailboxCache.feedback : {};
  return { cache, cacheKey, mailboxCache, feedback };
}

async function saveClassificationFeedback(input) {
  const messageId = String(input.messageId || '').trim();
  const rawStatus = String(input.userStatus || '').trim().toLowerCase();
  const userStatus = FEEDBACK_STATUSES.has(rawStatus) ? rawStatus : '';
  const reasonCode = String(input.reasonCode || userStatus).trim();
  const note = compactText(input.note || '', 500);
  if (!messageId) {
    const error = new Error('messageId is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!FEEDBACK_STATUSES.has(userStatus)) {
    const error = new Error('userStatus must be one of urgent, active, waiting, done.');
    error.statusCode = 400;
    throw error;
  }

  const { cache, cacheKey, mailboxCache, feedback } = await readFeedbackContext();
  const messages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const message = messages.find((item) => item.id === messageId) || {};
  const saved = {
    messageId,
    userStatus,
    reasonCode: FEEDBACK_REASON_CODES.has(reasonCode) ? reasonCode : userStatus,
    reasonLabel: FEEDBACK_REASONS[reasonCode] || FEEDBACK_REASONS[userStatus],
    note,
    sender: emailAddress(message.from || input.sender || ''),
    subject: compactText(message.subject || input.subject || '', 180),
    subjectTokens: subjectTokens(message.subject || input.subject || ''),
    savedAt: new Date().toISOString()
  };

  cache.mailboxes[cacheKey] = {
    ...mailboxCache,
    feedback: {
      ...feedback,
      [messageId]: saved
    }
  };
  await saveMailCache(cache);
  return saved;
}

async function updateCachedMessage(messageId, patch) {
  const cache = await loadMailCache();
  const cacheKey = currentMailboxKey();
  const mailboxCache = cache.mailboxes[cacheKey] || {};
  const messages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const nextMessages = messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message));
  cache.mailboxes[cacheKey] = {
    ...mailboxCache,
    messages: nextMessages
  };
  await saveMailCache(cache);
  return nextMessages.find((message) => message.id === messageId) || null;
}

async function markOutlookMessageRead(messageId, isRead = true) {
  if (!messageId) {
    const error = new Error('messageId is required.');
    error.statusCode = 400;
    throw error;
  }
  const accessToken = await getGraphAccessToken();
  if (accessToken && !String(messageId).startsWith('demo-')) {
    const response = await fetch(`${graphBaseUrl}${mailboxPathForCurrentUser(messageId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ isRead })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Microsoft Graph mark read request failed: ${response.status} ${text}`);
    }
  }
  const message = await updateCachedMessage(messageId, { isRead });
  return { messageId, isRead, cached: Boolean(message), updatedAt: new Date().toISOString() };
}

function applyFeedbackToResult(result, messages, feedback = {}, options = {}) {
  const allowLearnedOverride = options.allowLearnedOverride !== false;
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageInsights = (result.messageInsights || []).map((insight) => {
    const message = messageById.get(insight.id) || insight;
    const exact = feedback[insight.id];
    if (exact && FEEDBACK_STATUSES.has(exact.userStatus)) {
      return {
        ...insight,
        userFeedback: exact,
        isOnHold: exact.reasonCode === 'hold',
        isSpamCandidate: Boolean(message.isPromotional),
        spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
        effectiveStatus: exact.userStatus,
        feedbackApplied: true
      };
    }
    const smartRule = allowLearnedOverride ? applySmartRules(message, feedback) : null;
    if (smartRule && FEEDBACK_STATUSES.has(smartRule.status)) {
      return {
        ...insight,
        feedbackHint: {
          userStatus: smartRule.status,
          reasonCode: smartRule.status,
          reasonLabel: FEEDBACK_REASONS[smartRule.status],
          score: smartRule.confidence,
          source: smartRule.source
        },
        isSpamCandidate: Boolean(message.isPromotional),
        spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
        effectiveStatus: smartRule.status
      };
    }
    const learned = allowLearnedOverride ? inferredFeedbackStatus(message, feedback) : null;
    if (learned) {
      return {
        ...insight,
        feedbackHint: {
          userStatus: learned.item.userStatus,
          reasonCode: learned.item.reasonCode,
          reasonLabel: learned.item.reasonLabel,
          score: learned.score
        },
        isSpamCandidate: Boolean(message.isPromotional),
        spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
        effectiveStatus: learned.item.userStatus
      };
    }
    return {
      ...insight,
      isSpamCandidate: Boolean(message.isPromotional),
      spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
      effectiveStatus: insight.effectiveStatus || normalizeAiStatus(insight.status)
    };
  });

  return {
    ...result,
    messageInsights,
    nextActions: (result.nextActions || []).map((action) => {
      const insight = messageInsights.find((item) => item.id === action.messageId);
      return insight ? { ...action, lane: insight.effectiveStatus === 'done' ? 'done' : action.lane } : action;
    })
  };
}

async function getGraphAccessToken() {
  const directToken = getConfigValue('accessToken', 'OUTLOOK_GRAPH_ACCESS_TOKEN');
  if (directToken && (!runtimeConfig.expiresAt || Date.now() < runtimeConfig.expiresAt - 60_000)) return directToken;

  if (runtimeConfig.refreshToken && runtimeConfig.clientId && runtimeConfig.tenantId) {
    const refreshParams = {
      client_id: runtimeConfig.clientId,
      grant_type: 'refresh_token',
      refresh_token: runtimeConfig.refreshToken,
      scope: delegatedScopes
    };
    if (runtimeConfig.clientSecret) {
      refreshParams.client_secret = runtimeConfig.clientSecret;
    }
    const body = new URLSearchParams(refreshParams);
    const response = await fetch(`https://login.microsoftonline.com/${runtimeConfig.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Microsoft refresh token request failed: ${response.status} ${text}`);
    }
    const payload = await response.json();
    runtimeConfig.accessToken = payload.access_token || '';
    runtimeConfig.refreshToken = payload.refresh_token || runtimeConfig.refreshToken;
    runtimeConfig.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return runtimeConfig.accessToken;
  }

  const tenantId = getConfigValue('tenantId', 'MICROSOFT_TENANT_ID');
  const clientId = getConfigValue('clientId', 'MICROSOFT_CLIENT_ID');
  const clientSecret = getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Microsoft token request failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function fetchGraphMessages({ accessToken, mailboxPath, top, modifiedSince, initialSync = false, mailFolder = 'inbox' }) {
  const pageSize = Math.min(Math.max(Number(process.env.MAIL_GRAPH_PAGE_SIZE || 100), 10), 500);
  const maxPages = Math.max(1, Number(process.env.MAIL_GRAPH_MAX_PAGES || (initialSync ? 100 : 20)));
  const params = new URLSearchParams({
    '$top': String(pageSize),
    '$select': 'id,changeKey,conversationId,internetMessageId,lastModifiedDateTime,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,importance,isRead,hasAttachments,bodyPreview,body,webLink'
  });
  if (initialSync) {
    params.set('$orderby', 'receivedDateTime desc');
  }
  if (!initialSync && modifiedSince) {
    const sinceDate = new Date(modifiedSince);
    if (!Number.isNaN(sinceDate.getTime())) {
      params.set('$filter', `lastModifiedDateTime ge ${sinceDate.toISOString()}`);
    }
  }

  let nextUrl = `${graphBaseUrl}${mailboxPath}?${params}`;
  const messages = [];
  let pageCount = 0;

  while (nextUrl && pageCount < maxPages) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Microsoft Graph messages request failed: ${response.status} ${text}`);
    }

    const payload = await response.json();
    messages.push(...(payload.value || []).map((item) => normalizeGraphMessage(item, mailFolder)));
    nextUrl = payload['@odata.nextLink'] || '';
    pageCount += 1;

    if (!initialSync && messages.length >= Math.max(top * 4, pageSize)) break;
  }

  return messages;
}

async function loadCachedMailbox(top = 25) {
  const status = configStatus();
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const cacheKey = mailboxCacheKey(mailboxUser);
  const cache = await loadMailCache();
  const mailboxCache = cache.mailboxes[cacheKey] || { messages: [], lastSyncedAt: '', lastReceivedAt: '' };
  const allMessages = sortMessages(Array.isArray(mailboxCache.messages) ? mailboxCache.messages : []);
  const messages = sliceDisplayMessages(allMessages, top);

  return {
    connected: status.connected,
    mode: mailboxUser ? 'application-mailbox' : status.connected ? 'delegated-me' : 'not-configured',
    message: messages.length ? 'Loaded from local mail cache.' : 'Local mail cache is empty.',
    messages,
    sync: {
      mailbox: cacheKey,
      mode: 'cache',
      totalCached: allMessages.length,
      lastSyncedAt: mailboxCache.lastSyncedAt || null
    }
  };
}

async function fetchOutlookMessages(top = 25, { forceInitial = false } = {}) {
  const accessToken = await getGraphAccessToken();
  if (!accessToken) {
    return {
      connected: false,
      mode: 'error',
      message: 'Microsoft Graph credentials are not configured. Please configure Outlook integration in settings.',
      messages: []
    };
  }

  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const mailboxBase = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : '/me';
  const folderTargets = [
    { mailFolder: 'inbox', mailboxPath: `${mailboxBase}/mailFolders/inbox/messages` },
    { mailFolder: 'sentitems', mailboxPath: `${mailboxBase}/mailFolders/sentitems/messages` }
  ];
  const cache = await loadMailCache();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const mailboxCache = cache.mailboxes[cacheKey] || { messages: [], lastSyncedAt: '', lastReceivedAt: '' };
  const cachedMessages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const requestedTop = Math.min(Math.max(top, 1), 100);
  const isInitialSync = forceInitial || cachedMessages.length === 0;
  const modifiedSince = isInitialSync ? '' : (mailboxCache.lastModifiedAt || latestModifiedAt(cachedMessages) || '');
  const incomingMessages = [];
  let deltaUsed = false;
  for (const folder of folderTargets) {
    const alwaysRecentSent = folder.mailFolder === 'sentitems' && !isInitialSync;
    if (folder.mailFolder === 'inbox' && !isInitialSync && mailboxCache.deltaLink) {
      const deltaExpired = mailboxCache.deltaLinkExpires && new Date(mailboxCache.deltaLinkExpires).getTime() < Date.now();
      if (deltaExpired) {
        console.warn('Delta link expired, clearing and falling back to incremental sync.');
        mailboxCache.deltaLink = null;
        mailboxCache.deltaLinkExpires = null;
      } else {
        try {
          const deltaResult = await runDeltaSync({
            accessToken,
            mailboxBase,
            mailFolder: 'inbox',
            deltaLink: mailboxCache.deltaLink,
            normalizeMessage: normalizeGraphMessage,
            maxPages: Number(process.env.MAIL_DELTA_MAX_PAGES || 10)
          });
          incomingMessages.push(...deltaResult.messages);
          if (deltaResult.deltaLink && deltaResult.deltaLink !== mailboxCache.deltaLink) {
            mailboxCache.deltaLink = deltaResult.deltaLink;
            mailboxCache.deltaLinkExpires = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();
          } else {
            mailboxCache.deltaLink = deltaResult.deltaLink || mailboxCache.deltaLink;
          }
          deltaUsed = true;
          continue;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn('Delta sync failed, falling back:', errorMsg);
          if (/400|401|403|404|410/.test(errorMsg) || /expired|invalid/i.test(errorMsg)) {
            mailboxCache.deltaLink = null;
            mailboxCache.deltaLinkExpires = null;
            console.warn('Delta link cleared due to persistent error; next sync will re-seed.');
          }
        }
      }
    }
    const folderMessages = await fetchGraphMessages({
      accessToken,
      mailboxPath: folder.mailboxPath,
      top: requestedTop,
      modifiedSince: alwaysRecentSent ? '' : modifiedSince,
      initialSync: alwaysRecentSent ? true : isInitialSync,
      mailFolder: folder.mailFolder
    });
    incomingMessages.push(...folderMessages);
  }
  const merged = mergeMessages(cachedMessages, incomingMessages);
  if (!mailboxCache.deltaLink && isInitialSync) {
    try {
      const seed = await runDeltaSync({
        accessToken,
        mailboxBase,
        mailFolder: 'inbox',
        deltaLink: '',
        normalizeMessage: normalizeGraphMessage,
        maxPages: 1
      });
      if (seed.deltaLink) {
        mailboxCache.deltaLink = seed.deltaLink;
        // Graph delta links expire ~30 days from creation; record 25-day safety window.
        mailboxCache.deltaLinkExpires = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();
      }
    } catch {
      // Delta seed optional on first run.
    }
  }
  cache.mailboxes[cacheKey] = {
    ...mailboxCache,
    messages: merged.messages,
    lastSyncedAt: new Date().toISOString(),
    lastReceivedAt: latestReceivedAt(merged.messages),
    lastModifiedAt: latestModifiedAt(merged.messages),
    deltaLink: mailboxCache.deltaLink || null,
    deltaLinkExpires: mailboxCache.deltaLinkExpires || null
  };
  await saveMailCache(cache);

  return {
    connected: true,
    mode: mailboxUser ? 'application-mailbox' : 'delegated-me',
    message: isInitialSync
      ? 'Outlook inbox loaded from Microsoft Graph.'
      : 'Outlook inbox incrementally synced from Microsoft Graph.',
    messages: sliceDisplayMessages(merged.messages, requestedTop),
    sync: {
      mailbox: cacheKey,
      mode: deltaUsed ? 'delta' : isInitialSync ? 'initial' : 'incremental',
      requestedAfter: modifiedSince || null,
      fetchedFromGraph: incomingMessages.length,
      cachedBefore: cachedMessages.length,
      newCount: merged.newCount,
      updatedCount: merged.updatedCount,
      removedCount: merged.removedCount,
      totalCached: merged.messages.length,
      lastSyncedAt: cache.mailboxes[cacheKey].lastSyncedAt,
      deltaLink: Boolean(cache.mailboxes[cacheKey].deltaLink)
    }
  };
}

async function sendOutlookMail({ to, cc = '', subject, body }) {
  const recipients = String(to || '')
    .split(/[;,]/)
    .map((address) => emailAddress(address))
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  const ccRecipients = String(cc || '')
    .split(/[;,]/)
    .map((address) => emailAddress(address))
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
  if (!recipients.length) throw new Error('받는 사람 이메일이 필요합니다.');
  if (!String(subject || '').trim()) throw new Error('메일 제목이 필요합니다.');
  if (!String(body || '').trim()) throw new Error('메일 본문이 필요합니다.');
  const accessToken = await getGraphAccessToken();
  if (!accessToken) {
    throw new Error('Microsoft Graph credentials are not configured.');
  }

  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const sendPath = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}/sendMail` : '/me/sendMail';
  const response = await fetch(`${graphBaseUrl}${sendPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        subject: String(subject).trim(),
        body: {
          contentType: 'Text',
          content: String(body).trim()
        },
        toRecipients: recipients,
        ccRecipients
      },
      saveToSentItems: true
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Microsoft Graph sendMail request failed: ${response.status} ${text}`);
  }
  return { sent: true, savedToSentItems: true, sentAt: new Date().toISOString() };
}

async function loadAttachmentArchive() {
  const [archive, meta] = await Promise.all([
    readJsonFile(attachmentArchivePath, { version: 1, entries: [] }),
    readJsonFile(attachmentArchiveMetaPath, { version: 1, tagsByEntryId: {} })
  ]);
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const accountEmail = (mailboxUser || '').toLowerCase();
  const entries = Array.isArray(archive.entries) ? archive.entries : [];
  const filtered = accountEmail
    ? entries.filter((entry) => String(entry.accountEmail || '').toLowerCase() === accountEmail)
    : entries;
  const enriched = filtered
    .map((entry) => ({
      ...entry,
      tags: meta.tagsByEntryId?.[entry.id]?.userTags || [],
      aiTags: meta.tagsByEntryId?.[entry.id]?.aiTags || []
    }))
    .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));

  return {
    entries: enriched,
    counts: {
      total: enriched.length,
      downloadable: enriched.filter((entry) => entry.hasDownload).length,
      byCategory: enriched.reduce((acc, entry) => {
        const key = entry.category || 'other';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    }
  };
}

async function syncOutlookAttachmentArchive(top = 10) {
  let accessToken;
  try {
    accessToken = await getGraphAccessToken();
  } catch (authError) {
    const msg = authError instanceof Error ? authError.message : '';
    const code = /invalid_client/i.test(msg) ? 'invalid_client'
      : /refresh/i.test(msg) ? 'refresh_failed'
        : 'auth_error';
    const error = new Error(msg || 'Microsoft Graph 인증 실패');
    error.statusCode = 401;
    error.structuredError = {
      code,
      retryable: code !== 'invalid_client',
      action: code === 'invalid_client'
        ? 'Microsoft App Registration의 client secret value를 재설정하세요. (client secret ID가 아닌 value를 사용해야 합니다)'
        : code === 'refresh_failed'
          ? 'refresh token이 만료되었습니다. Outlook 재로그인이 필요합니다.'
          : 'Microsoft Graph 인증 설정을 확인하세요.'
    };
    throw error;
  }
  if (!accessToken) {
    const error = new Error('Microsoft Graph credentials are not configured.');
    error.statusCode = 503;
    error.structuredError = {
      code: 'not_configured',
      retryable: false,
      action: 'Outlook 연결 설정에서 Client ID, Tenant ID, Client Secret을 입력하세요.'
    };
    throw error;
  }

  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const cache = await loadMailCache();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const messages = sortMessages(cache.mailboxes[cacheKey]?.messages || []);
  const archive = await readJsonFile(attachmentArchivePath, { version: 1, entries: [] });
  const result = await syncAttachmentsFromMessages({
    messages,
    accessToken,
    graphBaseUrl,
    mailboxPath: mailboxBaseForCurrentUser(),
    accountEmail: mailboxUser,
    archive,
    top: Math.min(Math.max(top, 1), 25)
  });
  await writeJsonFile(attachmentArchivePath, result.archive);
  return {
    added: result.added,
    skippedDuplicates: result.skippedDuplicates,
    scannedMessages: result.scannedMessages,
    scannedAttachments: result.scannedAttachments,
    total: result.archive.entries.length
  };
}

function findRelatedMessages(mailboxMessages, message) {
  if (!message) return [];
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const groups = groupMessagesByThread(mailboxMessages, { mailboxUser });
  for (const thread of groups.values()) {
    if (thread.some((item) => item.id === message.id)) return thread;
  }
  return [message];
}

function findSenderHistory(mailboxMessages, message) {
  if (!message) return { received: [], sent: [] };
  const senderEmail = emailAddress(message.from || '').toLowerCase();
  const senderDomain = senderEmail.split('@')[1] || '';
  const received = mailboxMessages
    .filter((item) =>
      item.id !== message.id &&
      item.mailFolder !== 'sentitems' &&
      emailAddress(item.from || '').toLowerCase() === senderEmail
    )
    .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0))
    .slice(0, 5);
  const sent = mailboxMessages
    .filter((item) =>
      item.mailFolder === 'sentitems' &&
      (item.to || []).some((toAddr) => {
        const toEmail = typeof toAddr === 'string' ? emailAddress(toAddr) : emailAddress(toAddr?.emailAddress?.address || toAddr?.address || '');
        return toEmail.toLowerCase() === senderEmail || (senderDomain && toEmail.toLowerCase().endsWith(`@${senderDomain}`));
      })
    )
    .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0))
    .slice(0, 3);
  return { received, sent };
}

function buildReplyDraftPrompt({ message, relatedMessages, attachmentEntries, senderHistory }) {
  const recentThread = relatedMessages
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      folder: item.mailFolder || 'inbox',
      from: item.fromName || item.from,
      to: item.to || [],
      receivedAt: item.receivedAt,
      subject: item.subject,
      body: clip(item.body || item.bodyPreview, 600)
    }));
  const attachmentContext = attachmentEntries.slice(0, 8).map((entry) => ({
    name: entry.name,
    category: entry.categoryLabel,
    subject: entry.subject,
    from: entry.fromName || entry.from,
    tags: [...(entry.tags || []), ...(entry.aiTags || [])].slice(0, 6)
  }));
  const senderReceivedContext = (senderHistory?.received || []).map((item) => ({
    id: item.id,
    from: item.fromName || item.from,
    receivedAt: item.receivedAt,
    subject: item.subject,
    body: clip(item.body || item.bodyPreview, 400)
  }));
  const senderSentContext = (senderHistory?.sent || []).map((item) => ({
    id: item.id,
    to: item.to || [],
    receivedAt: item.receivedAt,
    subject: item.subject,
    body: clip(item.body || item.bodyPreview, 400)
  }));

  return `Return ONLY valid JSON. No markdown.

You are drafting Korean business email reply options for the selected message.
Use the mailbox history and past sent emails as style/context evidence.
Do not invent promises, dates, attachments, or technical facts not grounded in the context.
If something is missing, ask for it briefly.
Generate exactly 3 reply options with different tones: formal (격식체), casual (비격식체), brief (간결체).

Required JSON shape:
{
  "to": "recipient email",
  "cc": "",
  "options": [
    { "tone": "formal", "subject": "reply subject", "body": "full formal Korean email", "label": "격식체" },
    { "tone": "casual", "subject": "reply subject", "body": "casual Korean email", "label": "비격식체" },
    { "tone": "brief", "subject": "reply subject", "body": "brief 2-3 sentence email", "label": "간결체" }
  ],
  "reasoning": "short Korean explanation",
  "recommendedAttachments": ["attachment names or document hints"],
  "sourceEvidence": ["evidence sources used"],
  "confidence": "low|medium|high",
  "requiresHumanCheck": false
}

Selected message:
${JSON.stringify({
    id: message.id,
    from: message.fromName || message.from,
    to: message.to || [],
    cc: message.cc || [],
    receivedAt: message.receivedAt,
    subject: message.subject,
    body: clip(message.body || message.bodyPreview, 1000)
  }, null, 2)}

Related thread and past mailbox history:
${JSON.stringify(recentThread, null, 2)}

Same sender's past received emails (for context and style):
${JSON.stringify(senderReceivedContext, null, 2)}

Past emails sent to this sender/domain (for tone matching):
${JSON.stringify(senderSentContext, null, 2)}

Possible attachment references:
${JSON.stringify(attachmentContext, null, 2)}`;
}

async function callLmStudioReplyDraft(prompt) {
  const model = runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
  const response = await fetch(`${getLmStudioUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens: 1400,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'mail_reply_draft',
          schema: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              cc: { type: 'string' },
              subject: { type: 'string' },
              body: { type: 'string' },
              reasoning: { type: 'string' },
              recommendedAttachments: { type: 'array', items: { type: 'string' } },
              sourceEvidence: { type: 'array', items: { type: 'string' } },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              requiresHumanCheck: { type: 'boolean' }
            },
            required: ['to', 'cc', 'subject', 'body', 'reasoning', 'recommendedAttachments']
          }
        }
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM Studio reply draft error: ${response.status} ${text}`);
  }

  const payload = await response.json();
  return extractJson(payload.choices?.[0]?.message?.content || '');
}

function buildFallbackReplyDraft(message, relatedMessages, attachmentEntries) {
  const recentSent = relatedMessages.find((item) =>
    ['sentitems', 'sent'].includes(String(item.mailFolder || '').toLowerCase())
  );
  const senderName = message.fromName || '담당자';
  const attachmentHints = attachmentEntries.slice(0, 3).map((entry) => entry.name);
  return {
    to: emailAddress(message.from || ''),
    cc: '',
    subject: replySubject(message.subject || ''),
    body: [
      `안녕하세요, ${senderName}님.`,
      '',
      '메일 내용 확인했습니다.',
      '',
      recentSent?.body
        ? `이전 회신 이력을 참고해 동일한 흐름으로 정리하겠습니다.\n- ${compactText(recentSent.body, 180)}`
        : '요청하신 내용 기준으로 필요한 확인 사항과 진행 일정을 정리해 회신드립니다.',
      '',
      '추가로 필요한 자료나 확인 항목이 있으면 회신 부탁드립니다.',
      '',
      '감사합니다.'
    ].join('\n'),
    reasoning: '로컬 메일 캐시의 동일 스레드/발신 이력을 기준으로 기본 회신 초안을 구성했습니다.',
    recommendedAttachments: attachmentHints.length ? attachmentHints : ['관련 제안서/매뉴얼/기존 발송자료 확인'],
    sourceEvidence: [
      recentSent?.body ? 'same thread sent history' : 'thread subject match',
      ...(attachmentHints.length ? [`attachment archive: ${attachmentHints[0]}`] : [])
    ],
    confidence: 'low',
    requiresHumanCheck: true
  };
}

async function generateReplyDraft(messageId, { tone } = {}) {
  const { mailboxCache } = await readFeedbackContext();
  const mailboxMessages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const message = mailboxMessages.find((item) => item.id === messageId);
  if (!message) {
    const error = new Error('선택한 메일을 캐시에서 찾지 못했습니다.');
    error.statusCode = 404;
    throw error;
  }

  const relatedMessages = findRelatedMessages(mailboxMessages, message);
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const threadReplied = userRepliedInThread(relatedMessages, mailboxUser);
  const { entries } = await loadAttachmentArchive();
  const attachmentEntries = entries.filter((entry) => {
    if (entry.messageId === message.id) return true;
    if (message.conversationId && entry.subject && normalizedSubjectKey(entry.subject) === normalizedSubjectKey(message.subject)) return true;
    return String(entry.subject || '').trim() === String(message.subject || '').trim();
  });

  const senderHistory = findSenderHistory(mailboxMessages, message);
  const evidenceSources = [];

  try {
    const prompt = buildReplyDraftPrompt({ message, relatedMessages, attachmentEntries, senderHistory });
    const draft = await callLmStudioReplyDraft(prompt);
    if (senderHistory.received.length) evidenceSources.push(`sender past received: ${senderHistory.received.length}건`);
    if (senderHistory.sent.length) evidenceSources.push(`past sent to sender: ${senderHistory.sent.length}건`);
    // Select option by tone or sender preference
    const tonePreferences = mailboxCache.tonePreferences || {};
    const senderEmail = emailAddress(message.from || '').toLowerCase();
    const preferredTone = tone || tonePreferences[senderEmail]?.preferredTone || 'formal';
    const options = Array.isArray(draft.options) ? draft.options : [];
    const selected = options.find((opt) => opt.tone === preferredTone) || options[0] || {};

    return {
      ...draft,
      ...selected,
      options,
      selectedTone: selected.tone || preferredTone,
      messageId,
      source: 'lmstudio',
      relatedCount: relatedMessages.length,
      senderReceivedCount: senderHistory.received.length,
      senderSentCount: senderHistory.sent.length,
      sourceEvidence: draft.sourceEvidence || evidenceSources,
      confidence: draft.confidence || (threadReplied ? 'medium' : 'high'),
      requiresHumanCheck: draft.requiresHumanCheck ?? false,
      threadReplied,
      threadNote: threadReplied ? '이 스레드에는 이미 보낸편지함 회신이 있습니다.' : ''
    };
  } catch (error) {
    return {
      ...buildFallbackReplyDraft(message, relatedMessages, attachmentEntries),
      messageId,
      source: 'fallback',
      warning: error instanceof Error ? error.message : 'LM Studio draft generation failed.',
      relatedCount: relatedMessages.length,
      senderReceivedCount: senderHistory.received.length,
      senderSentCount: senderHistory.sent.length,
      threadReplied,
      threadNote: threadReplied ? '이 스레드에는 이미 보낸편지함 회신이 있습니다.' : ''
    };
  }
}

function clip(value = '', max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI returned empty response.');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`AI response did not contain JSON. Response: ${raw.slice(0, 200)}`);
    try {
      return JSON.parse(match[0]);
    } catch {
      // Try to fix common JSON errors (trailing commas, unclosed arrays)
      let fixed = match[0]
        .replace(/,\s*([}\]])/g, '$1')  // Remove trailing commas
        .replace(/"\s*\n\s*"/g, '","')  // Fix missing commas between strings
        .replace(/]\s*\n\s*"/g, '],"')  // Fix missing commas after arrays
        .replace(/}\s*\n\s*"/g, '},"')  // Fix missing commas after objects
        .replace(/,\s*,/g, ',')         // Remove double commas
        .replace(/\[\s*,/g, '[')        // Remove leading commas in arrays
        .replace(/,\s*\]/g, ']');       // Remove trailing commas in arrays
      return JSON.parse(fixed);
    }
  }
}

function normalizeAiStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['urgent', '긴급'].includes(value)) return 'urgent';
  if (['waiting', '대기'].includes(value)) return 'waiting';
  if (['done', 'complete', 'completed', '완료'].includes(value)) return 'done';
  if (['reference', '참고', 'none'].includes(value)) return 'reference';
  return 'active';
}

function analysisCacheKey(message, model) {
  return [message.id, message.changeKey || message.receivedAt || '', model].join('::');
}

function replySubject(subject = '') {
  return /^re:/i.test(subject) ? subject : `RE: ${subject || '(제목 없음)'}`;
}

function normalizeActionScenarios(message, actions = [], summaries = []) {
  const recipient = emailAddress(message.from || '');
  const subject = replySubject(message.subject);
  const text = `${message.subject || ''} ${message.body || message.bodyPreview || ''}`.toLowerCase();
  const summaryLines = (summaries.length ? summaries : [message.bodyPreview || message.subject || '메일 내용을 확인했습니다.'])
    .slice(0, 3)
    .map((item) => `- ${item}`)
    .join('\n');
  const base = actions.length ? actions : [];
  const primaryLane = normalizeAiStatus(base[0]?.lane || 'active');
  const hasAttachmentContext = Boolean(message.hasAttachments || message.attachmentNames?.length);
  const asksForInfo = /문의|확인|요청|부탁|가능|견적|회신|질문|검토/.test(text);
  const hasDateContext = Boolean(base[0]?.due || /오늘|내일|금일|이번 주|다음 주|\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(text));
  const scenarioDefaults = [
    {
      title: primaryLane === 'urgent' ? '긴급 우선 회신' : asksForInfo ? '요청 사항 확인 회신' : '진행 상태 공유',
      intent: '요청을 접수하고 우리가 진행할 다음 단계를 명확히 알립니다.',
      recommendedAction: base[0]?.recommendedAction || '요청 사항을 확인하고 처리 예정 일정을 회신',
      lane: primaryLane,
      priority: Number(base[0]?.priority || 3),
      evidence: base[0]?.evidence || summaries[0] || message.bodyPreview || '',
      body: `안녕하세요.\n\n메일 내용 확인했습니다.\n\n핵심 내용은 아래와 같이 이해했습니다.\n${summaryLines}\n\n저희 쪽 다음 액션은 다음과 같습니다.\n- ${base[0]?.recommendedAction || '요청사항을 검토 후 진행 가능 여부와 일정을 회신드리겠습니다.'}\n\n확인 후 진행 상황을 업데이트드리겠습니다.\n\n감사합니다.`
    },
    {
      title: hasDateContext ? '일정/범위 재확인' : '추가 정보 요청',
      intent: '판단에 필요한 정보가 부족할 때 누락 정보를 요청합니다.',
      recommendedAction: base[1]?.recommendedAction || (hasDateContext ? '마감 시점, 적용 범위, 우선순위를 다시 확인' : '진행 전 필요한 조건, 일정, 담당자, 범위를 추가 확인'),
      lane: normalizeAiStatus(base[1]?.lane || 'waiting'),
      priority: Number(base[1]?.priority || 4),
      evidence: base[1]?.evidence || base[0]?.evidence || '',
      body: `안녕하세요.\n\n메일 내용 확인했습니다. 정확히 진행하기 위해 아래 사항을 추가로 확인 부탁드립니다.\n\n1. 요청 범위 또는 대상 시스템\n2. 희망 일정 및 마감 시점\n3. 관련 담당자 또는 승인 필요 여부\n\n현재 확인한 내용:\n${summaryLines}\n\n확인 주시면 그 기준으로 다음 단계 진행하겠습니다.\n\n감사합니다.`
    },
    {
      title: hasAttachmentContext ? '첨부자료 기준 회신' : '자료 공유 및 미팅 제안',
      intent: 'Sangfor 자료, 메뉴얼, 관련 문서를 근거로 공유하거나 설명 일정을 제안합니다.',
      recommendedAction: base[2]?.recommendedAction || (hasAttachmentContext ? '첨부파일과 기존 발송자료를 기준으로 필요한 파일만 선별해 회신' : 'Sangfor 관련 자료 확인 후 공유하고 필요 시 설명 미팅 제안'),
      lane: normalizeAiStatus(base[2]?.lane || 'active'),
      priority: Number(base[2]?.priority || 4),
      evidence: base[2]?.evidence || (hasAttachmentContext ? '기존 첨부파일과 과거 발송자료를 우선 확인하세요.' : 'Sangfor 제품 페이지, 메뉴얼, 기존 발송자료, 관련 제안 문서를 확인해 첨부/링크를 확정하세요.'),
      body: hasAttachmentContext
        ? `안녕하세요.\n\n관련 첨부파일과 기존 발송자료를 기준으로 필요한 문서만 정리해 공유드리겠습니다.\n\n메일에서 확인한 핵심 내용:\n${summaryLines}\n\n파일 버전과 전달 범위를 확인한 뒤 다시 회신드리겠습니다.\n\n감사합니다.`
        : `안녕하세요.\n\n문의 주신 내용과 관련해 Sangfor 자료 및 관련 문서를 확인한 뒤 공유드리겠습니다.\n\n우선 확인할 자료 범위는 아래와 같습니다.\n- Sangfor 제품/기능 소개 페이지\n- 구축 또는 운영 메뉴얼\n- 기존 발송자료 및 관련 제안 문서\n\n메일에서 확인한 핵심 내용:\n${summaryLines}\n\n자료 확인 후 필요 시 짧은 설명 미팅도 함께 제안드리겠습니다.\n\n감사합니다.`
    }
  ];

  return scenarioDefaults.map((item, index) => ({
    id: `scenario-${index + 1}-${message.id}`,
    scenario: index + 1,
    title: item.title,
    intent: base[index]?.intent || item.intent,
    owner: base[index]?.owner || '미지정',
    due: base[index]?.due || '',
    recommendedAction: base[index]?.recommendedAction || item.recommendedAction,
    lane: item.lane === 'reference' ? 'active' : item.lane,
    priority: item.priority,
    evidence: base[index]?.evidence || item.evidence,
    subject: message.subject,
    messageId: message.id,
    receivedAt: message.receivedAt,
    webLink: message.webLink,
    to: base[index]?.to || recipient,
    mailSubject: base[index]?.subject || subject,
    body: base[index]?.body || item.body
  }));
}

async function callProviderPrompt(prompt, { maxTokens = 1800, timeoutMs = 25000 } = {}) {
  const provider = runtimeConfig.aiProvider || 'f-aios-v3';
  if (provider === 'f-aios-v3') {
    try {
      return { aiText: await callFaiosServer(prompt), provider };
    } catch (error) {
      return { aiText: await callLmStudioGeneric(prompt, { maxTokens, timeoutMs }), provider: 'lmstudio-fallback' };
    }
  }
  if (provider === 'gemini') {
    return { aiText: await callGeminiApi(prompt), provider };
  }
  if (provider === 'mimo') {
    return { aiText: await callMiMoApi(prompt, { maxTokens, timeoutMs }), provider };
  }
  return { aiText: await callLmStudioGeneric(prompt, { maxTokens, timeoutMs }), provider };
}

async function enrichWithThreadGrouping(messages) {
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const cache = await loadMailCache();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const mailboxCache = cache.mailboxes[cacheKey] || { messages: [] };
  const cachedById = new Map((mailboxCache.messages || []).map((message) => [message.id, message]));

  let working = messages.map((message) => ({
    ...message,
    mailFolder: message.mailFolder || cachedById.get(message.id)?.mailFolder || 'inbox',
    aiGroupKey: message.aiGroupKey || cachedById.get(message.id)?.aiGroupKey || '',
    aiGroupSource: message.aiGroupSource || cachedById.get(message.id)?.aiGroupSource || ''
  }));

  const needsAi = messagesNeedingAiGrouping(working, cachedById);
  const batchLimit = Math.min(Math.max(Number(process.env.MAIL_AI_THREAD_GROUP_LIMIT || 24), 4), 40);
  const batch = needsAi.slice(0, batchLimit);
  let threadGrouping = { enabled: false, provider: 'rules', grouped: 0, threadCount: 0 };

  if (batch.length >= 2) {
    try {
      const prompt = buildThreadGroupingPrompt(batch);
      const { aiText, provider } = await callProviderPrompt(prompt, { maxTokens: 2400, timeoutMs: 45000 });
      const threads = parseThreadGroupingResponse(aiText);
      const assignments = assignmentsFromThreads(threads);
      working = applyAssignments(working, assignments);
      threadGrouping = {
        enabled: true,
        provider,
        grouped: assignments.size,
        threadCount: threads.length
      };
    } catch (error) {
      threadGrouping = {
        enabled: false,
        provider: runtimeConfig.aiProvider || 'rules',
        error: error instanceof Error ? error.message : 'Thread grouping failed'
      };
    }
  }

  working = applyRuleBasedGroupKeys(working, { mailboxUser });
  working = unifyGroupKeysBySubject(working);

  const patchById = new Map(working.map((message) => [message.id, message]));
  const fullCacheMessages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const patchedAll = sortMessages(
    fullCacheMessages.map((message) => {
      const patch = patchById.get(message.id);
      if (!patch) return message;
      return {
        ...message,
        mailFolder: patch.mailFolder || message.mailFolder,
        aiGroupKey: patch.aiGroupKey,
        aiGroupSource: patch.aiGroupSource
      };
    })
  );
  for (const message of working) {
    if (!patchedAll.some((item) => item.id === message.id)) patchedAll.push(message);
  }

  cache.mailboxes[cacheKey] = { ...mailboxCache, messages: patchedAll };
  await saveMailCache(cache);

  const threadGroups = summarizeThreadGroups(working, { mailboxUser });
  return { messages: working, threadGroups, threadGrouping };
}

async function enrichWithAI(messages, result) {
  const provider = runtimeConfig.aiProvider || 'f-aios-v3';
  const modelName = getModelName(provider);
  if (messages.length === 0) return { ...result, ai: { enabled: false, provider: 'rules' } };
  
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const cache = await loadMailCache();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const mailboxCache = cache.mailboxes[cacheKey] || { messages: [], analysis: {} };
  const analysisCache = mailboxCache.analysis && typeof mailboxCache.analysis === 'object' ? mailboxCache.analysis : {};
  const feedback = mailboxCache.feedback && typeof mailboxCache.feedback === 'object' ? mailboxCache.feedback : {};
  const feedbackExamples = feedbackForPrompt(feedback);
  const cachedById = new Map();
  const messagesForAi = [];
  
  // 캐시된 분석 결과 사용
  for (const message of messages) {
    const cached = analysisCache[analysisCacheKey(message, modelName)];
    if (cached) {
      cachedById.set(message.id, cached);
    } else {
      messagesForAi.push(message);
    }
  }
  
  if (messagesForAi.length === 0) {
    const cachedInsights = result.messageInsights.map((insight) => {
      const cached = cachedById.get(insight.id);
      const message = messages.find((item) => item.id === insight.id) || insight;
      return cached
        ? {
          ...insight,
          ...cached,
          nextActions: normalizeActionScenarios(message, cached.nextActions || insight.nextActions, cached.summary || insight.summary),
          aiEnhanced: true,
          aiCached: true,
          urgency: (() => {
            const smartRule = applySmartRules(message, feedback);
            const feedbackStatus = feedback[insight.id]?.userStatus || null;
            return urgencyScore(cached.urgency, smartRule?.confidence, feedbackStatus);
          })()
        }
        : insight;
    });
    return {
      ...result,
      messageInsights: cachedInsights,
      nextActions: cachedInsights.flatMap((insight) => insight.nextActions || []).sort((a, b) => a.priority - b.priority),
      reminders: cachedInsights
        .flatMap((insight) => insight.nextActions || [])
        .filter((action) => action.lane === 'urgent' || action.due)
        .map((action) => ({
          title: action.recommendedAction,
          reason: action.evidence,
          owner: action.owner,
          subject: action.subject,
          messageId: action.messageId,
          receivedAt: action.receivedAt,
          webLink: action.webLink
        })),
      ai: { enabled: true, provider, model: modelName, cached: messages.length }
    };
  }
  
  const maxAiMessages = Math.max(1, Math.min(Number(process.env.MAIL_AI_ANALYSIS_LIMIT || 3), 10));
  const requestMessages = messagesForAi.slice(0, maxAiMessages);
  const prompt = provider === 'lmstudio'
    ? buildLmStudioAnalysisPrompt(feedbackExamples, requestMessages)
    : buildAnalysisPrompt(feedbackExamples, requestMessages);
  let aiText = '';
  
  try {
    if (provider === 'f-aios-v3') {
      aiText = await callFaiosServer(prompt);
    } else if (provider === 'gemini') {
      aiText = await callGeminiApi(prompt);
    } else if (provider === 'mimo') {
      aiText = await callMiMoApi(prompt, { maxTokens: 2000, timeoutMs: 120000 });
    } else {
      aiText = await callLmStudio(prompt);
    }
  } catch (error) {
    // F-AIOS-v3 실패 시 LM Studio로 폴백
    if (provider === 'f-aios-v3') {
      try {
        aiText = await callLmStudio(prompt);
        console.log('F-AIOS-v3 fallback to LM Studio succeeded');
      } catch (fallbackError) {
        throw new Error(`AI analysis failed: ${error.message}. Fallback also failed: ${fallbackError.message}`);
      }
    } else {
      throw error;
    }
  }
  const ai = extractJson(aiText);
  const byId = new Map((ai.messages || []).map((item) => [item.id, item]));
  const aiMessageIds = new Set(requestMessages.map((message) => message.id));
  const enhancedInsights = result.messageInsights.map((insight) => {
    const message = messages.find((item) => item.id === insight.id) || insight;
    const cachedInsight = cachedById.get(insight.id);
    if (cachedInsight) {
      return {
        ...insight,
        ...cachedInsight,
        nextActions: normalizeActionScenarios(message, cachedInsight.nextActions || insight.nextActions, cachedInsight.summary || insight.summary),
        aiEnhanced: true,
        aiCached: true
      };
    }

    const aiInsight = byId.get(insight.id);
    if (!aiInsight) return insight;
    const status = normalizeAiStatus(aiInsight.status);
    const aiActions = (aiInsight.nextActions?.length ? aiInsight.nextActions : insight.nextActions).map((action, index) => ({
      id: `ai-action-${insight.id}-${index}`,
      title: insight.subject,
      owner: action.owner || '미지정',
      priority: Number(action.priority || (status === 'urgent' ? 1 : 4)),
      lane: normalizeAiStatus(action.lane || status) === 'reference' ? 'active' : normalizeAiStatus(action.lane || status),
      due: action.due || '',
      recommendedAction: action.recommendedAction || '후속 필요 여부 판단',
      evidence: action.evidence || '',
      messageId: insight.id,
      receivedAt: insight.receivedAt,
      webLink: insight.webLink,
      intent: action.intent || '',
      to: action.to || message.from || '',
      subject: action.subject || replySubject(insight.subject),
      body: action.body || ''
    }));
    const nextActions = normalizeActionScenarios(message, aiActions, aiInsight.summary || insight.summary);

    // Hybrid urgency: AI score + rule confidence + feedback override
    const smartRule = applySmartRules(message, feedback);
    const feedbackStatus = feedback[insight.id]?.userStatus || null;
    const urgency = urgencyScore(
      aiInsight.urgencyScore,
      smartRule?.confidence,
      feedbackStatus
    );

    return {
      ...insight,
      status,
      summary: Array.isArray(aiInsight.summary) && aiInsight.summary.length ? aiInsight.summary.slice(0, 4) : insight.summary,
      nextActions,
      evidenceItems: Array.isArray(aiInsight.evidenceItems) ? aiInsight.evidenceItems.slice(0, 6) : insight.evidenceItems,
      aiRationale: aiInsight.aiRationale || '',
      aiEnhanced: true,
      urgency
    };
  });

  for (const insight of enhancedInsights) {
    if (!aiMessageIds.has(insight.id) || !insight.aiEnhanced) continue;
    const message = messages.find((item) => item.id === insight.id);
    if (!message) continue;
    analysisCache[analysisCacheKey(message, modelName)] = {
      status: insight.status,
      summary: insight.summary,
      nextActions: insight.nextActions,
      evidenceItems: insight.evidenceItems,
      aiRationale: insight.aiRationale,
      urgency: insight.urgency
    };
  }
  cache.mailboxes[cacheKey] = {
    ...mailboxCache,
    analysis: analysisCache
  };
  await saveMailCache(cache);

  const nextActions = enhancedInsights.flatMap((insight) => insight.nextActions || []).sort((a, b) => a.priority - b.priority);
  const calendar = result.calendar;
  const reminders = nextActions
    .filter((action) => action.lane === 'urgent' || action.due)
    .map((action) => ({
      title: action.recommendedAction,
      reason: action.evidence,
      owner: action.owner,
      subject: action.subject,
      messageId: action.messageId,
      receivedAt: action.receivedAt,
      webLink: action.webLink
    }));

  return {
    ...result,
    messageInsights: enhancedInsights,
    nextActions,
    reminders,
    ai: {
      enabled: true,
      provider,
      model: modelName,
      analyzed: requestMessages.length,
      pending: Math.max(messagesForAi.length - requestMessages.length, 0),
      cached: cachedById.size
    }
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${port}`);

  const destructiveGate = checkDestructiveApproval(req);
  if (
    !destructiveGate.allowed &&
    isDestructiveApi(url.pathname, req.method || 'GET')
  ) {
    return json(res, destructiveGate.statusCode || 403, destructiveGate.body);
  }

  if (url.pathname === '/api/outlook/oauth/start') {
    const clientId = url.searchParams.get('clientId')?.trim() || getConfigValue('clientId', 'MICROSOFT_CLIENT_ID');
    const tenantId = url.searchParams.get('tenantId')?.trim() || runtimeConfig.loginTenant || 'common';
    const mailbox = url.searchParams.get('mailboxUser')?.trim() || '';
    if (!clientId) return json(res, 400, { message: 'Client ID is required.' });

    const state = base64Url(randomBytes(24));
    const codeVerifier = base64Url(randomBytes(48));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    pendingOAuth.set(state, {
      codeVerifier,
      clientId,
      tenantId,
      mailboxUser: mailbox,
      createdAt: Date.now(),
      redirectUri: redirectUri(req)
    });

    const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('redirect_uri', redirectUri(req));
    authorize.searchParams.set('response_mode', 'query');
    authorize.searchParams.set('scope', delegatedScopes);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    res.writeHead(302, { Location: authorize.toString() });
    res.end();
    return;
  }

  if (url.pathname === '/api/outlook/config') {
    if (req.method === 'GET') return json(res, 200, configStatus());
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        for (const key of ['tenantId', 'clientId', 'mailboxUser', 'loginTenant', 'geminiModel', 'aiProvider', 'faiosServerUrl', 'lmstudioUrl', 'lmstudioModel', 'mimoModel', 'mimoBaseUrl']) {
          if (typeof body[key] === 'string') runtimeConfig[key] = body[key].trim();
        }
        for (const key of ['accessToken', 'clientSecret', 'geminiApiKey', 'mimoApiKey']) {
          if (typeof body[key] === 'string' && body[key].trim()) runtimeConfig[key] = body[key].trim();
        }
        if (body.persist !== false) await savePersistedConfig();
        return json(res, 200, configStatus());
      } catch {
        return json(res, 400, { message: 'Invalid JSON body.' });
      }
    }
    if (req.method === 'DELETE') {
      for (const key of Object.keys(runtimeConfig)) {
        runtimeConfig[key] = key === 'expiresAt' ? 0 : key === 'loginTenant' ? 'common' : '';
      }
      await savePersistedConfig();
      return json(res, 200, configStatus());
    }
    return json(res, 405, { message: 'Method not allowed' });
  }

  if (url.pathname === '/api/outlook/status') {
    return json(res, 200, configStatus());
  }

  if (url.pathname === '/api/outlook/health') {
    const status = configStatus();
    const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
    const cacheKey = mailboxCacheKey(mailboxUser);
    let graphAuth = 'not_configured';
    let syncMode = 'none';
    let lastSyncedAt = null;
    let deltaLinkPresent = false;
    let deltaLinkExpires = null;
    let totalCached = 0;

    try {
      const cache = await loadMailCache();
      const mc = cache.mailboxes[cacheKey];
      if (mc) {
        totalCached = Array.isArray(mc.messages) ? mc.messages.length : 0;
        lastSyncedAt = mc.lastSyncedAt || null;
        deltaLinkPresent = Boolean(mc.deltaLink);
        deltaLinkExpires = mc.deltaLinkExpires || null;
      }

      if (status.connected) {
        try {
          const token = await getGraphAccessToken();
          graphAuth = token ? 'ok' : 'missing_token';
          if (mc?.deltaLink) {
            syncMode = 'delta';
          } else if (totalCached > 0) {
            syncMode = 'incremental';
          } else {
            syncMode = 'initial';
          }
        } catch (authError) {
          const msg = authError instanceof Error ? authError.message : '';
          if (/invalid_client/i.test(msg)) graphAuth = 'invalid_client';
          else if (/refresh/i.test(msg)) graphAuth = 'refresh_failed';
          else graphAuth = 'auth_error';
          syncMode = totalCached > 0 ? 'cache-fallback' : 'initial';
        }
      }
    } catch {
      // Cache read failed; report defaults.
    }

    let attachmentSyncAvailable = status.connected;
    try {
      await getGraphAccessToken();
    } catch {
      attachmentSyncAvailable = false;
    }

    const aiProvider = runtimeConfig.aiProvider || 'rules';
    const aiDraftAvailable = aiProvider === 'lmstudio'
      ? Boolean(getLmStudioUrl())
      : aiProvider === 'gemini'
        ? Boolean(getConfigValue('geminiApiKey', 'GEMINI_API_KEY'))
        : aiProvider === 'f-aios-v3'
          ? Boolean(runtimeConfig.faiosServerUrl)
          : aiProvider === 'mimo'
            ? Boolean(runtimeConfig.mimoApiKey || getConfigValue('mimoApiKey', 'MIMO_API_KEY'))
            : false;

    return json(res, 200, {
      graphAuth,
      syncMode,
      lastSyncedAt,
      deltaLinkPresent,
      deltaLinkExpires,
      totalCached,
      attachmentSyncAvailable,
      aiDraftAvailable,
      aiProvider,
      mailboxUser: mailboxUser || null,
      connected: status.connected,
      authMode: status.authMode
    });
  }


  if (url.pathname === '/api/outlook/send-request' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { to, cc, subject, body: mailBody, messageId, threadKey } = body;
      if (!to || !subject || !mailBody) {
        return json(res, 400, { message: 'to, subject, body are required.' });
      }
      const requireApproval = process.env.MAIL_REQUIRE_APPROVAL === 'true';
      const queueOnly = body.queueOnly === true;
      if (queueOnly) {
        const internalKey = String(process.env.MAIL_INTERNAL_API_KEY || '').trim();
        const providedKey = String(req.headers['x-mail-internal-key'] || '').trim();
        if (!internalKey || providedKey !== internalKey) {
          return json(res, 403, { message: 'queueOnly requires a valid X-Mail-Internal-Key.' });
        }
      }
      const request = sendRequestStore.create(
        { to, cc, subject, body: mailBody, messageId, threadKey },
        { requireApproval, queueOnly }
      );

      if (!requireApproval && !queueOnly) {
        await sendRequestStore.send(request, sendOutlookMail);
      }

      return json(res, 201, toSendRequestResponse(request));
    } catch (error) {
      return json(res, 400, {
        message: error instanceof Error ? error.message : 'Invalid send request.'
      });
    }
  }

  const sendRequestCompleteMatch = url.pathname.match(/^\/api\/outlook\/send-requests\/([^/]+)\/complete$/);
  if (sendRequestCompleteMatch && req.method === 'POST') {
    if (!destructiveGate.approvalId) {
      return json(res, 403, {
        message: 'Send request completion requires approved AIOS headers.'
      });
    }
    const requestId = decodeURIComponent(sendRequestCompleteMatch[1]);
    try {
      const request = await sendRequestStore.complete(requestId, {
        approvalId: destructiveGate.approvalId,
        sendMail: sendOutlookMail
      });
      return json(res, request.approvalStatus === 'sent' ? 200 : 502, toSendRequestResponse(request));
    } catch (error) {
      return json(res, error.statusCode || 500, {
        message: error instanceof Error ? error.message : 'Send request completion failed.'
      });
    }
  }

  if (url.pathname.startsWith('/api/outlook/send-requests/')) {
    const requestId = url.pathname.replace('/api/outlook/send-requests/', '').split('/')[0];
    const request = sendRequestStore.get(requestId);
    if (!request) {
      return json(res, 404, { message: 'Send request not found.' });
    }
    return json(res, 200, toSendRequestResponse(request));
  }


  if (url.pathname === '/api/outlook/accounts') {
    if (req.method !== 'GET') return json(res, 405, { message: 'Method not allowed' });
    try {
      const store = await readJsonFile(outlookAccountsPath, { version: 2, accounts: [] });
      return json(res, 200, listAccountsFromStore(store));
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Account registry load failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/accounts/active') {
    if (req.method !== 'POST') return json(res, 405, { message: 'Method not allowed' });
    try {
      const body = await readJsonBody(req);
      const accountId = String(body.accountId || '').trim();
      if (!accountId) return json(res, 400, { message: 'accountId is required.' });
      const store = await readJsonFile(outlookAccountsPath, { version: 2, accounts: [] });
      const account = findAccountById(store, accountId);
      if (!account) return json(res, 404, { message: 'Account not found.' });
      store.activeAccountId = account.id;
      Object.assign(runtimeConfig, applyAccountToRuntimeConfig(account));
      await writeFile(outlookAccountsPath, JSON.stringify(store, null, 2), 'utf8');
      await savePersistedConfig();
      return json(res, 200, {
        switched: true,
        activeAccountId: account.id,
        status: configStatus()
      });
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Account switch failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/approval-status') {
    const requireApproval = process.env.MAIL_REQUIRE_APPROVAL === 'true';
    return json(res, 200, {
      requireApproval,
      approvalGate: requireApproval ? 'aios-v2' : 'none',
      description: requireApproval
        ? '발송/읽기/설정삭제 API는 AIOS v2 approval gate를 통한 X-Aios-Approval-ID + X-Mail-Internal-Key 헤더가 필요합니다.'
        : 'Approval gate가 비활성 상태입니다. 모든 destructive API가 직접 호출 가능합니다.',
      destructivePaths: ['/api/outlook/send', '/api/outlook/read', '/api/outlook/config (DELETE)'],
      evidencePoints: [
        { path: '/api/outlook/feedback', method: 'POST', description: '분류 보정 피드백 저장 (AIOS evidence writer 연동 포인트)' },
        { path: '/api/portal/feedback-sync', method: 'POST', description: '포털 피드백 동기화 (AIOS v1 대조 포인트)' },
        { path: '/api/portal/push-candidates', method: 'POST', description: '태스크 후보 푸시 (AIOS v1 task candidate 연동)' }
      ],
      approvalRequiredPaths: requireApproval ? [
        { path: '/api/outlook/send', method: 'POST', description: '메일 발송 (destructive)' },
        { path: '/api/outlook/read', method: 'POST', description: '읽음 상태 변경 (destructive)' },
        { path: '/api/outlook/config', method: 'DELETE', description: '설정 초기화 (destructive)' }
      ] : []
    });
  }

  if (url.pathname === '/api/outlook/send') {
    if (req.method !== 'POST') return json(res, 405, { message: 'Method not allowed' });
    try {
      const body = await readJsonBody(req);
      const result = await sendOutlookMail(body);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 502, {
        sent: false,
        message: error instanceof Error ? error.message : 'Outlook send failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/read') {
    if (req.method !== 'POST') return json(res, 405, { message: 'Method not allowed' });
    try {
      const body = await readJsonBody(req);
      const result = await markOutlookMessageRead(String(body.messageId || ''), body.isRead !== false);
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.statusCode || 502, {
        updated: false,
        message: error instanceof Error ? error.message : 'Outlook read update failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/feedback') {
    if (req.method !== 'POST') return json(res, 405, { message: 'Method not allowed' });
    try {
      const body = await readJsonBody(req);
      const feedback = await saveClassificationFeedback(body);
      return json(res, 200, { saved: true, feedback });
    } catch (error) {
      return json(res, error.statusCode || 400, {
        saved: false,
        message: error instanceof Error ? error.message : 'Feedback save failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/attachments') {
    try {
      const archive = await loadAttachmentArchive();
      return json(res, 200, archive);
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Attachment archive load failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/attachments/sync' && req.method === 'POST') {
    try {
      const top = Number(url.searchParams.get('top') || 10);
      const result = await syncOutlookAttachmentArchive(top);
      return json(res, 200, { synced: true, ...result });
    } catch (error) {
      const structured = error?.structuredError;
      return json(res, error.statusCode || 500, {
        synced: false,
        message: error instanceof Error ? error.message : 'Attachment sync failed.',
        ...(structured ? { code: structured.code, retryable: structured.retryable, action: structured.action } : {})
      });
    }
  }

  if (url.pathname === '/api/outlook/reply-draft') {
    try {
      const messageId = String(url.searchParams.get('messageId') || '').trim();
      if (!messageId) return json(res, 400, { message: 'messageId is required.' });
      const tone = String(url.searchParams.get('tone') || '').trim() || undefined;
      const draft = await generateReplyDraft(messageId, { tone });
      return json(res, 200, draft);
    } catch (error) {
      return json(res, error?.statusCode || 500, {
        message: error instanceof Error ? error.message : 'Reply draft generation failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/conversation-summary') {
    try {
      const conversationId = String(url.searchParams.get('conversationId') || '').trim();
      if (!conversationId) return json(res, 400, { message: 'conversationId is required.' });
      const { mailboxCache } = await readFeedbackContext();
      const allMessages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
      const threadMessages = allMessages.filter((msg) => msg.conversationId === conversationId);
      if (threadMessages.length === 0) return json(res, 404, { message: 'No messages found for this conversation.' });
      const summary = await generateThreadSummary(threadMessages);
      return json(res, 200, summary);
    } catch (error) {
      return json(res, error?.statusCode || 500, {
        message: error instanceof Error ? error.message : 'Thread summary generation failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/webhook') {
    const validationToken = url.searchParams.get('validationToken');
    if (validationToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(validationToken);
      return;
    }
    if (req.method === 'POST') {
      scheduleDebouncedAnalyze(async () => {
        await fetchOutlookMessages(50, { forceInitial: false });
      });
      return json(res, 202, { accepted: true, debounceMs: 300_000 });
    }
    return json(res, 405, { message: 'Method not allowed' });
  }

  if (
    url.pathname === '/api/portal/sync-overview' ||
    url.pathname === '/api/portal/thread-insights' ||
    url.pathname === '/api/portal/entity-candidates' ||
    url.pathname === '/api/portal/calendar-hints'
  ) {
    try {
      const top = Number(url.searchParams.get('top') || 50);
      const syncMode = url.searchParams.get('sync') || 'cache';
      const forIngest = url.searchParams.get('forIngest') !== '0';
      const data =
        syncMode === 'cache'
          ? await loadCachedMailbox(top)
          : await fetchOutlookMessages(top, { forceInitial: syncMode === 'initial' });
      const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
      const cache = await loadMailCache();
      const cacheKey = mailboxCacheKey(mailboxUser);
      const fullMessages = sortMessages(cache.mailboxes[cacheKey]?.messages || data.messages);
      const threadGroupingResult = await enrichWithThreadGrouping(fullMessages);
      const displayMessages = sliceDisplayMessages(threadGroupingResult.messages, top);
      const { feedback } = await readFeedbackContext();
      const baseResult = applyFeedbackToResult(
        analyzeMessages(displayMessages, { feedback }),
        displayMessages,
        feedback,
        { allowLearnedOverride: true }
      );
      let result = baseResult;
      let aiError = null;
      try {
        result = await enrichWithAI(displayMessages, baseResult);
        result = applyFeedbackToResult(result, displayMessages, feedback, { allowLearnedOverride: false });
      } catch (error) {
        aiError = error instanceof Error ? error.message : 'AI enhancement failed.';
        result = { ...baseResult, ai: { enabled: false, provider: 'rules', error: aiError } };
      }
      const analyzePayload = {
        ...data,
        messages: displayMessages,
        threadGroups: threadGroupingResult.threadGroups,
        threadGrouping: threadGroupingResult.threadGrouping,
        connected: data.connected !== false,
        mailboxUser,
        analyzedAt: new Date().toISOString(),
        result: { ...result, threadGroups: threadGroupingResult.threadGroups },
        aiError
      };
      if (url.pathname === '/api/portal/sync-overview') {
        return json(res, 200, toMailSyncResult(analyzePayload));
      }
      if (url.pathname === '/api/portal/entity-candidates') {
        const candidates = toEntityCandidates({
          messages: fullMessages,
          threadGroups: threadGroupingResult.threadGroups,
          mailboxUser
        });
        return json(res, 200, { candidates, count: candidates.length });
      }
      if (url.pathname === '/api/portal/calendar-hints') {
        const calendar = toCalendarHints(analyzePayload);
        return json(res, 200, { calendar, count: calendar.length });
      }
      const threads = toInsightThreads({
        threadGroups: threadGroupingResult.threadGroups,
        messages: fullMessages,
        messageInsights: result.messageInsights || [],
        mailboxUser
      });
      return json(res, 200, {
        threads: forIngest ? filterThreadsForIngest(threads) : threads,
        count: forIngest ? filterThreadsForIngest(threads).length : threads.length
      });
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Portal bridge failed.'
      });
    }
  }

  if (url.pathname === '/api/portal/push-candidates' && req.method === 'POST') {
    try {
      const top = Number(url.searchParams.get('top') || 50);
      const data = await loadCachedMailbox(top);
      const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
      const cache = await loadMailCache();
      const cacheKey = mailboxCacheKey(mailboxUser);
      const fullMessages = sortMessages(cache.mailboxes[cacheKey]?.messages || data.messages);
      const { threadGroups } = await enrichWithThreadGrouping(fullMessages);
      const { feedback } = await readFeedbackContext();
      const result = analyzeMessages(fullMessages.slice(0, top), { feedback });
      const candidates = toTaskCandidates({
        messages: fullMessages,
        messageInsights: result.messageInsights,
        threadGroups
      });
      return json(res, 200, { candidates, count: candidates.length });
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Candidate push failed.'
      });
    }
  }

  if (url.pathname === '/api/portal/feedback-sync' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const feedback = await saveClassificationFeedback(body);
      return json(res, 200, { saved: true, feedback });
    } catch (error) {
      return json(res, error.statusCode || 400, {
        saved: false,
        message: error instanceof Error ? error.message : 'Feedback sync failed.'
      });
    }
  }

  if (url.pathname === '/api/portal/attachments' && req.method === 'GET') {
    try {
      const archive = await loadAttachmentArchive();
      return json(res, 200, {
        attachments: toAttachmentRefs(archive),
        counts: archive.counts || { total: archive.entries?.length || 0 }
      });
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Portal attachment bridge failed.'
      });
    }
  }

  if (url.pathname === '/api/portal/contract' && req.method === 'GET') {
    return json(res, 200, toApprovalContract());
  }


  if (url.pathname.startsWith('/api/portal/thread/') && req.method === 'GET') {
    const threadKey = decodeURIComponent(url.pathname.replace('/api/portal/thread/', ''));
    try {
      const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
      const cache = await loadMailCache();
      const cacheKey = mailboxCacheKey(mailboxUser);
      const fullMessages = sortMessages(cache.mailboxes[cacheKey]?.messages || []);
      const { threadGroups } = await enrichWithThreadGrouping(fullMessages);
      const group = (threadGroups || []).find(
        (item) => item.key === threadKey || item.label === threadKey
      );
      if (!group) return json(res, 404, { message: 'Thread not found.' });
      const messages = fullMessages.filter((message) => group.messageIds?.includes(message.id));
      return json(res, 200, { thread: group, messages });
    } catch (error) {
      return json(res, 500, {
        message: error instanceof Error ? error.message : 'Thread lookup failed.'
      });
    }
  }

  if (url.pathname === '/api/outlook/messages' || url.pathname === '/api/outlook/analyze') {
    try {
      const top = Number(url.searchParams.get('top') || 25);
      const syncMode = url.searchParams.get('sync') || 'auto';
      let data;
      try {
        data =
          syncMode === 'cache'
            ? await loadCachedMailbox(top)
            : await fetchOutlookMessages(top, { forceInitial: syncMode === 'initial' });
      } catch (syncError) {
        if (syncMode === 'cache') throw syncError;
        const cached = await loadCachedMailbox(top);
        data = {
          ...cached,
          connected: cached.messages.length > 0,
          mode: 'cache-fallback',
          message: `Graph 동기화 실패로 로컬 캐시를 표시합니다. ${syncError instanceof Error ? syncError.message : 'Unknown sync error.'}`,
          sync: {
            ...cached.sync,
            mode: 'cache-fallback',
            syncError: syncError instanceof Error ? syncError.message : 'Unknown sync error.'
          }
        };
      }
      if (url.pathname === '/api/outlook/messages') return json(res, 200, data);
      let threadGroupingResult = { messages: data.messages, threadGroups: [], threadGrouping: { enabled: false } };
      try {
        const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
        const cache = await loadMailCache();
        const cacheKey = mailboxCacheKey(mailboxUser);
        const fullMessages = sortMessages(cache.mailboxes[cacheKey]?.messages || data.messages);
        threadGroupingResult = await enrichWithThreadGrouping(fullMessages);
        data.messages = sliceDisplayMessages(threadGroupingResult.messages, top);
      } catch (error) {
        threadGroupingResult.threadGrouping = {
          enabled: false,
          error: error instanceof Error ? error.message : 'Thread grouping failed'
        };
      }
      const { feedback } = await readFeedbackContext();
      const baseResult = applyFeedbackToResult(analyzeMessages(data.messages), data.messages, feedback, { allowLearnedOverride: true });
      let result = baseResult;
      let aiError = null;
      try {
        result = await enrichWithAI(data.messages, baseResult);
        result = applyFeedbackToResult(result, data.messages, feedback, { allowLearnedOverride: false });
      } catch (error) {
        aiError = error instanceof Error ? error.message : 'AI enhancement failed.';
        result = { ...baseResult, ai: { enabled: false, provider: 'rules', error: aiError } };
      }
      return json(res, 200, {
        ...data,
        analyzedAt: new Date().toISOString(),
        result: { ...result, threadGroups: threadGroupingResult.threadGroups },
        threadGroups: threadGroupingResult.threadGroups,
        threadGrouping: threadGroupingResult.threadGrouping,
        aiError
      });
    } catch (error) {
      return json(res, 502, {
        connected: false,
        mode: 'error',
        message: error instanceof Error ? error.message : 'Outlook fetch failed.'
      });
    }
  }

  // Call Recording Analysis Endpoints
  if (url.pathname === '/api/calls/recordings') {
    try {
      const dir = url.searchParams.get('dir') || undefined;
      const recordings = await loadCallRecordings(dir);
      return json(res, 200, { 
        recordings: recordings.slice(0, 100),
        total: recordings.length 
      });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Failed to load recordings' 
      });
    }
  }

  if (url.pathname === '/api/calls/transcribe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { filePath, model = 'base', language = 'ko' } = body;
      
      if (!filePath) {
        return json(res, 400, { message: 'filePath is required' });
      }
      
      const result = await processCallRecording(filePath, { model, language });
      return json(res, 200, result);
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Transcription failed' 
      });
    }
  }

  if (url.pathname === '/api/calls/match' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { callInfo, mailboxKey } = body;
      
      const cache = await loadMailCache();
      const mailbox = cache.mailboxes[mailboxKey || 'me'] || {};
      const emails = mailbox.messages || [];
      
      const matches = matchCallWithEmails(callInfo, emails);
      return json(res, 200, { matches: matches.slice(0, 20) });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Matching failed' 
      });
    }
  }

  if (url.pathname === '/api/calls/batch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { recordings, model = 'base', language = 'ko' } = body;
      
      if (!Array.isArray(recordings) || recordings.length === 0) {
        return json(res, 400, { message: 'recordings array is required' });
      }
      
      const results = await batchProcessRecordings(recordings, { model, language });
      return json(res, 200, { results });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Batch processing failed' 
      });
    }
  }

  // Conversation Learning Endpoints
  if (url.pathname === '/api/conversations/threads') {
    try {
      const cache = await loadMailCache();
      const cacheKey = url.searchParams.get('mailbox') || currentMailboxKey();
      const mailbox = cache.mailboxes[cacheKey] || {};
      const messages = mailbox.messages || [];
      
      const threads = groupByConversation(messages);
      const stats = analyzeConversationPatterns(threads);
      
      return json(res, 200, { 
        threads: threads.slice(0, 50),
        stats,
        total: threads.length 
      });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Thread analysis failed' 
      });
    }
  }

  if (url.pathname === '/api/conversations/replies') {
    try {
      const cache = await loadMailCache();
      const cacheKey = url.searchParams.get('mailbox') || currentMailboxKey();
      const mailbox = cache.mailboxes[cacheKey] || {};
      const messages = mailbox.messages || [];
      
      const threads = groupByConversation(messages);
      const replyPairs = [];
      
      for (const thread of threads) {
        const pairs = matchReplyPair(thread.incoming, thread.outgoing);
        replyPairs.push(...pairs);
      }
      
      return json(res, 200, { 
        replyPairs: replyPairs.slice(0, 50),
        total: replyPairs.length 
      });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Reply matching failed' 
      });
    }
  }

  if (url.pathname === '/api/conversations/summary') {
    try {
      const threadId = url.searchParams.get('threadId');
      if (!threadId) {
        return json(res, 400, { message: 'threadId is required' });
      }
      
      const cache = await loadMailCache();
      const cacheKey = url.searchParams.get('mailbox') || currentMailboxKey();
      const mailbox = cache.mailboxes[cacheKey] || {};
      const messages = mailbox.messages || [];
      
      const threads = groupByConversation(messages);
      const thread = threads.find(t => t.id === threadId);
      
      if (!thread) {
        return json(res, 404, { message: 'Thread not found' });
      }
      
      const summary = generateConversationSummary(thread);
      return json(res, 200, summary);
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Summary generation failed' 
      });
    }
  }

  if (url.pathname === '/api/conversations/integrated') {
    try {
      const cache = await loadMailCache();
      const cacheKey = url.searchParams.get('mailbox') || currentMailboxKey();
      const mailbox = cache.mailboxes[cacheKey] || {};
      const messages = mailbox.messages || [];
      
      // Load call recordings
      const recordings = await loadCallRecordings();
      
      // Create integrated conversation threads
      const threads = createConversationThread(messages, recordings);
      
      return json(res, 200, { 
        threads: threads.slice(0, 50),
        total: threads.length,
        callCount: recordings.length
      });
    } catch (error) {
      return json(res, 500, { 
        message: error instanceof Error ? error.message : 'Integrated view failed' 
      });
    }
  }

  return json(res, 404, { message: 'Not found' });
}

const server = createServer(async (req, res) => {
  if ((req.url || '').startsWith('/auth/callback')) {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const error = url.searchParams.get('error_description') || url.searchParams.get('error');
    const pending = pendingOAuth.get(state);
    pendingOAuth.delete(state);

    if (error || !pending || !code || Date.now() - pending.createdAt > 10 * 60_000) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Outlook login failed</h1><p>${error || 'Invalid or expired OAuth state.'}</p>`);
      return;
    }

    try {
      const tokenParams = {
        client_id: pending.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
        scope: delegatedScopes
      };
      if (runtimeConfig.clientSecret) {
        tokenParams.client_secret = runtimeConfig.clientSecret;
      }
      const body = new URLSearchParams(tokenParams);
      const response = await fetch(`https://login.microsoftonline.com/${pending.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${text}`);
      }
      const payload = await response.json();
      runtimeConfig.accessToken = payload.access_token || '';
      runtimeConfig.refreshToken = payload.refresh_token || '';
      runtimeConfig.clientId = pending.clientId;
      runtimeConfig.tenantId = pending.tenantId;
      runtimeConfig.loginTenant = pending.tenantId;
      runtimeConfig.mailboxUser = pending.mailboxUser;
      runtimeConfig.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
      await savePersistedConfig();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Outlook 연결 완료</title></head><body><h1>Outlook 로그인 완료</h1><p>이 창을 닫으면 메일이 자동으로 동기화됩니다.</p><script>try{window.opener?.postMessage({type:\'outlook-oauth-complete\'},\'*\');}catch(e){}</script></body></html>');
    } catch (exchangeError) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Outlook token exchange failed</h1><p>${exchangeError instanceof Error ? exchangeError.message : 'Unknown error'}</p>`);
    }
    return;
  }

  if ((req.url || '').startsWith('/api/')) {
    await handleApi(req, res);
    return;
  }

  try {
    const filePath = resolvePath(req.url || '/');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    const body = await readFile(join(root, 'index.html'));
    res.writeHead(200, { 'Content-Type': contentTypes['.html'] });
    res.end(body);
  }
});

server.on('error', async (error) => {
  if (error && error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://localhost:${port}/api/outlook/status`);
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        console.log(`Mail Intelligence is already running at http://localhost:${port}`);
        process.exit(0);
      }
    } catch {
      // Fall through to the generic port-in-use guidance below.
    }
    console.error(`Port ${port} is already in use by another process. Stop it or run with PORT=${port + 1} pnpm dev.`);
    process.exit(1);
  }
  throw error;
});

await initDataPaths();
await loadPersistedConfig();

server.listen(port, () => {
  console.log(`Mail Intelligence app running at http://localhost:${port}`);
});

// --- AI Helper Functions ---

function getModelName(provider) {
  if (provider === 'f-aios-v3') return 'F-AIOS-v3 (via LM Studio)';
  if (provider === 'gemini') return runtimeConfig.geminiModel || 'gemini-2.5-flash';
  if (provider === 'mimo') return runtimeConfig.mimoModel || 'MiMo-V2.5';
  return runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
}

function getLmStudioUrl() {
  return (getConfigValue('lmstudioUrl', 'LMSTUDIO_URL') || 'http://localhost:1234').replace(/\/+$/, '');
}

function buildAnalysisPrompt(feedbackExamples, messagesForAi, maxBodyLength = 4500) {
  return `You are an executive email triage assistant. Analyze each email and return ONLY valid JSON.

Language: Korean.
Classify status as one of: urgent, active, waiting, done, reference.
For each email, provide concise summary bullets and exactly 3 next action scenarios.
Scenario 1 should be a direct confirmation/progress reply.
Scenario 2 should request missing details or clarify blockers.
Scenario 3 should share or reference Sangfor pages/manuals/related documents when relevant, otherwise propose a document-backed follow-up.
Do not invent facts. If no action is needed, create one action that says whether to archive, monitor, or review later.
For each email, also provide an urgencyScore (0-100) based on time sensitivity, sender importance, and content. 100 = immediate action required, 0 = purely informational.
Use the user's prior correction examples as preference guidance. If a similar sender, subject token, or reason pattern appears, align with the user's corrected status unless the current email has explicit contradictory evidence.

Recent user correction examples:
${JSON.stringify(feedbackExamples, null, 2)}

JSON schema:
{
  "messages": [
    {
      "id": "same id",
      "status": "urgent|active|waiting|done|reference",
      "summary": ["2-4 Korean bullets"],
      "nextActions": [
        {
          "recommendedAction": "concrete Korean action",
          "owner": "owner or 미지정",
          "due": "explicit due date/time or empty",
          "priority": 1,
          "lane": "urgent|active|waiting|done",
          "evidence": "short supporting sentence from email",
          "intent": "why this scenario is useful",
          "to": "recipient email",
          "subject": "draft email subject",
          "body": "editable Korean email draft"
        }
      ],
      "evidenceItems": ["supporting facts, not raw long paragraphs"],
      "aiRationale": "why this status/action was chosen",
      "urgencyScore": 0
    }
  ]
}

Emails:
${JSON.stringify(messagesForAi.map((message) => ({
    id: message.id,
    subject: message.subject,
    from: message.fromName || message.from,
    receivedAt: message.receivedAt,
    body: clip(message.body || message.bodyPreview, maxBodyLength)
  })), null, 2)}`;
}

function buildLmStudioAnalysisPrompt(feedbackExamples, messagesForAi) {
  return `Return ONLY valid JSON. No markdown.

Analyze each email in Korean. Keep the output compact.
Classify status as one of: urgent, active, waiting, done, reference.
Do not draft replies. Put "nextActions": [] and let the app generate default action scenarios.
For each email, also provide an urgencyScore (0-100) based on time sensitivity, sender importance, and content.

Recent user correction examples:
${JSON.stringify(feedbackExamples.slice(0, 5), null, 2)}

Required JSON shape:
{
  "messages": [
    {
      "id": "same id",
      "status": "urgent|active|waiting|done|reference",
      "summary": ["1-2 short Korean bullets"],
      "nextActions": [],
      "evidenceItems": ["1-2 short supporting facts"],
      "aiRationale": "short Korean rationale",
      "urgencyScore": 0
    }
  ]
}

Emails:
${JSON.stringify(messagesForAi.map((message) => ({
    id: message.id,
    subject: clip(message.subject, 180),
    from: clip(message.fromName || message.from, 120),
    receivedAt: message.receivedAt,
    body: clip(message.body || message.bodyPreview, 400)
  })), null, 2)}`;
}

async function callFaiosServer(prompt) {
  const serverUrl = runtimeConfig.faiosServerUrl || 'http://localhost:3201';
  
  const response = await fetch(`${serverUrl}/api/workflow/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'email-analysis',
      input: {
        prompt,
        model: runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b',
        temperature: 0.2,
        max_tokens: 8192
      }
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`F-AIOS-v3 server error: ${response.status} ${text}`);
  }
  
  const payload = await response.json();
  return payload.output?.response || payload.response || JSON.stringify(payload);
}

async function callGeminiApi(prompt) {
  const apiKey = getConfigValue('geminiApiKey', 'GEMINI_API_KEY');
  if (!apiKey) throw new Error('Gemini API key not configured');
  
  const model = runtimeConfig.geminiModel || 'gemini-2.5-flash';
  
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }
  
  const payload = await response.json();
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
}

async function callMiMoApi(prompt, { maxTokens = 2400, timeoutMs = 60000 } = {}) {
  const apiKey = runtimeConfig.mimoApiKey || getConfigValue('mimoApiKey', 'MIMO_API_KEY');
  if (!apiKey) throw new Error('MiMo API key not configured');
  
  const model = runtimeConfig.mimoModel || 'MiMo-V2.5';
  const baseUrl = (runtimeConfig.mimoBaseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an AI email analysis assistant. You MUST respond with ONLY valid JSON, no markdown, no explanation, no thinking.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiMo API error: ${response.status} ${text}`);
  }
  
  const payload = await response.json();
  const choice = payload.choices?.[0]?.message || {};
  // MiMo is a reasoning model - combine reasoning + content
  const content = choice.content || '';
  const reasoning = choice.reasoning_content || '';
  return content || reasoning || '';
}

async function callLmStudioGeneric(prompt, { maxTokens = 1800, timeoutMs = 25000 } = {}) {
  const model = runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
  const response = await fetch(`${getLmStudioUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM Studio error: ${response.status} ${text}`);
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || '';
}

async function callLmStudio(prompt) {
  const model = runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
  
  const response = await fetch(`${getLmStudioUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'mail_analysis',
          schema: {
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    summary: { type: 'array', items: { type: 'string' } },
                    nextActions: { type: 'array', items: { type: 'object' } },
                    evidenceItems: { type: 'array', items: { type: 'string' } },
                    aiRationale: { type: 'string' }
                  },
                  required: ['id', 'status', 'summary', 'evidenceItems', 'aiRationale']
                }
              }
            },
            required: ['messages']
          }
        }
      }
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM Studio error: ${response.status} ${text}`);
  }
  
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || '';
}

// --- Thread Summary ---

const THREAD_SUMMARY_CACHE = new Map();

function threadSummaryKey(conversationId, messageCount) {
  return `${conversationId}::${messageCount}`;
}

async function generateThreadSummary(threadMessages) {
  if (!Array.isArray(threadMessages) || threadMessages.length === 0) {
    return { summary: '표시할 메시지가 없습니다.', messageCount: 0, truncated: false };
  }

  const conversationId = threadMessages[0]?.conversationId || 'unknown';
  const cacheKey = threadSummaryKey(conversationId, threadMessages.length);
  const cached = THREAD_SUMMARY_CACHE.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Cap at 15 messages: first + most recent 10
  let messages = threadMessages;
  let truncated = false;
  if (messages.length > 15) {
    const first = messages[0];
    const recent = messages.slice(-10);
    messages = [first, ...recent];
    truncated = true;
  }

  const messageTexts = messages.map((msg, i) => {
    const direction = msg.mailFolder === 'sentitems' || msg.mailFolder === 'sent' ? '보냄' : '받음';
    const from = msg.fromName || msg.from || 'unknown';
    const date = msg.receivedAt ? new Date(msg.receivedAt).toLocaleString('ko-KR') : '';
    const body = clip(msg.body || msg.bodyPreview || '', 500);
    return `[${i + 1}] ${direction} ${from} (${date}): ${body}`;
  }).join('\n\n');

  const prompt = `다음 이메일 스레드를 한국어로 간결하게 요약해주세요.
핵심 논점, 결정 사항, 후속 조치 사항을 포함해주세요.
3-5문장으로 요약해주세요.

${truncated ? `긴 스레드: 최근 10개 메시지 기반 요약 (전체 ${threadMessages.length}건 중)` : `메시지 ${threadMessages.length}건`}

JSON 형식:
{ "summary": "요약 텍스트" }

이메일 스레드:
${messageTexts}`;

  try {
    const aiText = await callProviderPrompt(prompt, { maxTokens: 500, timeoutMs: 30000 });
    const parsed = extractJson(aiText);
    const result = {
      summary: parsed?.summary || '요약을 생성할 수 없습니다.',
      messageCount: threadMessages.length,
      truncated
    };
    THREAD_SUMMARY_CACHE.set(cacheKey, result);
    return result;
  } catch (error) {
    return {
      summary: '요약 생성 시간이 초과되었습니다. 다시 시도해주세요.',
      messageCount: threadMessages.length,
      truncated,
      error: error.message
    };
  }
}
