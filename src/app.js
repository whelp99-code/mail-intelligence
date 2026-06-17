import { analyzeMessages } from './analyzer.js';
import { initKanban } from './kanban.js';
import { initKeyboard } from './keyboard.js';
import { initStats } from './stats.js';
import { initTheme } from './theme.js';
import { initSearch } from './search.js';
import { initNotifications } from './notifications.js';
import { initConversationView, loadConversationData, showConversationSection } from './conversationView.js';
import {
  groupMessagesByThread,
  latestMessageInThread,
  threadLabel,
  userRepliedInThread
} from './threadIdentity.mjs';

// 전역 상태 노출 (Kanban 모듈에서 접근용)
window.selectMessage = null;
window.saveFeedback = null;
window.renderFilteredView = null;
window.mountComposer = null;
window.currentMessages = [];
window.currentResult = null;
window.threadGroupList = [];
window.selectedMessageId = '';

const loadOutlook = document.querySelector('#loadOutlook');
const mailLimit = document.querySelector('#mailLimit');
const fetchStatus = document.querySelector('#fetchStatus');
const connectionStatus = document.querySelector('#connectionStatus');
const mailSearch = document.querySelector('#mailSearch');
const configForm = document.querySelector('#configForm');
const configStatus = document.querySelector('#configStatus');
const clearConfig = document.querySelector('#clearConfig');
const accessToken = document.querySelector('#accessToken');
const tenantId = document.querySelector('#tenantId');
const clientId = document.querySelector('#clientId');
const clientSecret = document.querySelector('#clientSecret');
const mailboxUser = document.querySelector('#mailboxUser');
const loginTenant = document.querySelector('#loginTenant');
const loginOutlook = document.querySelector('#loginOutlook');
const geminiApiKey = document.querySelector('#geminiApiKey');
const geminiModel = document.querySelector('#geminiModel');
const aiProvider = document.querySelector('#aiProvider');
const faiosServerUrl = document.querySelector('#faiosServerUrl');
const lmstudioModel = document.querySelector('#lmstudioModel');

const counts = {
  urgent: document.querySelector('#urgentCount'),
  active: document.querySelector('#activeCount'),
  waiting: document.querySelector('#waitingCount'),
  done: document.querySelector('#doneCount')
};

const sidebarAccount = document.querySelector('#sidebarAccount');
const folderList = document.querySelector('#folderList');
const sidebarIdeas = document.querySelector('#sidebarIdeas');
const openAttachments = document.querySelector('#openAttachments');
const attachmentExplorer = document.querySelector('#attachmentExplorer');
const closeAttachments = document.querySelector('#closeAttachments');
const attachmentList = document.querySelector('#attachmentList');
const attachmentCount = document.querySelector('#attachmentCount');
const attachmentSearch = document.querySelector('#attachmentSearch');
const feedbackReasons = {
  urgent: '마감/장애/고객 리스크',
  active: '우리가 처리해야 할 작업 있음',
  waiting: '상대방 회신/승인/자료 필요',
  done: '이미 처리/발송/종료됨',
  hold: '보류: 지금 처리하지 않고 추후 확인'
};
const feedbackStatuses = ['urgent', 'active', 'waiting', 'done'];
const feedbackReasonOptions = ['urgent', 'active', 'waiting', 'done', 'hold'];

let currentResult = null;
let currentMessages = [];
let visibleMessages = [];
let activeFilter = 'all';
let searchQuery = '';
let selectedMessageId = '';
let attachmentEntries = [];
const LAST_MAILBOX_KEY = 'mail-intelligence-last-mailbox';

function ui() {
  return {
    messageList: document.querySelector('#messageList'),
    messageCount: document.querySelector('#messageCount'),
    messageDetail: document.querySelector('#messageDetail'),
    actionList: document.querySelector('#actionList'),
    calendarList: document.querySelector('#calendarList'),
    reminderList: document.querySelector('#reminderList'),
    actionCount: document.querySelector('#actionCount'),
    calendarCount: document.querySelector('#calendarCount'),
    reminderCount: document.querySelector('#reminderCount')
  };
}

function restoreMailShellLayout() {
  const mailShell = document.querySelector('#mailShell');
  if (!mailShell) return;
  mailShell.innerHTML = `
    <aside id="messages" class="mail-list-panel">
      <div class="panel-head compact">
        <h3>메일 목록</h3>
        <span id="messageCount">0건</span>
      </div>
      <div id="messageList" class="message-list"></div>
    </aside>
    <div class="col-resizer" data-col="0"></div>
    <article id="messageDetail" class="detail-panel">
      <div class="empty">메일을 선택하면 요약, 핵심 내용, 다음 액션, 원문 미리보기가 표시됩니다.</div>
    </article>
    <div class="col-resizer" data-col="1"></div>
    <aside class="action-column">
      <section id="actions" class="panel">
        <div class="panel-head compact">
          <h3>다음 액션</h3>
          <span id="actionCount">0건</span>
        </div>
        <div id="actionList" class="stack"></div>
      </section>
      <section id="calendar" class="panel">
        <div class="panel-head compact">
          <h3>일정</h3>
          <span id="calendarCount">0건</span>
        </div>
        <div id="calendarList" class="stack"></div>
      </section>
      <section id="reminders" class="panel">
        <div class="panel-head compact">
          <h3>알림 후보</h3>
          <span id="reminderCount">0건</span>
        </div>
        <div id="reminderList" class="stack"></div>
      </section>
    </aside>
  `;
  window.initColumnResize?.();
}

window.restoreMailShellLayout = restoreMailShellLayout;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function empty(label) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = label;
  return node;
}

function insightFor(messageId) {
  return currentResult?.messageInsights?.find((item) => item.id === messageId);
}

function normalizedSubject(subject = '') {
  return String(subject || '')
    .replace(/^(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function threadGroupsFor(messages) {
  return groupMessagesByThread(messages, { mailboxUser: mailboxUser?.value || '' });
}

function groupLabelFor(messages) {
  const rep = latestMessageInThread(messages);
  const prefix = messages.some((m) => insightFor(m.id)?.isSpamCandidate || m.isPromotional) ? '광고성 후보 · ' : '';
  const replied = userRepliedInThread(messages, mailboxUser?.value || '');
  const replyHint = replied ? ' · 회신 완료' : '';
  return `${prefix}${threadLabel(messages)}${replyHint}`;
}

function threadCard(items, { expanded = false } = {}) {
  const rep = latestMessageInThread(items);
  const lane = laneForMessage(rep?.id);
  const replied = userRepliedInThread(items, mailboxUser?.value || '');
  const section = document.createElement('section');
  section.className = 'message-group thread-card';
  section.dataset.threadKey = threadKeyForList(items);

  const head = document.createElement('div');
  head.className = 'thread-card-head';
  head.innerHTML = `
    <button type="button" class="thread-expand-btn" aria-expanded="${expanded}">${expanded ? '▼' : '▶'}</button>
    <div class="thread-card-main">
      <strong class="thread-card-title"></strong>
      <span class="thread-badges"></span>
      <p class="thread-card-preview"></p>
    </div>
    <span class="status-pill thread-lane-pill"></span>
  `;
  head.querySelector('.thread-card-title').textContent = groupLabelFor(items);
  head.querySelector('.thread-card-preview').textContent =
    insightFor(rep?.id)?.summary?.[0] || rep?.bodyPreview || '';
  head.querySelector('.thread-lane-pill').textContent = statusLabel(lane);
  const badges = head.querySelector('.thread-badges');
  if (items.length > 1) {
    const count = document.createElement('span');
    count.className = 'thread-badge';
    count.textContent = `${items.length}통`;
    badges.appendChild(count);
  }
  if (replied) {
    const badge = document.createElement('span');
    badge.className = 'thread-badge replied';
    badge.textContent = '회신함';
    badges.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = `thread-card-body${expanded ? ' is-expanded' : ''}`;
  body.hidden = !expanded;
  items.forEach((message) => body.appendChild(messageCard(message)));

  head.querySelector('.thread-expand-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    const open = body.hidden;
    body.hidden = !open;
    body.classList.toggle('is-expanded', open);
    event.currentTarget.setAttribute('aria-expanded', String(open));
    event.currentTarget.textContent = open ? '▼' : '▶';
  });

  head.addEventListener('click', () => selectMessage(rep?.id));
  section.appendChild(head);
  section.appendChild(body);
  return section;
}

function threadKeyForList(items) {
  const rep = latestMessageInThread(items);
  return rep?.aiGroupKey || rep?.id || 'thread';
}

function messageCard(message) {
  const insight = insightFor(message.id);
  const lane = effectiveStatus(insight);
  const article = document.createElement('article');
  article.className = 'message-card';
  article.dataset.messageId = message.id;
  article.innerHTML = `
    <div class="message-row">
      <strong class="message-subject"></strong>
      <span class="status-pill"></span>
    </div>
    <div class="message-meta"></div>
    <div class="message-summary"></div>
    <div class="message-next"></div>
  `;
  article.querySelector('.message-subject').textContent = message.subject || '(제목 없음)';
  article.querySelector('.status-pill').textContent = `${statusLabel(lane)}${insight?.userFeedback ? ' · 내 보정' : ''}`;
  article.querySelector('.message-meta').textContent = `${message.isRead ? '읽음' : '읽지않음'} · ${message.fromName || message.from || 'unknown'} · ${message.receivedAt ? new Date(message.receivedAt).toLocaleString('ko-KR') : '날짜 없음'}${insight?.isSpamCandidate ? ' · 광고성 후보' : ''}${insight?.isOnHold ? ' · 보류' : ''}`;
  article.querySelector('.message-summary').textContent = insight?.summary?.[0] || message.bodyPreview || '';
  article.querySelector('.message-next').textContent = insight?.nextActions?.[0]?.recommendedAction || '후속 필요 여부 확인';
  if (insight?.aiEnhanced) article.classList.add('ai-enhanced');
  if (!message.isRead) article.classList.add('unread');
  if (insight?.isSpamCandidate) article.classList.add('promo');
  article.addEventListener('click', () => selectMessage(message.id));
  return article;
}

function actionCard(action) {
  const article = document.createElement('article');
  article.className = `mini-card ${action.lane}`;
  article.innerHTML = `
    <div class="mini-title"></div>
    <div class="mini-meta"></div>
    <p></p>
  `;
  article.querySelector('.mini-title').textContent = action.title || action.recommendedAction;
  article.querySelector('.mini-meta').textContent = [
    `P${action.priority}`,
    action.due ? `일정 ${action.due}` : '',
    action.owner && action.owner !== '미지정' ? action.owner : '',
    action.subject || ''
  ].filter(Boolean).join(' · ');
  article.querySelector('p').textContent = action.evidence || action.title || '';
  if (action.messageId) article.addEventListener('click', () => selectMessage(action.messageId));
  return article;
}

function scenarioActionCard(action) {
  const article = document.createElement('article');
  article.className = `mini-card scenario-action ${action.lane || 'active'}`;
  article.innerHTML = `
    <div class="mini-title"></div>
    <div class="mini-meta"></div>
    <p></p>
    <div class="scenario-action-buttons">
      <button type="button" class="prepare-mail">회신내용</button>
      <button type="button" class="custom-action">custom 작성</button>
    </div>
  `;
  article.querySelector('.mini-title').textContent = action.title || action.recommendedAction || '추천 액션';
  article.querySelector('.mini-meta').textContent = `추천 첨부파일: ${recommendedAttachment(action)}`;
  article.querySelector('p').textContent = action.body || action.recommendedAction || '';
  article.querySelector('.prepare-mail').addEventListener('click', () => prepareReplyDraft(action));
  article.querySelector('.custom-action').addEventListener('click', () => mountComposer({
    ...action,
    id: `custom-${action.messageId || 'message'}`,
    title: 'custom 작성',
    body: '',
    recommendedAction: '사용자 직접 작성'
  }));
  return article;
}

function recommendedAttachment(action) {
  const text = `${action.subject || ''} ${action.recommendedAction || ''} ${action.evidence || ''}`.toLowerCase();
  if (/sangfor|vdi|hci|제안|소개|자료|manual|메뉴얼|매뉴얼/.test(text)) return 'Sangfor 소개자료/메뉴얼/관련 제안서 확인';
  if (/견적|quote|가격|발주|계약/.test(text)) return '견적서 또는 계약 관련 문서 확인';
  if (/일정|미팅|회의|schedule/.test(text)) return '일정표 또는 회의 초대 확인';
  return '첨부 추천 없음. 필요 시 custom에서 직접 지정';
}

async function prepareReplyDraft(action) {
  if (!action?.messageId) {
    mountComposer(action);
    return;
  }
  fetchStatus.textContent = '선택한 메일의 회신 초안을 생성하는 중입니다...';
  try {
    const response = await fetch(`/api/outlook/reply-draft?messageId=${encodeURIComponent(action.messageId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '회신 초안 생성 실패');
    mountComposer({
      ...action,
      to: payload.to || action.to || '',
      cc: payload.cc || '',
      mailSubject: payload.subject || action.mailSubject || action.subject || '',
      body: payload.body || action.body || '',
      recommendedAttachments: payload.recommendedAttachments || []
    });
    fetchStatus.textContent = `${payload.source === 'lmstudio' ? '메일 이력 기반 AI' : '메일 캐시 기반'} 회신 초안을 불러왔습니다.${payload.threadNote ? ` ${payload.threadNote}` : ''}${payload.warning ? ` (${payload.warning})` : ''}`;
  } catch (error) {
    fetchStatus.textContent = error instanceof Error ? error.message : '회신 초안 생성 실패';
    mountComposer(action);
  }
}

function simpleCard(item, className = 'active') {
  const article = document.createElement('article');
  article.className = `mini-card ${className}`;
  article.innerHTML = `
    <div class="mini-title"></div>
    <div class="mini-meta"></div>
    <p></p>
  `;
  article.querySelector('.mini-title').textContent = item.title;
  article.querySelector('.mini-meta').textContent = item.when ? `일정 ${item.when} · ${item.owner}` : item.owner;
  article.querySelector('p').textContent = item.reason || item.subject || '';
  if (item.messageId) article.addEventListener('click', () => selectMessage(item.messageId));
  return article;
}

function detailBlock(title, values) {
  if (!values?.length) return '';
  return `
    <section class="detail-block">
      <h4>${escapeHtml(title)}</h4>
      <ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>
    </section>
  `;
}

function effectiveStatus(insight) {
  return insight?.effectiveStatus || insight?.status || 'reference';
}

function feedbackPanel(insight) {
  const applied = effectiveStatus(insight);
  const feedback = insight?.userFeedback;
  const reasonCode = feedback?.reasonCode || applied;
  return `
    <section class="feedback-panel">
      <div class="feedback-summary">
        <div><span>AI 판단</span><strong>${escapeHtml(statusLabel(insight?.status || 'reference'))}</strong></div>
        <div><span>내 보정</span><strong>${feedback ? escapeHtml(statusLabel(feedback.userStatus)) : '미지정'}</strong></div>
        <div><span>적용 분류</span><strong>${escapeHtml(statusLabel(applied))}</strong></div>
      </div>
      ${insight?.feedbackHint && !feedback ? `<p class="feedback-hint">이전 보정과 유사하여 ${escapeHtml(statusLabel(insight.feedbackHint.userStatus))} 기준을 참고했습니다.</p>` : ''}
      <div class="feedback-buttons" role="group" aria-label="분류 보정">
        ${feedbackStatuses.map((status) => `<button type="button" class="feedback-status ${applied === status ? 'selected' : ''}" data-status="${status}">${statusLabel(status)}</button>`).join('')}
      </div>
      <div class="feedback-form">
        <label>보정 이유
          <select id="feedbackReason">
            ${feedbackReasonOptions.map((status) => `<option value="${status}" ${reasonCode === status ? 'selected' : ''}>${feedbackReasons[status]}</option>`).join('')}
          </select>
        </label>
        <label>선택 메모
          <input id="feedbackNote" type="text" value="${escapeHtml(feedback?.note || '')}" placeholder="예: 승인 대기라 대기로 분류" />
        </label>
      </div>
      <div class="feedback-meta">
        <span id="feedbackStatus">${feedback ? `저장됨 · ${new Date(feedback.savedAt).toLocaleString('ko-KR')}` : '선택하면 다음 신규 메일 판단 기준에 반영됩니다.'}</span>
      </div>
    </section>
  `;
}

function mailComposer(action) {
  return `
    <section class="mail-composer" data-compose-action="${escapeHtml(action.id)}">
      <div class="composer-head">
        <h4>발송 메일 편집</h4>
        <span id="sendStatus">보낸 메일함에 저장됩니다.</span>
      </div>
      <label>받는 사람
        <input id="composeTo" type="email" value="${escapeHtml(action.to || '')}" />
      </label>
      <label>참조
        <input id="composeCc" type="text" placeholder="필요 시 쉼표로 여러 명 입력" />
      </label>
      <label>제목
        <input id="composeSubject" type="text" value="${escapeHtml(action.mailSubject || action.subject || '')}" />
      </label>
      <label>본문
        <textarea id="composeBody" rows="12">${escapeHtml(action.body || action.recommendedAction || '')}</textarea>
      </label>
      <div class="composer-actions">
        <button id="sendMail" type="button" class="primary">Outlook으로 발송</button>
        <button id="cancelCompose" type="button">닫기</button>
      </div>
    </section>
  `;
}

function formatComposerBody(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/\n\n/.test(value)) return value;
  return value
    .replace(/([.!?])\s+(?=[가-힣A-Za-z0-9])/g, '$1\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mountComposer(action) {
  const { messageDetail, actionList } = ui();
  const mount = messageDetail?.querySelector('#composeMount') || actionList;
  if (!mount) return;
  mount.innerHTML = mailComposer({
    ...action,
    body: formatComposerBody(action.body || action.recommendedAction || '')
  });
  mount.querySelector('#cancelCompose').addEventListener('click', () => {
    mount.innerHTML = '';
    renderActionPanel();
  });
  mount.querySelector('#sendMail').addEventListener('click', sendComposedMail);
  mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectMessage(messageId) {
  const { messageDetail, messageList } = ui();
  selectedMessageId = messageId;
  window.selectedMessageId = messageId;
  const message = currentMessages.find((item) => item.id === messageId);
  const insight = insightFor(messageId);
  if ((!message && !insight) || !messageDetail || !messageList) return;

  const actions = insight?.nextActions || [];
  const tasks = insight?.tasks || [];
  const preview = insight?.bodyPreview || message?.bodyPreview || message?.body || '';
  const fullBody = message?.body || preview || '';
  markMessageRead(messageId);

  messageDetail.innerHTML = `
    <div class="detail-head">
      <span class="status-pill">${escapeHtml(statusLabel(effectiveStatus(insight)))}${insight?.userFeedback ? ' · 내 보정' : insight?.aiEnhanced ? ' · AI' : ''}</span>
      ${message?.webLink ? `<a href="${escapeHtml(message.webLink)}" target="_blank" rel="noreferrer">Outlook에서 열기</a>` : ''}
    </div>
    <div class="detail-content">
      <h3>${escapeHtml(insight?.subject || message?.subject || '(제목 없음)')}</h3>
      <p class="detail-meta">${escapeHtml(insight?.fromName || message?.fromName || message?.from || 'unknown')} · ${message?.receivedAt ? new Date(message.receivedAt).toLocaleString('ko-KR') : '날짜 없음'} · ${escapeHtml(message?.importance || 'normal')}</p>
      <section class="detail-block first">
        <h4>메일 내용</h4>
        <p class="detail-body">${escapeHtml(fullBody).slice(0, 5000)}</p>
      </section>
      ${feedbackPanel(insight)}
      ${detailBlock('요약', insight?.summary || [])}
      ${detailBlock('판단 근거', insight?.evidenceItems?.length ? insight.evidenceItems : tasks.map((task) => `${task.title} (${task.lane}) - ${task.body}`))}
      ${insight?.userFeedback ? detailBlock('내 보정 메모', [insight.userFeedback.note || insight.userFeedback.reasonLabel || feedbackReasons[insight.userFeedback.reasonCode] || '보정 사유 없음']) : ''}
      ${insight?.aiRationale ? detailBlock('AI 판단 메모', [insight.aiRationale]) : ''}
      ${detailBlock('감지 일정', insight?.dates || [])}
    </div>
  `;

  messageDetail.querySelectorAll('.feedback-status').forEach((button) => {
    button.addEventListener('click', () => saveFeedback(messageId, button.dataset.status));
  });

  messageList.querySelectorAll('.message-card').forEach((node) => node.classList.remove('selected'));
  messageList.querySelector(`.message-card[data-message-id="${CSS.escape(messageId)}"]`)?.classList.add('selected');
  messageList.querySelectorAll('.thread-card').forEach((node) => node.classList.remove('selected'));
  messageList
    .querySelector(`.message-card[data-message-id="${CSS.escape(messageId)}"]`)
    ?.closest('.thread-card')
    ?.classList.add('selected');
  renderActionPanel();
}

async function markMessageRead(messageId) {
  const message = currentMessages.find((item) => item.id === messageId);
  if (!message || message.isRead) return;
  message.isRead = true;
  try {
    await fetch('/api/outlook/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, isRead: true })
    });
  } catch {
    // Keep local read state; Outlook update can be retried on next click.
  }
}

async function saveFeedback(messageId, userStatus, reasonCode = userStatus) {
  const insight = insightFor(messageId);
  const { messageDetail } = ui();
  const status = messageDetail?.querySelector('#feedbackStatus');
  const reason = messageDetail?.querySelector('#feedbackReason')?.value || reasonCode || userStatus;
  const note = messageDetail?.querySelector('#feedbackNote')?.value || '';
  if (status) status.textContent = '보정값 저장 중입니다.';
  try {
    const response = await fetch('/api/outlook/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        userStatus,
        reasonCode: reason,
        note,
        subject: insight?.subject || '',
        sender: insight?.from || ''
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '보정값 저장 실패');
    if (insight) {
      insight.userFeedback = result.feedback;
      insight.effectiveStatus = result.feedback.userStatus;
      insight.feedbackApplied = true;
    }
    fetchStatus.textContent = `분류 보정 저장 완료 · ${statusLabel(result.feedback.userStatus)} · 다음 분석 기준에 반영됩니다.`;
    renderFilteredView();
    return true;
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : '보정값 저장 실패';
    return false;
  }
}

async function sendComposedMail() {
  const status = document.querySelector('#sendStatus');
  const button = document.querySelector('#sendMail');
  const payload = {
    to: document.querySelector('#composeTo')?.value?.trim() || '',
    cc: document.querySelector('#composeCc')?.value?.trim() || '',
    subject: document.querySelector('#composeSubject')?.value?.trim() || '',
    body: document.querySelector('#composeBody')?.value?.trim() || ''
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.to)) {
    status.textContent = '받는 사람 이메일 형식을 확인하세요.';
    return;
  }
  if (!payload.subject) {
    status.textContent = '제목을 입력하세요.';
    return;
  }
  if (payload.body.length < 16) {
    status.textContent = '본문이 너무 짧습니다. 최소 16자 이상 입력하세요.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Outlook으로 발송 중입니다.';
  try {
    const response = await fetch('/api/outlook/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '메일 발송 실패');
    status.textContent = `발송 완료 · 보낸 메일함 저장 · ${new Date(result.sentAt).toLocaleString('ko-KR')}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '메일 발송 실패';
  } finally {
    button.disabled = false;
  }
}

function laneForMessage(messageId) {
  const insight = insightFor(messageId);
  if (!insight) return 'active';
  const applied = effectiveStatus(insight);
  if (applied === 'urgent') return 'urgent';
  if (applied === 'waiting') return 'waiting';
  if (applied === 'done') return 'done';
  if (applied === 'active' || applied === 'reference') return 'active';
  if (insight.tasks?.some((task) => task.lane === 'urgent')) return 'urgent';
  if (insight.tasks?.some((task) => task.lane === 'waiting')) return 'waiting';
  if (insight.tasks?.some((task) => task.lane === 'active')) return 'active';
  if (insight.tasks?.some((task) => task.lane === 'done')) return 'done';
  return 'active';
}

function statusLabel(status) {
  return {
    urgent: '긴급',
    active: '진행중',
    waiting: '대기',
    done: '완료',
    reference: '참고'
  }[status] || status || '참고';
}

function searchableText(message) {
  const insight = insightFor(message.id);
  return [
    message.subject,
    message.from,
    message.fromName,
    message.bodyPreview,
    message.body,
    ...(insight?.summary || []),
    ...(insight?.nextActions || []).map((action) => `${action.recommendedAction} ${action.evidence}`),
    ...(insight?.tasks || []).map((task) => `${task.title} ${task.body}`)
  ].join(' ').toLowerCase();
}

function filteredMessages() {
  const query = searchQuery.trim().toLowerCase();
  return currentMessages.filter((message) => {
    const matchesLane =
      activeFilter === 'all'
      || (activeFilter === 'unread' ? !message.isRead : laneForMessage(message.id) === activeFilter);
    const matchesSearch = !query || searchableText(message).includes(query);
    return matchesLane && matchesSearch;
  });
}

function actionVisible(action) {
  const visibleIds = new Set(visibleMessages.map((message) => message.id));
  return !action.messageId || visibleIds.has(action.messageId);
}

function refreshFilterButtons() {
  document.querySelectorAll('.metric').forEach((button) => {
    button.classList.toggle('selected', button.dataset.filter === activeFilter);
  });
}

function renderFilteredView() {
  const { messageList, messageCount, messageDetail } = ui();
  if (!messageList || !messageCount || !messageDetail) return;
  visibleMessages = filteredMessages().sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  refreshFilterButtons();

  Object.keys(counts).forEach((lane) => {
    counts[lane].textContent = currentMessages.filter((message) => laneForMessage(message.id) === lane).length;
  });

  clear(messageList);
  const unreadCount = visibleMessages.filter((message) => !message.isRead).length;
  messageCount.textContent = `${visibleMessages.length}건 · 읽지않음 ${unreadCount}건`;
  if (!visibleMessages.length) {
    selectedMessageId = '';
    window.selectedMessageId = '';
    messageList.appendChild(empty('조건에 맞는 메일이 없습니다.'));
    messageDetail.innerHTML = '<div class="empty">필터 또는 검색 조건을 조정하세요.</div>';
  } else {
    const groups = threadGroupsFor(visibleMessages);
    const sortedGroups = [...groups.values()].sort(
      (a, b) => new Date(latestMessageInThread(b)?.receivedAt || 0) - new Date(latestMessageInThread(a)?.receivedAt || 0)
    );
    sortedGroups.forEach((items) => {
      messageList.appendChild(threadCard(items));
    });
    window.threadGroupList = sortedGroups.map((items) => latestMessageInThread(items)?.id).filter(Boolean);
    const preferred = visibleMessages.find((message) => message.id === selectedMessageId) || visibleMessages[0];
    selectMessage(preferred.id);
  }

  renderActionPanel();
}

function renderActionPanel() {
  const { actionList, calendarList, reminderList, actionCount, calendarCount, reminderCount } = ui();
  if (!actionList || !calendarList || !reminderList || !actionCount || !calendarCount || !reminderCount) return;
  clear(actionList);
  clear(calendarList);
  clear(reminderList);
  const selectedInsight = insightFor(selectedMessageId);
  const actions = (selectedInsight?.nextActions || []).slice(0, 3);
  const calendar = (currentResult.calendar || []).filter(actionVisible);
  const reminders = (currentResult.reminders || []).filter(actionVisible);
  actionCount.textContent = `${actions.length}건`;
  calendarCount.textContent = `${calendar.length}건`;
  reminderCount.textContent = `${reminders.length}건`;

  const selectedMessage = currentMessages.find((m) => m.id === selectedMessageId);
  const threadMessages = selectedMessage
    ? [...(threadGroupsFor(currentMessages).values())].find((items) => items.some((m) => m.id === selectedMessageId)) || [selectedMessage]
    : [];
  const alreadyReplied = userRepliedInThread(threadMessages, mailboxUser?.value || '');

  if (!actions.length) actionList.appendChild(empty('선택한 메일의 추천 액션이 없습니다.'));
  else if (alreadyReplied) {
    actionList.appendChild(empty('이 스레드는 이미 회신한 상태입니다. 상대 회신을 기다리면 대기로 분류하세요.'));
  } else {
    actions.forEach((item) => actionList.appendChild(scenarioActionCard(item)));
  }

  if (!calendar.length) calendarList.appendChild(empty('감지된 일정 없음'));
  calendar.forEach((item) => calendarList.appendChild(simpleCard(item, item.lane)));

  if (!reminders.length) reminderList.appendChild(empty('알림 후보 없음'));
  reminders.forEach((item) => reminderList.appendChild(simpleCard(item, 'urgent')));
}

function render(result, messages = []) {
  currentResult = result;
  currentMessages = messages;
  // 전역 상태 업데이트 (Kanban 모듈에서 접근용)
  window.currentMessages = messages;
  window.currentResult = result;
  window.threadGroupsFor = threadGroupsFor;
  window.userRepliedInThread = userRepliedInThread;
  if (!mailSearch.value) searchQuery = '';
  if (!searchQuery) mailSearch.value = '';
  renderFilteredView();
}

let outlookConnected = false;

function formatSyncLabel(sync, messageCount) {
  if (!sync) return `${messageCount}개 메일`;
  if (sync.mode === 'cache') {
    return sync.totalCached
      ? `캐시 ${sync.totalCached}건${sync.lastSyncedAt ? ` · 마지막 동기화 ${new Date(sync.lastSyncedAt).toLocaleString('ko-KR')}` : ''}`
      : '캐시 비어 있음';
  }
  const modeLabel =
    sync.mode === 'incremental' ? '증분 동기화' : sync.mode === 'initial' ? '초기 동기화' : '동기화';
  return `${modeLabel} · 신규 ${sync.newCount || 0}건 · 변경 ${sync.updatedCount || 0}건 · 전체 ${sync.totalCached || messageCount}건`;
}

function persistMailboxPayload(payload) {
  try {
    sessionStorage.setItem(LAST_MAILBOX_KEY, JSON.stringify(payload));
  } catch {
    // ignore session cache failures
  }
}

function restorePersistedMailbox() {
  try {
    const raw = sessionStorage.getItem(LAST_MAILBOX_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload?.messages?.length || !payload?.result) return false;
    applyMailboxPayload(payload, { persist: false });
    fetchStatus.textContent = '직전 메일 캐시를 먼저 표시했습니다. 변경분을 확인하는 중...';
    return true;
  } catch {
    return false;
  }
}

function renderSidebar() {
  if (!sidebarAccount || !folderList || !sidebarIdeas) return;
  const unreadCount = currentMessages.filter((message) => !message.isRead).length;
  const countsByStatus = feedbackStatuses.reduce((acc, status) => {
    acc[status] = currentMessages.filter((message) => laneForMessage(message.id) === status).length;
    return acc;
  }, {});
  const accountLabel = mailboxUser.value?.trim() || 'Outlook 계정 미지정';
  sidebarAccount.innerHTML = `
    <strong>${escapeHtml(accountLabel)}</strong>
    <span>${outlookConnected ? '증분 동기화 사용 중' : '연결 필요'} · 전체 ${currentMessages.length}건 · 미읽음 ${unreadCount}건</span>
  `;
  folderList.innerHTML = [
    { key: 'all', label: '받은편지함', count: currentMessages.length },
    { key: 'unread', label: '읽지 않음', count: unreadCount },
    { key: 'urgent', label: '긴급', count: countsByStatus.urgent },
    { key: 'waiting', label: '대기', count: countsByStatus.waiting },
    { key: 'done', label: '완료', count: countsByStatus.done },
    { key: 'attachments', label: '첨부 보관함', count: attachmentEntries.length }
  ].map((item) => `
    <button type="button" class="folder-item" data-folder="${item.key}">
      <span>${item.label}</span>
      <strong>${item.count}</strong>
    </button>
  `).join('');
  sidebarIdeas.innerHTML = [
    '왼쪽 사이드바에 계정별 폴더와 미읽음/긴급/대기 큐를 고정했습니다.',
    '첨부 보관함을 별도 페이지처럼 열어 과거 발송 자료를 다시 찾을 수 있게 했습니다.',
    '회신 초안은 선택 메일 기준으로 동일 스레드와 과거 발신 메일을 참고해 생성합니다.'
  ].map((text) => `<div class="idea-item">${escapeHtml(text)}</div>`).join('');

  folderList.querySelectorAll('.folder-item').forEach((button) => {
    button.addEventListener('click', () => {
      const folder = button.dataset.folder;
      if (folder === 'attachments') {
        openAttachmentExplorer();
        return;
      }
      if (folder === 'unread') {
        searchQuery = '';
        mailSearch.value = '';
        activeFilter = 'unread';
        renderFilteredView();
        return;
      }
      activeFilter = folder === 'all' ? 'all' : folder;
      renderFilteredView();
    });
  });
}

function renderAttachments(entries = attachmentEntries) {
  if (!attachmentList || !attachmentCount) return;
  const query = (attachmentSearch?.value || '').trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    const haystack = [
      entry.name,
      entry.subject,
      entry.from,
      entry.fromName,
      ...(entry.tags || []),
      ...(entry.aiTags || [])
    ].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  attachmentCount.textContent = `${filtered.length}건`;
  attachmentList.innerHTML = filtered.length
    ? filtered.map((entry) => `
      <article class="attachment-card">
        <div class="attachment-row">
          <strong>${escapeHtml(entry.name || '(이름 없음)')}</strong>
          <span class="status-pill">${escapeHtml(entry.categoryLabel || entry.category || '기타')}</span>
        </div>
        <div class="attachment-meta">${escapeHtml(entry.fromName || entry.from || 'unknown')} · ${entry.receivedAt ? new Date(entry.receivedAt).toLocaleString('ko-KR') : '날짜 없음'} · ${(entry.size || 0).toLocaleString('ko-KR')} bytes</div>
        <div class="attachment-subject">${escapeHtml(entry.subject || '')}</div>
        <div class="attachment-tags">${[...(entry.tags || []), ...(entry.aiTags || [])].slice(0, 6).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      </article>
    `).join('')
    : '<div class="empty">첨부파일 검색 결과가 없습니다.</div>';
}

function openAttachmentExplorer() {
  if (!attachmentExplorer) return;
  attachmentExplorer.classList.remove('hidden');
  attachmentExplorer.setAttribute('aria-hidden', 'false');
  renderAttachments();
}

function closeAttachmentExplorer() {
  if (!attachmentExplorer) return;
  attachmentExplorer.classList.add('hidden');
  attachmentExplorer.setAttribute('aria-hidden', 'true');
}

async function loadAttachments() {
  try {
    const response = await fetch('/api/outlook/attachments');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '첨부파일 목록 로드 실패');
    attachmentEntries = payload.entries || [];
    renderSidebar();
    renderAttachments();
  } catch {
    attachmentEntries = [];
    renderSidebar();
  }
}

function applyMailboxPayload(payload, { persist = true } = {}) {
  const sync = payload.sync;
  const syncLabel = formatSyncLabel(sync, payload.messages.length);
  const ai = payload.result?.ai;
  const aiLabel = ai?.enabled
    ? `${ai.provider === 'f-aios-v3' ? 'F-AIOS-v3' : ai.provider === 'gemini' ? 'Gemini' : 'LM Studio'} AI 적용 (${ai.model}${Number.isFinite(ai.analyzed) ? ` · 신규분석 ${ai.analyzed}건` : ''}${Number.isFinite(ai.cached) ? ` · 캐시 ${ai.cached}건` : ''})`
    : '규칙 기반';
  fetchStatus.textContent = payload.connected
    ? `${syncLabel} · ${aiLabel} · ${new Date(payload.analyzedAt).toLocaleString('ko-KR')}`
    : `Outlook 인증값이 없어 데모 메일로 분석했습니다. ${payload.message}`;
  connectionStatus.textContent = payload.connected ? `Outlook 연결됨 (${payload.mode})` : 'Outlook 인증값 필요';
  render(payload.result, payload.messages);
  renderSidebar();
  if (persist) persistMailboxPayload(payload);
}

async function refreshMailbox({ sync = 'auto', silent = false } = {}) {
  if (!silent) loadOutlook.disabled = true;
  if (!silent && sync === 'initial') {
    fetchStatus.textContent = 'Outlook에서 메일을 가져오는 중입니다...';
  } else if (!silent && sync === 'auto') {
    fetchStatus.textContent = '변경된 메일을 확인하는 중입니다...';
  }
  try {
    const response = await fetch(
      `/api/outlook/analyze?top=${encodeURIComponent(mailLimit.value)}&sync=${encodeURIComponent(sync)}`
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Outlook fetch failed');
    applyMailboxPayload(payload);
    return payload;
  } catch (error) {
    if (!silent || sync !== 'cache') {
      fetchStatus.textContent = error instanceof Error ? error.message : 'Outlook을 가져오지 못했습니다.';
      connectionStatus.textContent = 'Outlook 연결 실패';
    }
    return null;
  } finally {
    if (!silent) loadOutlook.disabled = false;
  }
}

async function bootMailbox() {
  if (!outlookConnected) {
    fetchStatus.textContent = 'Outlook 연결 설정 후 메일이 자동으로 동기화됩니다.';
    return;
  }
  const cached = await refreshMailbox({ sync: 'cache', silent: true });
  if (!cached?.messages?.length) {
    await refreshMailbox({ sync: 'auto' });
    await loadAttachments();
    return;
  }
  fetchStatus.textContent = '캐시에서 메일을 표시했습니다. 변경분을 확인하는 중...';
  await refreshMailbox({ sync: 'auto', silent: true });
  await loadAttachments();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/outlook/config');
    const status = await response.json();
    outlookConnected = Boolean(status.connected);
    connectionStatus.textContent = status.connected ? `Outlook 연결 준비됨 (${status.authMode})` : 'Outlook 인증값 필요';
    configStatus.textContent = status.connected ? `설정됨: ${status.authMode}` : '미설정';
    loginTenant.value = status.loginTenant || 'common';
    tenantId.value = status.tenantId || '';
    clientId.value = status.clientId || '';
    mailboxUser.value = status.mailboxUser || '';
    geminiModel.value = status.geminiModel || 'gemini-2.5-flash';
    // AI Provider settings
    aiProvider.value = status.aiProvider || 'f-aios-v3';
    faiosServerUrl.value = status.faiosServerUrl || 'http://localhost:3201';
    lmstudioModel.value = status.lmstudioModel || 'qwen/qwen3.5-9b';
    accessToken.placeholder = status.hasAccessToken ? '저장된 토큰 사용 중' : '';
    clientSecret.placeholder = status.hasClientSecret ? '저장된 client secret 사용 중' : '';
    geminiApiKey.placeholder = status.hasGeminiApiKey ? '저장된 Gemini API key 사용 중' : '';
    renderSidebar();
    return status;
  } catch {
    outlookConnected = false;
    connectionStatus.textContent = 'Outlook 상태 확인 실패';
    configStatus.textContent = '확인 실패';
    renderSidebar();
    return null;
  }
}

async function saveConfig(event) {
  event.preventDefault();
  configStatus.textContent = '저장 중';
  const response = await fetch('/api/outlook/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: accessToken.value,
      tenantId: tenantId.value,
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      mailboxUser: mailboxUser.value,
      loginTenant: loginTenant.value,
      geminiApiKey: geminiApiKey.value,
      geminiModel: geminiModel.value,
      aiProvider: aiProvider.value,
      faiosServerUrl: faiosServerUrl.value,
      lmstudioModel: lmstudioModel.value,
      persist: true
    })
  });
  const status = await response.json();
  if (!response.ok) {
    configStatus.textContent = status.message || '저장 실패';
    return;
  }
  connectionStatus.textContent = status.connected ? `Outlook 연결 준비됨 (${status.authMode})` : 'Outlook 인증값 필요';
  configStatus.textContent = status.connected ? `설정됨: ${status.authMode}` : '미설정';
  outlookConnected = Boolean(status.connected);
  await bootMailbox();
  await loadAttachments();
}

function startOutlookLogin() {
  const selectedClientId = clientId.value.trim();
  if (!selectedClientId) {
    configStatus.textContent = 'Client ID를 먼저 입력하세요.';
    clientId.focus();
    return;
  }
  const params = new URLSearchParams({
    clientId: selectedClientId,
    tenantId: loginTenant.value,
    mailboxUser: mailboxUser.value.trim()
  });
  window.open(`/api/outlook/oauth/start?${params}`, 'outlookLogin', 'width=720,height=760');
  configStatus.textContent = 'Microsoft 로그인 창에서 권한을 승인하세요.';
}

async function loadOutlookMessages() {
  await refreshMailbox({ sync: 'initial' });
}

loadOutlook.addEventListener('click', loadOutlookMessages);
window.addEventListener('message', (event) => {
  if (event?.data?.type === 'outlook-oauth-complete') {
    loadStatus().then(() => bootMailbox());
  }
});
configForm.addEventListener('submit', saveConfig);
loginOutlook.addEventListener('click', startOutlookLogin);
clearConfig.addEventListener('click', async () => {
  accessToken.value = '';
  tenantId.value = '';
  clientId.value = '';
  clientSecret.value = '';
  mailboxUser.value = '';
  loginTenant.value = 'common';
  geminiApiKey.value = '';
  geminiModel.value = 'gemini-2.5-flash';
  aiProvider.value = 'f-aios-v3';
  faiosServerUrl.value = 'http://localhost:3201';
  lmstudioModel.value = 'qwen/qwen3.5-9b';
  await fetch('/api/outlook/config', { method: 'DELETE' });
  configStatus.textContent = '저장값 초기화';
  connectionStatus.textContent = 'Outlook 인증값 필요';
  renderSidebar();
});
document.querySelectorAll('.metric').forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = activeFilter === button.dataset.filter ? 'all' : button.dataset.filter;
    renderFilteredView();
  });
});
mailSearch.addEventListener('input', () => {
  searchQuery = mailSearch.value;
  renderFilteredView();
});

// 전역 함수 노출 (Kanban 모듈에서 접근용)
window.selectMessage = selectMessage;
window.saveFeedback = saveFeedback;
window.renderFilteredView = renderFilteredView;
window.mountComposer = mountComposer;

loadStatus().then(() => bootMailbox());
restorePersistedMailbox();
loadAttachments();
initKanban();
initKeyboard();
initStats();
initTheme();
initSearch();
initNotifications();
initConversationView();

// Conversation toggle
const conversationToggle = document.getElementById('conversationToggle');
const conversationView = document.getElementById('conversationView');
const mailShell = document.getElementById('mailShell');

if (conversationToggle && conversationView && mailShell) {
  conversationToggle.addEventListener('click', async () => {
    const isHidden = conversationView.classList.contains('hidden');
    
    if (isHidden) {
      conversationView.classList.remove('hidden');
      conversationView.setAttribute('aria-hidden', 'false');
      mailShell.classList.add('hidden');
      conversationToggle.textContent = '📧 메일 보기';
      await loadConversationData();
    } else {
      conversationView.classList.add('hidden');
      conversationView.setAttribute('aria-hidden', 'true');
      mailShell.classList.remove('hidden');
      conversationToggle.textContent = '📞 대화 분석';
    }
  });
}

// Conversation tab switching
document.querySelectorAll('.conversation-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.conversation-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showConversationSection(btn.dataset.tab);
  });
});

// Refresh conversations
const refreshConversations = document.getElementById('refreshConversations');
if (refreshConversations) {
  refreshConversations.addEventListener('click', () => loadConversationData());
}

openAttachments?.addEventListener('click', openAttachmentExplorer);
closeAttachments?.addEventListener('click', closeAttachmentExplorer);
attachmentSearch?.addEventListener('input', () => renderAttachments());

// --- Column Resize (Drag & Drop) ---
function initColumnResize() {
  const shell = document.getElementById('mailShell');
  if (!shell) return;
  const resizers = shell.querySelectorAll('.col-resizer');
  if (!resizers.length) return;
  const minWidths = [320, 420, 320];
  const getColumnWidths = () => {
    const columns = [...shell.children].filter((el) =>
      el.classList.contains('mail-list-panel') ||
      el.classList.contains('detail-panel') ||
      el.classList.contains('action-column')
    );
    return columns.map((col) => Math.round(col.getBoundingClientRect().width));
  };
  
  resizers.forEach((resizer) => {
    let startX;
    let startWidths;
    let colIndex;
    
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      colIndex = parseInt(resizer.dataset.col, 10);
      startX = e.clientX;
      startWidths = getColumnWidths();
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      
      const onMouseMove = (e) => {
        const dx = e.clientX - startX;
        const widths = [...startWidths];
        widths[colIndex] = Math.max(minWidths[colIndex], startWidths[colIndex] + dx);
        widths[colIndex + 1] = Math.max(minWidths[colIndex + 1], startWidths[colIndex + 1] - dx);
        shell.style.gridTemplateColumns = `${widths[0]}px 6px ${widths[1]}px 6px ${widths[2]}px`;
      };
      
      const onMouseUp = () => {
        resizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    
    resizer.addEventListener('dblclick', () => {
      shell.style.gridTemplateColumns = '';
    });
  });
}

window.initColumnResize = initColumnResize;
initColumnResize();
