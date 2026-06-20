import { analyzeMessages } from './analyzer.js';
import { initKanban } from './kanban.js';
import { initKeyboard } from './keyboard.js';
import { initStats } from './stats.js';
import { initTheme } from './theme.js';
import { initSearch } from './search.js';
import { initNotifications } from './notifications.js';
import { loadConversationData, showConversationSection } from './conversationView.js';
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
let activeFolderId = 'inbox';
let searchQuery = '';
let selectedMessageId = '';
let attachmentEntries = [];
let outlookFolders = [];
let lastSyncedAt = null;
let restoredUiState = null;
const LAST_MAILBOX_KEY = 'mail-intelligence-last-mailbox';
const UI_STATE_KEY = 'mi-ui-state';

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

function formatMailTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const isThisYear = d.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
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

  const senderName = rep?.fromName || rep?.from || 'unknown';
  const timeStr = rep?.receivedAt ? formatMailTime(rep.receivedAt) : '';
  const head = document.createElement('div');
  head.className = 'thread-card-head';
  head.innerHTML = `
    <button type="button" class="thread-expand-btn" aria-expanded="${expanded}">${expanded ? '▼' : '▶'}</button>
    <div class="thread-card-main">
      <div class="tc-line1">
        <strong class="tc-sender"></strong>
        <span class="tc-badges"></span>
        <span class="tc-time"></span>
      </div>
      <div class="tc-line2">
        <span class="tc-subject"></span>
        <span class="tc-preview"></span>
      </div>
    </div>
  `;
  head.querySelector('.tc-sender').textContent = senderName;
  head.querySelector('.tc-time').textContent = timeStr;
  head.querySelector('.tc-subject').textContent = groupLabelFor(items);
  head.querySelector('.tc-preview').textContent =
    insightFor(rep?.id)?.summary?.[0] || rep?.bodyPreview || '';
  const badges = head.querySelector('.tc-badges');
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
  const senderName = message.fromName || message.from || 'unknown';
  const timeStr = message.receivedAt ? formatMailTime(message.receivedAt) : '';
  article.innerHTML = `
    <div class="mc-line1">
      <strong class="mc-sender"></strong>
      <span class="mc-time"></span>
    </div>
    <div class="mc-line2">
      <span class="mc-subject"></span>
    </div>
    <div class="mc-line3">
      <span class="mc-preview"></span>
    </div>
  `;
  article.querySelector('.mc-sender').textContent = senderName;
  article.querySelector('.mc-time').textContent = timeStr;
  article.querySelector('.mc-subject').textContent = message.subject || '(제목 없음)';
  article.querySelector('.mc-preview').textContent = insight?.summary?.[0] || message.bodyPreview || '';
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

async function prepareReplyDraft(action, selectedTone) {
  if (!action?.messageId) {
    mountComposer(action);
    return;
  }
  fetchStatus.textContent = '선택한 메일의 회신 초안을 생성하는 중입니다...';
  try {
    const toneParam = selectedTone ? `&tone=${encodeURIComponent(selectedTone)}` : '';
    const response = await fetch(`/api/outlook/reply-draft?messageId=${encodeURIComponent(action.messageId)}${toneParam}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '회신 초안 생성 실패');

    // Show tone picker if multiple options available and no tone selected
    if (Array.isArray(payload.options) && payload.options.length > 1 && !selectedTone) {
      showTonePicker(action, payload);
      fetchStatus.textContent = '회신 톤을 선택해주세요.';
      return;
    }

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

function showTonePicker(action, payload) {
  const existing = document.querySelector('.tone-picker-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'tone-picker-modal';
  modal.innerHTML = `
    <div class="tone-picker-content">
      <h4>회신 톤 선택</h4>
      <div class="tone-options">
        ${payload.options.map((opt) => `
          <button class="tone-option" data-tone="${opt.tone}">
            <strong>${opt.label || opt.tone}</strong>
            <span class="tone-preview">${(opt.body || '').slice(0, 80)}...</span>
          </button>
        `).join('')}
      </div>
      <button class="tone-picker-close" onclick="this.closest('.tone-picker-modal').remove()">취소</button>
    </div>
  `;

  modal.querySelectorAll('.tone-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      modal.remove();
      prepareReplyDraft(action, btn.dataset.tone);
    });
  });

  document.body.appendChild(modal);
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
        <span id="sendStatus">보낸 메일함에 저장됩니다. 승인 환경에서는 최종 승인 후 발송됩니다.</span>
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
  // Fetch approval status and update UI
  fetch('/api/outlook/approval-status').then((res) => res.json()).then((info) => {
    const sendStatus = mount.querySelector('#sendStatus');
    const sendBtn = mount.querySelector('#sendMail');
    if (info.requireApproval) {
      if (sendStatus) sendStatus.innerHTML = '⚠️ <strong>승인 필요 환경</strong> — 발송 시 AIOS approval이 필요합니다.';
      if (sendBtn) sendBtn.textContent = '발송 요청';
    }
  }).catch(() => {});
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
  persistMailboxUiState();
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
  status.textContent = '발송 요청 처리 중입니다.';
  try {
    const response = await fetch('/api/outlook/send-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.message || '발송 요청 실패');
    }
    if (result.approvalStatus === 'pending') {
      status.innerHTML = `<strong style="color:var(--urgent)">발송 승인 대기</strong> — 요청 ID: ${escapeHtml(result.requestId)}. 현재 앱에서는 대기 요청만 생성하며, AIOS 승인 처리 후 상태를 다시 확인해야 합니다.`;
      button.textContent = '대기 요청 생성됨';
      button.disabled = true;
      return;
    }
    if (result.approvalStatus === 'sent') {
      status.innerHTML = `<strong style="color:var(--done)">✓ 발송 완료</strong> · ${new Date().toLocaleString('ko-KR')}`;
      button.textContent = '발송 완료';
    } else if (result.approvalStatus === 'failed') {
      status.innerHTML = `<strong style="color:var(--urgent)">✗ 발송 실패</strong> — ${escapeHtml(result.error || '알 수 없는 오류')}`;
      button.disabled = false;
      button.textContent = 'Outlook으로 발송';
    } else {
      status.innerHTML = `<strong>요청 생성 완료</strong> — 상태: ${escapeHtml(result.approvalStatus)}`;
      button.disabled = false;
      button.textContent = 'Outlook으로 발송';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '메일 발송 실패';
    button.disabled = false;
    button.textContent = 'Outlook으로 발송';
  }
}

function laneForMessage(messageId) {
  const insight = insightFor(messageId);
  if (insight) {
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
  // Fallback: use lightweight _status from server
  const msg = currentMessages.find((m) => m.id === messageId);
  return msg?._status || 'reference';
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
    // Folder filter: match mailFolder against activeFolderId
    const mf = (message.mailFolder || 'inbox').toLowerCase();
    const matchesFolder = activeFolderId === 'all'
      || mf === activeFolderId
      || mf.replace(/\s+/g, '') === activeFolderId;
    // Status filter: use insight if available, otherwise use _status
    let matchesLane = true;
    if (activeFilter !== 'all') {
      const insight = insightFor(message.id);
      const status = insight ? laneForMessage(message.id) : (message._status || 'reference');
      matchesLane = activeFilter === 'unread' ? !message.isRead : status === activeFilter;
    }
    const matchesSearch = !query || searchableText(message).includes(query);
    return matchesFolder && matchesLane && matchesSearch;
  });
}

function actionVisible(action) {
  const visibleIds = new Set(visibleMessages.map((message) => message.id));
  return !action.messageId || visibleIds.has(action.messageId);
}

function selectedThreadMessages() {
  if (!selectedMessageId) return [];
  const selected = currentMessages.find((message) => message.id === selectedMessageId);
  if (!selected) return [];
  const groups = [...threadGroupsFor(currentMessages).values()];
  return groups.find((items) => items.some((message) => message.id === selectedMessageId)) || [selected];
}

function selectedThreadMessageIds() {
  return new Set(selectedThreadMessages().map((message) => message.id));
}

function threadContextItems(items = []) {
  const threadIds = selectedThreadMessageIds();
  if (!threadIds.size) return [];
  return items.filter((item) => item.messageId && threadIds.has(item.messageId));
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
    counts[lane].textContent = currentMessages.filter((message) => {
      const insight = insightFor(message.id);
      if (insight) return laneForMessage(message.id) === lane;
      return (message._status || 'reference') === lane;
    }).length;
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
  const selectedMessage = currentMessages.find((m) => m.id === selectedMessageId);
  const threadMessages = selectedThreadMessages();
  const threadIds = selectedThreadMessageIds();
  const threadRelatedActions = currentResult?.messageInsights
    ?.filter((insight) => threadIds.has(insight.id))
    .flatMap((insight) => insight.nextActions || [])
    .filter((action) => action.messageId !== selectedMessageId)
    .slice(0, 6) || [];
  const calendar = threadContextItems(currentResult.calendar || []);
  const reminders = threadContextItems(currentResult.reminders || []);
  actionCount.textContent = `${actions.length}건`;
  calendarCount.textContent = `${calendar.length}건`;
  reminderCount.textContent = `${reminders.length}건`;
  const alreadyReplied = userRepliedInThread(threadMessages, mailboxUser?.value || '');

  if (!actions.length) {
    actionList.appendChild(empty('선택한 메일의 추천 액션이 없습니다.'));
  } else if (alreadyReplied) {
    actionList.appendChild(empty('이 스레드는 이미 회신한 상태입니다. 상대 회신을 기다리면 대기로 분류하세요.'));
  } else {
    actions.forEach((item) => actionList.appendChild(scenarioActionCard(item)));
    if (threadRelatedActions.length) {
      const divider = document.createElement('div');
      divider.className = 'mini-section-label';
      divider.textContent = `${threadMessages.length}통 스레드 기준 추가 참고 액션`;
      actionList.appendChild(divider);
      threadRelatedActions.slice(0, 2).forEach((item) => actionList.appendChild(actionCard(item)));
    }
  }

  if (!calendar.length) {
    calendarList.appendChild(empty(selectedMessage ? '선택 스레드 기준 감지된 일정 없음' : '감지된 일정 없음'));
  }
  calendar.forEach((item) => calendarList.appendChild(simpleCard(item, item.lane)));

  if (!reminders.length) {
    reminderList.appendChild(empty(selectedMessage ? '선택 스레드 기준 알림 후보 없음' : '알림 후보 없음'));
  }
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
let configStatusRequestId = 0;
let configFormDirty = false;

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

function persistMailboxUiState() {
  try {
    sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({
      selectedMessageId,
      activeFilter,
      searchQuery,
      viewMode: document.body.classList.contains('kanban-mode') ? 'kanban'
        : document.body.classList.contains('stats-mode') ? 'stats'
          : 'list',
      attachmentOpen: !attachmentExplorer?.classList.contains('hidden')
    }));
  } catch {
    // Ignore session state failures.
  }
}

function persistMailboxPayload(payload) {
  try {
    sessionStorage.setItem(LAST_MAILBOX_KEY, JSON.stringify(payload));
    persistMailboxUiState();
  } catch {
    // Ignore session cache failures.
  }
}

function readPersistedUiState() {
  try {
    const raw = sessionStorage.getItem(UI_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function restoreUiPresentation(uiState) {
  if (!uiState) return;
  if (uiState.viewMode === 'kanban') {
    document.querySelector('#kanbanToggle')?.click();
  } else if (uiState.viewMode === 'stats') {
    document.querySelector('#statsToggle')?.click();
  }
  if (uiState.attachmentOpen) openAttachmentExplorer();
}

function restorePersistedMailbox() {
  try {
    const raw = sessionStorage.getItem(LAST_MAILBOX_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload?.messages?.length || !payload?.result) return false;
    restoredUiState = readPersistedUiState();
    if (restoredUiState?.activeFilter) activeFilter = restoredUiState.activeFilter;
    if (typeof restoredUiState?.searchQuery === 'string') {
      searchQuery = restoredUiState.searchQuery;
      mailSearch.value = restoredUiState.searchQuery;
    }
    if (restoredUiState?.selectedMessageId) selectedMessageId = restoredUiState.selectedMessageId;
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
    ${lastSyncedAt ? `<span class="sidebar-sync-time">마지막 동기화: ${new Date(lastSyncedAt).toLocaleString('ko-KR')}</span>` : ''}
  `;

  // Well-known folder display names
  const folderNames = {
    inbox: '받은편지함',
    sentitems: '보낸편지함',
    drafts: '임시 보관함',
    deleteditems: '삭제된 항목',
    junkemail: '정크 메일',
    archive: '보관함',
    outbox: '보낼 편지함'
  };

  // Build folder list: real Outlook folders first, then virtual filters
  const folderItems = [];
  if (outlookFolders.length > 0) {
    outlookFolders.forEach((f) => {
      const key = f.key || f.name.toLowerCase().replace(/\s+/g, '');
      const label = folderNames[key] || f.name;
      // Count messages in this folder using the key
      const folderMsgCount = currentMessages.filter((m) => {
        const mf = (m.mailFolder || 'inbox').toLowerCase();
        return mf === key;
      }).length;
      const folderUnread = currentMessages.filter((m) => {
        const mf = (m.mailFolder || 'inbox').toLowerCase();
        return !m.isRead && mf === key;
      }).length;
      folderItems.push({ key, label, count: folderMsgCount, unread: folderUnread, isFolder: true });
    });
  } else {
    // Fallback: show inbox/sent if no folder data
    folderItems.push({ key: 'inbox', label: '받은편지함', count: currentMessages.filter((m) => (m.mailFolder || 'inbox') === 'inbox').length, unread: currentMessages.filter((m) => !m.isRead && (m.mailFolder || 'inbox') === 'inbox').length, isFolder: true });
    folderItems.push({ key: 'sentitems', label: '보낸편지함', count: currentMessages.filter((m) => m.mailFolder === 'sentitems').length, unread: 0, isFolder: true });
  }

  // Virtual filters
  const virtualFilters = [
    { key: 'unread', label: '읽지 않음', count: unreadCount },
    { key: 'urgent', label: '긴급', count: countsByStatus.urgent },
    { key: 'active', label: '진행중', count: countsByStatus.active },
    { key: 'waiting', label: '대기', count: countsByStatus.waiting },
    { key: 'done', label: '완료', count: countsByStatus.done }
  ];

  folderList.innerHTML = `
    <div class="folder-section-label">폴더</div>
    ${folderItems.map((item) => `
      <button type="button" class="folder-item${activeFolderId === item.key ? ' selected' : ''}" data-folder="${item.key}" data-type="folder">
        <span>${escapeHtml(item.label)}</span>
        <span class="folder-counts">${item.unread > 0 ? `<strong>${item.unread}</strong> / ` : ''}${item.count}</span>
      </button>
    `).join('')}
    <div class="folder-section-label">상태 필터</div>
    ${virtualFilters.map((item) => `
      <button type="button" class="folder-item${activeFilter === item.key ? ' selected' : ''}" data-folder="${item.key}" data-type="filter">
        <span>${item.label}</span>
        <strong>${item.count}</strong>
      </button>
    `).join('')}
    <button type="button" class="folder-item${activeFilter === 'attachments' ? ' selected' : ''}" data-folder="attachments" data-type="filter">
      <span>첨부 보관함</span>
      <strong>${attachmentEntries.length}</strong>
    </button>
  `;
  // Smart recommendations
  const replyNeeded = currentMessages.filter((m) => {
    const ins = insightFor(m.id);
    const status = effectiveStatus(ins);
    return (status === 'urgent' || status === 'active') && !m.isRead;
  }).length;
  const approvalPending = 0; // Will be populated when approval queue is active
  const attachmentReusable = attachmentEntries.length;
  sidebarIdeas.innerHTML = [
    { icon: '↩', label: '답장 필요', count: replyNeeded, filter: 'unread' },
    { icon: '⏳', label: '승인 대기', count: approvalPending },
    { icon: '📎', label: '첨부 재사용 가능', count: attachmentReusable, filter: 'attachments' }
  ].map((item) => `
    <div class="recommendation-item${item.filter ? ' clickable' : ''}" data-folder="${item.filter || ''}">
      <span class="rec-icon">${item.icon}</span>
      <span class="rec-label">${item.label}</span>
      <strong class="rec-count">${item.count}건</strong>
    </div>
  `).join('');

  folderList.querySelectorAll('.folder-item').forEach((button) => {
    button.addEventListener('click', () => {
      const folder = button.dataset.folder;
      const type = button.dataset.type;
      if (folder === 'attachments') {
        openAttachmentExplorer();
        return;
      }
      if (type === 'folder') {
        // Folder navigation: filter by mailFolder, clear status filter
        activeFolderId = folder;
        activeFilter = 'all';
        searchQuery = '';
        mailSearch.value = '';
      } else {
        // Status filter: keep current folder, set status filter
        if (folder === 'unread') {
          searchQuery = '';
          mailSearch.value = '';
          activeFilter = 'unread';
        } else {
          activeFilter = folder;
        }
      }
      renderFilteredView();
    });
  });
  // Recommendation click handlers
  sidebarIdeas.querySelectorAll('.recommendation-item.clickable').forEach((item) => {
    item.addEventListener('click', () => {
      const folder = item.dataset.folder;
      if (folder === 'attachments') {
        openAttachmentExplorer();
        return;
      }
      if (folder) {
        activeFilter = folder;
        renderFilteredView();
      }
    });
  });
}

let attachmentCategory = 'all';

function renderAttachments(entries = attachmentEntries) {
  if (!attachmentList || !attachmentCount) return;
  const query = (attachmentSearch?.value || '').trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    // Category filter
    if (attachmentCategory !== 'all') {
      const cat = (entry.category || entry.categoryLabel || 'other').toLowerCase();
      if (attachmentCategory === 'document' && !/doc|pdf|text|txt|rtf|hwp/i.test(cat + entry.name)) return false;
      if (attachmentCategory === 'spreadsheet' && !/sheet|xls|csv|xlsx/i.test(cat + entry.name)) return false;
      if (attachmentCategory === 'presentation' && !/presentation|ppt|pptx|slides/i.test(cat + entry.name)) return false;
      if (attachmentCategory === 'sales' && !/sales|견적|quote|proposal|제안|proposal/i.test(cat + entry.name + (entry.subject || ''))) return false;
      if (attachmentCategory === 'other' && /doc|pdf|sheet|xls|presentation|ppt|sales|견적|quote|proposal/i.test(cat + entry.name)) return false;
    }
    // Search filter
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
        ${entry.subject ? `<div class="attachment-subject">메일: ${escapeHtml(entry.subject)}</div>` : ''}
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
  persistMailboxUiState();
}

function closeAttachmentExplorer() {
  if (!attachmentExplorer) return;
  attachmentExplorer.classList.add('hidden');
  attachmentExplorer.setAttribute('aria-hidden', 'true');
  persistMailboxUiState();
}

async function fetchFolders() {
  try {
    const response = await fetch('/api/outlook/folders');
    if (!response.ok) return;
    const data = await response.json();
    outlookFolders = data.folders || [];
    renderSidebar();
  } catch {
    outlookFolders = [];
  }
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
  lastSyncedAt = sync?.lastSyncedAt || null;
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
  // Always try cache first, even if Graph API is not connected
  const cached = await refreshMailbox({ sync: 'cache', silent: true });
  if (cached?.messages?.length) {
    fetchStatus.textContent = `캐시에서 ${cached.messages.length}건 메일을 표시했습니다.`;
    await loadAttachments();
    fetchFolders();
    // Try auto sync in background if connected
    if (outlookConnected) {
      refreshMailbox({ sync: 'auto', silent: true }).then(() => {
        loadAttachments();
        fetchFolders();
      });
    }
    return;
  }
  if (!outlookConnected) {
    fetchStatus.textContent = 'Outlook 연결 설정 후 메일이 자동으로 동기화됩니다.';
    return;
  }
  await refreshMailbox({ sync: 'auto' });
  await loadAttachments();
  fetchFolders();
}

function applyConfigFormFromStatus(status) {
  loginTenant.value = status.loginTenant || 'common';
  tenantId.value = status.tenantId || '';
  clientId.value = status.clientId || '';
  mailboxUser.value = status.mailboxUser || '';
  geminiModel.value = status.geminiModel || 'gemini-2.5-flash';
  aiProvider.value = status.aiProvider || 'f-aios-v3';
  faiosServerUrl.value = status.faiosServerUrl || 'http://localhost:3200';
  lmstudioModel.value = status.lmstudioModel || 'qwen/qwen3.5-9b';
  accessToken.value = '';
  clientSecret.value = '';
  geminiApiKey.value = '';
  accessToken.placeholder = status.hasAccessToken ? '저장된 토큰 사용 중' : '';
  clientSecret.placeholder = status.hasClientSecret ? '저장된 client secret 사용 중' : '';
  geminiApiKey.placeholder = status.hasGeminiApiKey ? '저장된 Gemini API key 사용 중' : '';
}

async function loadStatus({ force = false } = {}) {
  const requestId = ++configStatusRequestId;
  try {
    const response = await fetch('/api/outlook/config');
    const status = await response.json();
    if (!force && requestId !== configStatusRequestId) return status;
    if (!force && configFormDirty) return status;
    outlookConnected = Boolean(status.connected);
    connectionStatus.textContent = status.connected ? `Outlook 연결 준비됨 (${status.authMode})` : 'Outlook 인증값 필요';
    configStatus.textContent = status.connected ? `설정됨: ${status.authMode}` : '미설정';
    applyConfigFormFromStatus(status);
    configFormDirty = false;
    renderSidebar();
    return status;
  } catch {
    if (!force && requestId !== configStatusRequestId) return null;
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
  try {
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
    configFormDirty = false;
    configStatusRequestId += 1;
    outlookConnected = Boolean(status.connected);
    connectionStatus.textContent = status.connected ? `Outlook 연결 준비됨 (${status.authMode})` : 'Outlook 인증값 필요';
    configStatus.textContent = status.connected ? `설정됨: ${status.authMode}` : '미설정';
    applyConfigFormFromStatus(status);
    renderSidebar();
    await bootMailbox();
    await loadAttachments();
  } catch (error) {
    configStatus.textContent = error instanceof Error ? error.message : '저장 실패';
  }
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
    loadStatus({ force: true }).then(() => bootMailbox());
  }
});
configForm.addEventListener('input', () => {
  configFormDirty = true;
});
configForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveConfig(event);
});
document.querySelector('#saveConfig')?.addEventListener('click', saveConfig);
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
  configFormDirty = false;
  configStatusRequestId += 1;
  configStatus.textContent = '저장값 초기화';
  connectionStatus.textContent = 'Outlook 인증값 필요';
  outlookConnected = false;
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
window.persistMailboxUiState = persistMailboxUiState;

loadStatus().then(() => bootMailbox());
restorePersistedMailbox();
loadAttachments();
initKanban();
initKeyboard();
initStats();
initTheme();
initSearch();
initNotifications();
restoreUiPresentation(restoredUiState);

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
const refreshAttachments = document.querySelector('#refreshAttachments');
if (refreshAttachments) {
  refreshAttachments.addEventListener('click', async () => {
    refreshAttachments.disabled = true;
    refreshAttachments.textContent = '재탐색 중...';
    try {
      const syncRes = await fetch('/api/outlook/attachments/sync', { method: 'POST' });
      const syncResult = await syncRes.json();
      if (!syncRes.ok) throw new Error(syncResult.message || '첨부 동기화 실패');
      await loadAttachments();
      refreshAttachments.textContent = `재탐색 완료 (${syncResult.syncedEntries || 0}건)`;
      setTimeout(() => { refreshAttachments.textContent = '과거 자료 재탐색'; }, 3000);
    } catch (error) {
      refreshAttachments.textContent = `오류: ${error instanceof Error ? error.message : '재탐색 실패'}`;
      setTimeout(() => { refreshAttachments.textContent = '과거 자료 재탐색'; }, 5000);
    } finally {
      refreshAttachments.disabled = false;
    }
  });
}
// Attachment category filter
document.querySelectorAll('#attachmentCategoryFilter .cat-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#attachmentCategoryFilter .cat-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    attachmentCategory = btn.dataset.cat;
    renderAttachments();
  });
});


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
