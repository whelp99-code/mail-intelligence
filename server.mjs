import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMessages, sampleMailText } from './src/analyzer.js';

const root = fileURLToPath(new URL('./src', import.meta.url));
const appRoot = dirname(fileURLToPath(import.meta.url));
const configPath = join(appRoot, '.outlook-config.json');
const mailCachePath = join(appRoot, '.mail-cache.json');
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
  aiProvider: 'f-aios-v3',  // 'f-aios-v3' | 'gemini' | 'lmstudio'
  faiosServerUrl: 'http://localhost:3200',
  lmstudioModel: 'qwen/qwen3.5-9b'
};
const pendingOAuth = new Map();

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
  if (sender && sender === String(feedbackItem.sender || '').toLowerCase()) score += 2;
  const currentTokens = new Set(subjectTokens(message.subject));
  for (const token of feedbackItem.subjectTokens || []) {
    if (currentTokens.has(String(token).toLowerCase())) score += 1;
  }
  const text = `${message.subject || ''} ${message.bodyPreview || ''} ${message.body || ''}`.toLowerCase();
  if (feedbackItem.reasonCode === 'waiting' && /승인|회신|자료|대기|확인\s*부탁|pending|waiting/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'urgent' && /긴급|마감|오늘|금일|장애|critical|asap/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'done' && /완료|발송|처리|종료|resolved|completed|done/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'active' && /진행|검토|준비|공유|작성|review|follow/.test(text)) score += 1;
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

function mailboxPathForCurrentUser(messageId = '') {
  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const encodedId = encodeURIComponent(messageId);
  return mailboxUser
    ? `/users/${encodeURIComponent(mailboxUser)}/messages/${encodedId}`
    : `/me/messages/${encodedId}`;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
    faiosServerUrl: runtimeConfig.faiosServerUrl || 'http://localhost:3200',
    lmstudioModel: runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b',
    hasAccessToken: hasToken,
    hasTenantId: Boolean(getConfigValue('tenantId', 'MICROSOFT_TENANT_ID')),
    hasClientId: Boolean(getConfigValue('clientId', 'MICROSOFT_CLIENT_ID')),
    hasClientSecret: Boolean(getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET')),
    hasGeminiApiKey: Boolean(getConfigValue('geminiApiKey', 'GEMINI_API_KEY'))
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

function normalizeGraphMessage(message) {
  return {
    id: message.id,
    changeKey: message.changeKey || '',
    subject: message.subject || '(제목 없음)',
    from: message.from?.emailAddress?.address || message.sender?.emailAddress?.address || 'unknown',
    fromName: message.from?.emailAddress?.name || message.sender?.emailAddress?.name || '',
    cc: (message.ccRecipients || []).map((item) => item.emailAddress?.address).filter(Boolean),
    receivedAt: message.receivedDateTime,
    importance: message.importance,
    isRead: message.isRead,
    isPromotional: isPromotionalMessage(message),
    bodyPreview: message.bodyPreview || '',
    body: stripHtml(message.body?.content || message.bodyPreview || ''),
    webLink: message.webLink
  };
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
}

function latestReceivedAt(messages) {
  return sortMessages(messages).find((message) => message.receivedAt)?.receivedAt || '';
}

function mergeMessages(existingMessages, incomingMessages) {
  const byId = new Map();
  for (const message of existingMessages || []) {
    if (message?.id) byId.set(message.id, message);
  }
  let newCount = 0;
  let updatedCount = 0;
  for (const message of incomingMessages || []) {
    if (!message?.id) continue;
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
    updatedCount
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

function demoMessages() {
  return sampleMailText.split(/\n(?=Subject:)/).map((chunk, index) => {
    const subject = chunk.match(/^Subject:\s*(.+)$/m)?.[1] || `Demo mail ${index + 1}`;
    const from = chunk.match(/^From:\s*(.+)$/m)?.[1] || 'demo@example.com';
    const receivedAt = chunk.match(/^Date:\s*(.+)$/m)?.[1] || new Date().toISOString();
    return {
      id: `demo-${index + 1}`,
      subject,
      from,
      fromName: from.split('<')[0].trim(),
      receivedAt,
      importance: /긴급|오늘|마감/.test(chunk) ? 'high' : 'normal',
      isRead: false,
      bodyPreview: chunk.replace(/^Subject:.*$/m, '').replace(/^From:.*$/m, '').replace(/^Date:.*$/m, '').trim().slice(0, 220),
      body: chunk,
      webLink: ''
    };
  });
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

async function fetchGraphMessages({ accessToken, mailboxPath, top, since }) {
  const params = new URLSearchParams({
    '$top': String(Math.min(Math.max(top, 1), 50)),
    '$orderby': 'receivedDateTime desc',
    '$select': 'id,changeKey,subject,from,sender,ccRecipients,receivedDateTime,importance,isRead,bodyPreview,body,webLink'
  });
  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      params.set('$filter', `receivedDateTime gt ${sinceDate.toISOString()}`);
    }
  }

  const response = await fetch(`${graphBaseUrl}${mailboxPath}?${params}`, {
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
  return (payload.value || []).map(normalizeGraphMessage);
}

async function fetchOutlookMessages(top = 25) {
  const accessToken = await getGraphAccessToken();
  if (!accessToken) {
    return {
      connected: false,
      mode: 'demo',
      message: 'Microsoft Graph credentials are not configured.',
      messages: demoMessages()
    };
  }

  const mailboxUser = getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
  const mailboxPath = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}/mailFolders/inbox/messages` : '/me/mailFolders/inbox/messages';
  const cache = await loadMailCache();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const mailboxCache = cache.mailboxes[cacheKey] || { messages: [], lastSyncedAt: '', lastReceivedAt: '' };
  const cachedMessages = Array.isArray(mailboxCache.messages) ? mailboxCache.messages : [];
  const requestedTop = Math.min(Math.max(top, 1), 50);
  const shouldFetchOnlyNew = cachedMessages.length >= requestedTop;
  const since = shouldFetchOnlyNew ? latestReceivedAt(cachedMessages) : '';
  const incomingMessages = await fetchGraphMessages({ accessToken, mailboxPath, top, since });
  const merged = mergeMessages(cachedMessages, incomingMessages);
  cache.mailboxes[cacheKey] = {
    ...mailboxCache,
    messages: merged.messages,
    lastSyncedAt: new Date().toISOString(),
    lastReceivedAt: latestReceivedAt(merged.messages)
  };
  await saveMailCache(cache);

  return {
    connected: true,
    mode: mailboxUser ? 'application-mailbox' : 'delegated-me',
    message: cachedMessages.length
      ? 'Outlook inbox incrementally synced from Microsoft Graph.'
      : 'Outlook inbox loaded from Microsoft Graph.',
    messages: merged.messages,
    sync: {
      mailbox: cacheKey,
      mode: shouldFetchOnlyNew ? 'incremental' : 'initial',
      requestedAfter: since || null,
      fetchedFromGraph: incomingMessages.length,
      cachedBefore: cachedMessages.length,
      newCount: merged.newCount,
      updatedCount: merged.updatedCount,
      totalCached: merged.messages.length,
      lastSyncedAt: cache.mailboxes[cacheKey].lastSyncedAt
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

function clip(value = '', max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJson(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Gemini response did not contain JSON.');
    return JSON.parse(match[0]);
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
  const summaryLines = (summaries.length ? summaries : [message.bodyPreview || message.subject || '메일 내용을 확인했습니다.'])
    .slice(0, 3)
    .map((item) => `- ${item}`)
    .join('\n');
  const base = actions.length ? actions : [];
  const scenarioDefaults = [
    {
      title: '확인 및 진행 회신',
      intent: '요청을 접수하고 우리가 진행할 다음 단계를 명확히 알립니다.',
      recommendedAction: base[0]?.recommendedAction || '요청 사항을 확인하고 처리 예정 일정을 회신',
      lane: normalizeAiStatus(base[0]?.lane || 'active'),
      priority: Number(base[0]?.priority || 3),
      evidence: base[0]?.evidence || summaries[0] || message.bodyPreview || '',
      body: `안녕하세요.\n\n메일 내용 확인했습니다.\n\n핵심 내용은 아래와 같이 이해했습니다.\n${summaryLines}\n\n저희 쪽 다음 액션은 다음과 같습니다.\n- ${base[0]?.recommendedAction || '요청사항을 검토 후 진행 가능 여부와 일정을 회신드리겠습니다.'}\n\n확인 후 진행 상황을 업데이트드리겠습니다.\n\n감사합니다.`
    },
    {
      title: '추가 정보 요청',
      intent: '판단에 필요한 정보가 부족할 때 누락 정보를 요청합니다.',
      recommendedAction: base[1]?.recommendedAction || '진행 전 필요한 조건, 일정, 담당자, 범위를 추가 확인',
      lane: normalizeAiStatus(base[1]?.lane || 'waiting'),
      priority: Number(base[1]?.priority || 4),
      evidence: base[1]?.evidence || base[0]?.evidence || '',
      body: `안녕하세요.\n\n메일 내용 확인했습니다. 정확히 진행하기 위해 아래 사항을 추가로 확인 부탁드립니다.\n\n1. 요청 범위 또는 대상 시스템\n2. 희망 일정 및 마감 시점\n3. 관련 담당자 또는 승인 필요 여부\n\n현재 확인한 내용:\n${summaryLines}\n\n확인 주시면 그 기준으로 다음 단계 진행하겠습니다.\n\n감사합니다.`
    },
    {
      title: '자료 공유 및 미팅 제안',
      intent: 'Sangfor 자료, 메뉴얼, 관련 문서를 근거로 공유하거나 설명 일정을 제안합니다.',
      recommendedAction: base[2]?.recommendedAction || 'Sangfor 관련 자료 확인 후 공유하고 필요 시 설명 미팅 제안',
      lane: normalizeAiStatus(base[2]?.lane || 'active'),
      priority: Number(base[2]?.priority || 4),
      evidence: base[2]?.evidence || 'Sangfor 제품 페이지, 메뉴얼, 기존 발송자료, 관련 제안 문서를 확인해 첨부/링크를 확정하세요.',
      body: `안녕하세요.\n\n문의 주신 내용과 관련해 Sangfor 자료 및 관련 문서를 확인한 뒤 공유드리겠습니다.\n\n우선 확인할 자료 범위는 아래와 같습니다.\n- Sangfor 제품/기능 소개 페이지\n- 구축 또는 운영 메뉴얼\n- 기존 발송자료 및 관련 제안 문서\n\n메일에서 확인한 핵심 내용:\n${summaryLines}\n\n자료 확인 후 필요 시 짧은 설명 미팅도 함께 제안드리겠습니다.\n\n감사합니다.`
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

async function enrichWithAI(messages, result) {
  const provider = runtimeConfig.aiProvider || 'f-aios-v3';
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
    const cached = analysisCache[analysisCacheKey(message, provider)];
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
            aiCached: true
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
      ai: { enabled: true, provider, model: getModelName(provider), cached: messages.length }
    };
  }
  
  const prompt = buildAnalysisPrompt(feedbackExamples, messagesForAi);
  let aiText = '';
  
  try {
    if (provider === 'f-aios-v3') {
      aiText = await callFaiosServer(prompt);
    } else if (provider === 'gemini') {
      aiText = await callGeminiApi(prompt);
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
  const byId = new Map((ai.messages || []).map((item) => [item.id, item]));
  const aiMessageIds = new Set(messagesForAi.map((message) => message.id));
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
      subject: insight.subject,
      messageId: insight.id,
      receivedAt: insight.receivedAt,
      webLink: insight.webLink,
      intent: action.intent || '',
      to: action.to || message.from || '',
      subject: action.subject || replySubject(insight.subject),
      body: action.body || ''
    }));
    const nextActions = normalizeActionScenarios(message, aiActions, aiInsight.summary || insight.summary);
    return {
      ...insight,
      status,
      summary: Array.isArray(aiInsight.summary) && aiInsight.summary.length ? aiInsight.summary.slice(0, 4) : insight.summary,
      nextActions,
      evidenceItems: Array.isArray(aiInsight.evidenceItems) ? aiInsight.evidenceItems.slice(0, 6) : insight.evidenceItems,
      aiRationale: aiInsight.aiRationale || '',
      aiEnhanced: true
    };
  });

  for (const insight of enhancedInsights) {
    if (!aiMessageIds.has(insight.id) || !insight.aiEnhanced) continue;
    const message = messages.find((item) => item.id === insight.id);
    if (!message) continue;
    analysisCache[analysisCacheKey(message, model)] = {
      status: insight.status,
      summary: insight.summary,
      nextActions: insight.nextActions,
      evidenceItems: insight.evidenceItems,
      aiRationale: insight.aiRationale
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
    ai: { enabled: true, provider: 'gemini', model, analyzed: messagesForAi.length, cached: cachedById.size }
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
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
        for (const key of ['tenantId', 'clientId', 'mailboxUser', 'loginTenant', 'geminiModel', 'aiProvider', 'faiosServerUrl', 'lmstudioModel']) {
          if (typeof body[key] === 'string') runtimeConfig[key] = body[key].trim();
        }
        for (const key of ['accessToken', 'clientSecret', 'geminiApiKey']) {
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

  if (url.pathname === '/api/outlook/messages' || url.pathname === '/api/outlook/analyze') {
    try {
      const top = Number(url.searchParams.get('top') || 25);
      const data = await fetchOutlookMessages(top);
      if (url.pathname === '/api/outlook/messages') return json(res, 200, data);
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
        result,
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
      res.end('<h1>Outlook login complete</h1><p>이 창을 닫고 Mail Intelligence 화면에서 Outlook 가져오기를 누르세요.</p>');
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

await loadPersistedConfig();

server.listen(port, () => {
  console.log(`Mail Intelligence app running at http://localhost:${port}`);
});

// --- AI Helper Functions ---

function getModelName(provider) {
  if (provider === 'f-aios-v3') return 'F-AIOS-v3 (via LM Studio)';
  if (provider === 'gemini') return runtimeConfig.geminiModel || 'gemini-2.5-flash';
  return runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
}

function buildAnalysisPrompt(feedbackExamples, messagesForAi) {
  return `You are an executive email triage assistant. Analyze each email and return ONLY valid JSON.

Language: Korean.
Classify status as one of: urgent, active, waiting, done, reference.
For each email, provide concise summary bullets and exactly 3 next action scenarios.
Scenario 1 should be a direct confirmation/progress reply.
Scenario 2 should request missing details or clarify blockers.
Scenario 3 should share or reference Sangfor pages/manuals/related documents when relevant, otherwise propose a document-backed follow-up.
Do not invent facts. If no action is needed, create one action that says whether to archive, monitor, or review later.
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
      "aiRationale": "why this status/action was chosen"
    }
  ]
}

Emails:
${JSON.stringify(messagesForAi.map((message) => ({
    id: message.id,
    subject: message.subject,
    from: message.fromName || message.from,
    receivedAt: message.receivedAt,
    body: clip(message.body || message.bodyPreview, 4500)
  })), null, 2)}`;
}

async function callFaiosServer(prompt) {
  const serverUrl = runtimeConfig.faiosServerUrl || 'http://localhost:3200';
  
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

async function callLmStudio(prompt) {
  const model = runtimeConfig.lmstudioModel || 'qwen/qwen3.5-9b';
  
  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 8192,
      response_format: { type: 'json_object' }
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM Studio error: ${response.status} ${text}`);
  }
  
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || '';
}
