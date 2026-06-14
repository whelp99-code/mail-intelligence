import { analyzeMessages } from './analyzer.js';
import { initKanban } from './kanban.js';
import { initKeyboard } from './keyboard.js';

// 전역 상태 노출 (Kanban 모듈에서 접근용)
window.selectMessage = null;
window.saveFeedback = null;
window.renderFilteredView = null;
window.currentMessages = [];
window.currentResult = null;

const loadSample = document.querySelector('#loadSample');
const loadOutlook = document.querySelector('#loadOutlook');
const mailLimit = document.querySelector('#mailLimit');
const fetchStatus = document.querySelector('#fetchStatus');
const connectionStatus = document.querySelector('#connectionStatus');
const messageList = document.querySelector('#messageList');
const messageCount = document.querySelector('#messageCount');
const messageDetail = document.querySelector('#messageDetail');
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

const actionList = document.querySelector('#actionList');
const calendarList = document.querySelector('#calendarList');
const reminderList = document.querySelector('#reminderList');
const actionCount = document.querySelector('#actionCount');
const calendarCount = document.querySelector('#calendarCount');
const reminderCount = document.querySelector('#reminderCount');
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

function groupLabelFor(message) {
  const sender = message.fromName || message.from || 'unknown';
  const domain = String(message.from || '').split('@')[1] || sender;
  const subject = normalizedSubject(message.subject) || '(제목 없음)';
  const prefix = message.isPromotional ? '광고성 후보 · ' : '';
  return `${prefix}${domain} · ${sender} · ${subject}`;
}

function messageCard(message) {
  const insight = insightFor(message.id);
  const lane = effectiveStatus(insight);
  const article = document.createElement('article');
  article.className = 'message-card';
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
  article.querySelector('.prepare-mail').addEventListener('click', () => mountComposer(action));
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

function mountComposer(action) {
  const mount = messageDetail.querySelector('#composeMount') || actionList;
  mount.innerHTML = mailComposer(action);
  mount.querySelector('#cancelCompose').addEventListener('click', () => {
    mount.innerHTML = '';
    renderActionPanel();
  });
  mount.querySelector('#sendMail').addEventListener('click', sendComposedMail);
  mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectMessage(messageId) {
  selectedMessageId = messageId;
  const message = currentMessages.find((item) => item.id === messageId);
  const insight = insightFor(messageId);
  if (!message && !insight) return;

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
  const index = currentMessages.findIndex((item) => item.id === messageId);
  if (index >= 0) messageList.querySelectorAll('.message-card')[index]?.classList.add('selected');
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

async function saveFeedback(messageId, userStatus) {
  const insight = insightFor(messageId);
  const status = messageDetail.querySelector('#feedbackStatus');
  const reason = messageDetail.querySelector('#feedbackReason')?.value || userStatus;
  const note = messageDetail.querySelector('#feedbackNote')?.value || '';
  status.textContent = '보정값 저장 중입니다.';
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
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '보정값 저장 실패';
  }
}

async function sendComposedMail() {
  const status = document.querySelector('#sendStatus');
  const button = document.querySelector('#sendMail');
  const payload = {
    to: document.querySelector('#composeTo')?.value || '',
    cc: document.querySelector('#composeCc')?.value || '',
    subject: document.querySelector('#composeSubject')?.value || '',
    body: document.querySelector('#composeBody')?.value || ''
  };
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
    const matchesLane = activeFilter === 'all' || laneForMessage(message.id) === activeFilter;
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
  visibleMessages = filteredMessages().sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  refreshFilterButtons();

  Object.keys(counts).forEach((lane) => {
    counts[lane].textContent = currentMessages.filter((message) => laneForMessage(message.id) === lane).length;
  });

  clear(messageList);
  const unreadCount = visibleMessages.filter((message) => !message.isRead).length;
  messageCount.textContent = `${visibleMessages.length}건 · 읽지않음 ${unreadCount}건`;
  if (!visibleMessages.length) {
    messageList.appendChild(empty('조건에 맞는 메일이 없습니다.'));
    messageDetail.innerHTML = '<div class="empty">필터 또는 검색 조건을 조정하세요.</div>';
  } else {
    const groups = new Map();
    visibleMessages.forEach((message) => {
      const label = groupLabelFor(message);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(message);
    });
    groups.forEach((items, label) => {
      const group = document.createElement('section');
      group.className = 'message-group';
      const laneSummary = feedbackStatuses
        .map((lane) => `${statusLabel(lane)} ${items.filter((item) => laneForMessage(item.id) === lane).length}`)
        .join(' · ');
      group.innerHTML = `<div class="group-head"><strong></strong><span></span></div>`;
      group.querySelector('strong').textContent = label;
      group.querySelector('span').textContent = `${items.length}건 · ${laneSummary}`;
      items.forEach((message) => group.appendChild(messageCard(message)));
      messageList.appendChild(group);
    });
    const preferred = visibleMessages.find((message) => message.id === selectedMessageId) || visibleMessages[0];
    selectMessage(preferred.id);
  }

  renderActionPanel();
}

function renderActionPanel() {
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

  if (!actions.length) actionList.appendChild(empty('선택한 메일의 추천 액션이 없습니다.'));
  actions.forEach((item) => actionList.appendChild(scenarioActionCard(item)));

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
  activeFilter = 'all';
  searchQuery = '';
  mailSearch.value = '';
  renderFilteredView();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/outlook/config');
    const status = await response.json();
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
  } catch {
    connectionStatus.textContent = 'Outlook 상태 확인 실패';
    configStatus.textContent = '확인 실패';
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
  await loadOutlookMessages();
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
  loadOutlook.disabled = true;
  fetchStatus.textContent = 'Outlook 신규 메일을 확인하는 중입니다. 기존 메일은 로컬 캐시에 유지합니다.';
  try {
    const response = await fetch(`/api/outlook/analyze?top=${encodeURIComponent(mailLimit.value)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Outlook fetch failed');
    const sync = payload.sync;
    const syncLabel = sync
      ? `${sync.mode === 'incremental' ? '신규 동기화' : '초기 동기화'} · 신규 ${sync.newCount}건 · 변경 ${sync.updatedCount}건 · 전체 ${sync.totalCached}건`
      : `${payload.messages.length}개 메일`;
    const ai = payload.result?.ai;
    const aiLabel = ai?.enabled
      ? `${ai.provider === 'f-aios-v3' ? 'F-AIOS-v3' : ai.provider === 'gemini' ? 'Gemini' : 'LM Studio'} AI 적용 (${ai.model}${Number.isFinite(ai.analyzed) ? ` · 신규분석 ${ai.analyzed}건` : ''}${Number.isFinite(ai.cached) ? ` · 캐시 ${ai.cached}건` : ''})`
      : '규칙 기반';
    fetchStatus.textContent = payload.connected
      ? `${syncLabel} 분석 완료 · ${aiLabel} · ${new Date(payload.analyzedAt).toLocaleString('ko-KR')}`
      : `Outlook 인증값이 없어 데모 메일로 분석했습니다. ${payload.message}`;
    connectionStatus.textContent = payload.connected ? `Outlook 연결됨 (${payload.mode})` : 'Outlook 인증값 필요';
    render(payload.result, payload.messages);
  } catch (error) {
    fetchStatus.textContent = error instanceof Error ? error.message : 'Outlook을 가져오지 못했습니다.';
    connectionStatus.textContent = 'Outlook 연결 실패';
  } finally {
    loadOutlook.disabled = false;
  }
}

loadSample.addEventListener('click', () => {
  fetchStatus.textContent = '데모 데이터 버튼은 비활성화되었습니다. 실제 Outlook 연동 후 사용하세요.';
});

loadOutlook.addEventListener('click', loadOutlookMessages);
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

loadStatus();
initKanban();
initKeyboard();

// --- Column Resize (Drag & Drop) ---
(function initColumnResize() {
  const shell = document.getElementById('mailShell');
  if (!shell) return;
  const resizers = shell.querySelectorAll('.col-resizer');
  const columns = () => [...shell.children].filter(el => 
    el.classList.contains('mail-list-panel') || 
    el.classList.contains('detail-panel') || 
    el.classList.contains('action-column')
  );
  
  resizers.forEach((resizer) => {
    let startX, startWidths, colIndex;
    
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      colIndex = parseInt(resizer.dataset.col, 10);
      startX = e.clientX;
      startWidths = columns().map(col => col.getBoundingClientRect().width);
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      
      const onMouseMove = (e) => {
        const dx = e.clientX - startX;
        const cols = columns();
        if (cols[colIndex] && cols[colIndex + 1]) {
          const newWidth1 = Math.max(200, startWidths[colIndex] + dx);
          const newWidth2 = Math.max(200, startWidths[colIndex + 1] - dx);
          cols[colIndex].style.flex = `0 0 ${newWidth1}px`;
          cols[colIndex + 1].style.flex = `0 0 ${newWidth2}px`;
          shell.style.gridTemplateColumns = [...cols].map(c => 
            c.style.flex || `0 0 ${c.getBoundingClientRect().width}px`
          ).join(' ');
        }
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
      const cols = columns();
      shell.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      cols.forEach(col => col.style.flex = '');
    });
  });
})();
