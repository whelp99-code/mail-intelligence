let serverCapabilities = { sendMail: false, markRead: false, dataPlane: false };
let localSessionPromise = null;

const loadOutlook = document.querySelector('#loadOutlook');
const mailLimit = document.querySelector('#mailLimit');
const fetchStatus = document.querySelector('#fetchStatus');
const connectionStatus = document.querySelector('#connectionStatus');
const messageList = document.querySelector('#messageList');
const messageCount = document.querySelector('#messageCount');
const messageDetail = document.querySelector('#messageDetail');
const mailSearch = document.querySelector('#mailSearch');
const searchDatabase = document.querySelector('#searchDatabase');
const memoryStatus = document.querySelector('#memoryStatus');
const memorySummary = document.querySelector('#memorySummary');
const memoryMessageCount = document.querySelector('#memoryMessageCount');
const memoryFolderCount = document.querySelector('#memoryFolderCount');
const memoryJobCount = document.querySelector('#memoryJobCount');
const memoryWarningCount = document.querySelector('#memoryWarningCount');
const refreshMemory = document.querySelector('#refreshMemory');
const syncPersistentMail = document.querySelector('#syncPersistentMail');
const backupPersistentMail = document.querySelector('#backupPersistentMail');
const databaseSearchResults = document.querySelector('#databaseSearchResults');
const precisionStatus = document.querySelector('#precisionStatus');
const precisionSummaryNode = document.querySelector('#precisionSummary');
const reclassifyPrecision = document.querySelector('#reclassifyPrecision');
const smartViews = document.querySelector('#smartViews');
const projectForm = document.querySelector('#projectForm');
const projectName = document.querySelector('#projectName');
const projectKey = document.querySelector('#projectKey');
const projectAliases = document.querySelector('#projectAliases');
const createProjectButton = document.querySelector('#createProject');
const projectRegistryCount = document.querySelector('#projectRegistryCount');
const projectRegistryList = document.querySelector('#projectRegistryList');
const configForm = document.querySelector('#configForm');
const configStatus = document.querySelector('#configStatus');
const clearConfig = document.querySelector('#clearConfig');
const accessToken = document.querySelector('#accessToken');
const tenantId = document.querySelector('#tenantId');
const clientId = document.querySelector('#clientId');
const clientSecret = document.querySelector('#clientSecret');
const mailboxUser = document.querySelector('#mailboxUser');
const loginTenant = document.querySelector('#loginTenant');
const domainProfile = document.querySelector('#domainProfile');
const loginOutlook = document.querySelector('#loginOutlook');
const aiProvider = document.querySelector('#aiProvider');
const openaiCodexModel = document.querySelector('#openaiCodexModel');
const xaiGrokModel = document.querySelector('#xaiGrokModel');
const externalAiConsentField = document.querySelector('#externalAiConsentField');
const aiDataPolicyAccepted = document.querySelector('#aiDataPolicyAccepted');
const oauthProviderSummary = document.querySelector('#oauthProviderSummary');
const oauthProviderCards = document.querySelector('#oauthProviderCards');
const refreshOauthProviders = document.querySelector('#refreshOauthProviders');
const testOauthProvider = document.querySelector('#testOauthProvider');
const oauthLoginCommand = document.querySelector('#oauthLoginCommand');
const assistantRole = document.querySelector('#assistantRole');
const assistantTone = document.querySelector('#assistantTone');
const assistantOpening = document.querySelector('#assistantOpening');
const saveAssistantPersonalityButton = document.querySelector('#saveAssistantPersonality');
const assistantPersonalityStatus = document.querySelector('#assistantPersonalityStatus');

const counts = {
  action_required: document.querySelector('#actionRequiredCount'),
  waiting: document.querySelector('#precisionWaitingCount'),
  decision_required: document.querySelector('#decisionRequiredCount'),
  completed: document.querySelector('#precisionCompletedCount'),
  reference: document.querySelector('#precisionReferenceCount'),
  review_required: document.querySelector('#reviewRequiredCount')
};
const operationalCounts = {
  do_now: document.querySelector('#doNowCount'),
  waiting: document.querySelector('#operationalWaitingCount'),
  review: document.querySelector('#operationalReviewCount'),
  archive: document.querySelector('#operationalArchiveCount')
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
  reference: '참고용이며 후속 업무 없음',
  hold: '보류: 지금 처리하지 않고 추후 확인'
};
const feedbackStatuses = ['urgent', 'active', 'waiting', 'done', 'reference'];
const feedbackReasonOptions = ['urgent', 'active', 'waiting', 'done', 'reference', 'hold'];

let currentResult = emptyResult();
let currentMessages = [];
let visibleMessages = [];
let activeFilter = 'all';
let searchQuery = '';
let selectedMessageId = '';
let precisionProjects = [];
let precisionSmartViews = [];
let assistantRequestSequence = 0;
let searchRequestSequence = 0;

let latestOutlookStatus = {};

function updateOutlookConnectionStatus(status = {}, options = {}) {
  latestOutlookStatus = { ...latestOutlookStatus, ...status };
  const phase = options.phase || 'ready';
  const message = String(options.message || '').trim();
  const safetyLabel = latestOutlookStatus.safety?.mode === 'read-only'
    ? '읽기 전용'
    : latestOutlookStatus.safety?.mode || '정책 확인 필요';
  let text;
  let state;

  if (phase === 'oauth-pending') {
    text = 'Outlook 로그인 진행 중 · Microsoft 창에서 Mail.Read 승인 대기';
    state = 'pending';
  } else if (phase === 'saving') {
    text = `Outlook 설정 저장 중 · ${safetyLabel}`;
    state = 'pending';
  } else if (phase === 'error') {
    text = `Outlook 연결 오류${message ? ` · ${message}` : ''}`;
    state = 'error';
  } else if (latestOutlookStatus.connected) {
    const mode = latestOutlookStatus.authMode || latestOutlookStatus.mode || 'delegated';
    text = `Outlook 연결됨 (${mode} · ${safetyLabel})`;
    state = 'connected';
  } else if (latestOutlookStatus.mode === 'offline-cache') {
    text = `Outlook 미연결 · SQLite 메일 DB ${safetyLabel}`;
    state = 'offline';
  } else {
    text = `Outlook 미연결 · ${safetyLabel}`;
    state = 'disconnected';
  }

  for (const node of [connectionStatus, configStatus]) {
    node.textContent = text;
    node.title = text;
    node.dataset.connectionState = state;
  }
}

function updateFetchStatus(message) {
  const text = String(message || '').trim();
  fetchStatus.textContent = text;
  fetchStatus.title = text;
}

function syncExternalAiConsent() {
  const requiresConsent = aiProvider.value !== 'rules';
  externalAiConsentField.hidden = !requiresConsent;
  aiDataPolicyAccepted.disabled = !requiresConsent;
  if (!requiresConsent) aiDataPolicyAccepted.checked = false;
  oauthLoginCommand.textContent = aiProvider.value === 'openai-codex-oauth'
    ? 'codex login --device-auth'
    : aiProvider.value === 'xai-grok-oauth'
      ? 'grok login --device-auth'
      : '규칙 기반은 OAuth 로그인이 필요하지 않습니다.';
}

function providerOutcomeLabel(outcome, kind) {
  const status = outcome?.status || 'never';
  if (status === 'passed') {
    const time = outcome.testedAt || outcome.analyzedAt || '';
    return `${kind} 성공${time ? ` · ${new Date(time).toLocaleString('ko-KR')}` : ''}`;
  }
  if (status === 'failed') return `${kind} 실패 · ${outcome.safeErrorCode || 'PROVIDER_CALL_FAILED'}`;
  return `${kind} 미실행`;
}

function renderOauthProviderStatus(payload = {}) {
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  oauthProviderCards.replaceChildren();
  for (const provider of providers) {
    const card = document.createElement('article');
    card.className = `oauth-provider-card${provider.operationalStatus === 'available' ? ' connected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = provider.label || provider.provider;
    const state = document.createElement('span');
    state.className = 'oauth-provider-state';
    state.textContent = provider.operationalStatus === 'cli_missing'
      ? 'CLI 미설치'
      : provider.operationalStatus === 'oauth_login_required'
        ? 'OAuth 로그인 필요'
        : provider.operationalStatus === 'available'
          ? '실제 모델 호출 가능'
          : provider.operationalStatus === 'unavailable'
            ? '실제 모델 호출 불가'
            : 'OAuth 로그인됨 · 실제 모델 테스트 필요';
    const detail = document.createElement('p');
    detail.className = 'oauth-provider-detail';
    detail.textContent = [
      `CLI: ${provider.cliInstalled ? '설치됨' : '미설치'}`,
      `OAuth: ${provider.oauthAuthenticated ? '로그인됨' : '로그인 필요'}`,
      providerOutcomeLabel(provider.lastSyntheticTest, '합성 테스트'),
      providerOutcomeLabel(provider.lastRealMailAnalysis, '실메일 분석'),
    ].join(' · ');
    const action = document.createElement('p');
    action.className = 'oauth-provider-action';
    const failure = provider.lastSyntheticTest?.status === 'failed'
      ? provider.lastSyntheticTest
      : provider.lastRealMailAnalysis?.status === 'failed'
        ? provider.lastRealMailAnalysis
        : null;
    action.textContent = failure?.userAction || (!provider.oauthAuthenticated ? provider.loginCommand || '' : provider.version || '');
    card.append(title, state, detail, action);
    oauthProviderCards.append(card);
  }
  const connected = providers.filter((provider) => provider.oauthAuthenticated).length;
  const available = providers.filter((provider) => provider.operationalStatus === 'available').length;
  oauthProviderSummary.textContent = [
    `CLI 설치 ${providers.filter((provider) => provider.cliInstalled).length}/${providers.length}`,
    `OAuth 로그인 ${connected}/${providers.length}`,
    `실제 호출 가능 ${available}/${providers.length}`,
    payload.externalAiEnabled ? '외부 AI 실행 허용' : '외부 AI 실행 정책 잠김'
  ].join(' · ');
}

async function loadOauthProviderStatus() {
  refreshOauthProviders.disabled = true;
  try {
    const response = await apiFetch('/api/ai/oauth/status');
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || 'OAuth Provider 상태 확인 실패');
    renderOauthProviderStatus(payload);
  } catch (error) {
    oauthProviderSummary.textContent = error instanceof Error ? error.message : 'OAuth Provider 상태 확인 실패';
    oauthProviderCards.replaceChildren();
  } finally {
    refreshOauthProviders.disabled = false;
  }
}

async function testSelectedOauthProvider() {
  if (aiProvider.value === 'rules') {
    oauthProviderSummary.textContent = '규칙 기반 Provider는 외부 OAuth 연결 테스트가 필요하지 않습니다.';
    return;
  }
  if (!aiDataPolicyAccepted.checked) {
    oauthProviderSummary.textContent = 'OAuth LLM 테스트 전에 메일 데이터 외부 전송 정책에 동의하세요.';
    aiDataPolicyAccepted.focus();
    return;
  }
  testOauthProvider.disabled = true;
  oauthProviderSummary.textContent = '실메일을 사용하지 않는 합성 OAuth 연결 테스트를 실행 중입니다.';
  try {
    const model = aiProvider.value === 'openai-codex-oauth'
      ? openaiCodexModel.value.trim()
      : xaiGrokModel.value.trim();
    const response = await apiFetch('/api/ai/oauth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: aiProvider.value, model })
    });
    const payload = await readApiPayload(response);
    if (!response.ok) {
      oauthProviderSummary.textContent = [
        payload.message || 'OAuth Provider 연결 테스트 실패',
        payload.userAction || '',
      ].filter(Boolean).join(' · ');
      await loadOauthProviderStatus();
      return;
    }
    await loadOauthProviderStatus();
    oauthProviderSummary.textContent = `${payload.provider} · ${payload.model || 'Luna'} · 합성 분석·근거 검증 PASS · ${payload.latencyMs}ms`;
  } catch (error) {
    oauthProviderSummary.textContent = 'OAuth Provider 상태 확인 중 오류가 발생했습니다. 다시 시도하세요.';
  } finally {
    testOauthProvider.disabled = false;
  }
}

async function ensureLocalSession() {
  if (!localSessionPromise) {
    localSessionPromise = fetch('/api/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(async (response) => {
      const payload = await readApiPayload(response);
      if (!response.ok || !payload.csrfToken) {
        throw new Error(payload.message || '로컬 보안 세션을 만들지 못했습니다.');
      }
      serverCapabilities = { ...serverCapabilities, ...(payload.capabilities || {}) };
      return payload;
    }).catch((error) => {
      localSessionPromise = null;
      throw error;
    });
  }
  return localSessionPromise;
}

async function readApiPayload(response) {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  const contentType = response.headers.get('content-type') || '';
  if (/application\/json/i.test(contentType)) {
    try { return JSON.parse(text); } catch { return { code: 'NON_JSON_RESPONSE', message: '서버 응답을 안전하게 처리하지 못했습니다.' }; }
  }
  if (response.status === 405 && /text\/plain/i.test(contentType) && /MAIL_BROWSER_RELAY_READ_ONLY/i.test(text)) {
    return { code: 'READ_ONLY_RELAY_BLOCKED', message: '읽기 전용 브라우저 릴레이에서는 이 작업을 실행할 수 없습니다.' };
  }
  return { code: 'NON_JSON_RESPONSE', message: response.ok ? '' : '서버 응답을 안전하게 처리하지 못했습니다.' };
}

function emptyResult() { return { insights: [], calendar: [], reminders: [], precision: { summary: null } }; }

async function apiFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  const requiresSession = !String(url).startsWith('/api/session')
    && !String(url).startsWith('/api/outlook/status');
  const session = requiresSession ? await ensureLocalSession() : null;
  if (!['GET', 'HEAD'].includes(method)) {
    headers.set('X-CSRF-Token', session.csrfToken);
    headers.set('X-Mail-Intelligence-Request', '1');
  }
  return fetch(url, {
    ...options,
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store'
  });
}

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

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''), window.location.origin);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
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

function precisionFor(messageId) {
  return currentMessages.find((item) => item.id === messageId)?.precision || null;
}

function precisionStateLabel(value) {
  return {
    action_required: '내 행동 필요',
    waiting: '대기',
    decision_required: '결정 필요',
    completed: '완료',
    reference: '참고',
    review_required: '검토 필요'
  }[value] || value || '검토 필요';
}

function nextActorLabel(value) {
  return {
    me: '내 차례',
    internal_team: '내부 팀 차례',
    external_party: '고객·외부 차례',
    shared: '공동 대응',
    none: '다음 행동 없음',
    unknown: '행동 주체 불명'
  }[value] || value || '행동 주체 불명';
}

function priorityLabel(value) {
  return {
    critical: '최우선',
    high: '높음',
    normal: '보통',
    low: '낮음'
  }[value] || value || '보통';
}

function projectResolutionLabel(value) {
  return {
    confirmed: '확정 프로젝트',
    candidate: '프로젝트 후보',
    unassigned: '미분류',
    review_required: '프로젝트 충돌 검토'
  }[value] || value || '미분류';
}

function signalLabel(value) {
  return {
    deadline: '기한',
    amount: '금액',
    quotation_contract: '견적·계약·발주',
    attachment: '첨부',
    attachment_missing: '첨부 누락 가능',
    schedule: '일정',
    approval: '승인',
    incident_security: '장애·보안'
  }[value] || value;
}

function confidencePercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '미측정';
}

function projectDisplay(classification) {
  if (!classification) return '미분류';
  if (classification.projectResolution === 'confirmed') return classification.projectName || classification.projectKey || '확정 프로젝트';
  if (classification.projectResolution === 'candidate') return classification.projectCandidate?.label || '프로젝트 후보';
  if (classification.projectResolution === 'review_required') return '프로젝트 충돌 검토';
  return '미분류';
}

function precisionSummaryLine(classification) {
  if (!classification) return '정밀 분류 전';
  const parts = [
    operationalLaneLabel(classification.operational?.lane),
    nextActorLabel(classification.nextActor),
    priorityLabel(classification.priority),
    projectDisplay(classification)
  ];
  if (classification.dueText) parts.push(`기한 ${classification.dueText}`);
  return parts.join(' · ');
}

function operationalLaneForMessage(messageId) {
  const precision = precisionFor(messageId);
  return precision?.operational?.lane || 'review';
}

function operationalLaneLabel(value) {
  return {
    do_now: 'DO NOW',
    waiting: 'WAITING',
    review: 'REVIEW',
    archive: 'ARCHIVE'
  }[value] || 'REVIEW';
}

function operationalDetail(classification) {
  const operational = classification?.operational;
  if (!operational) return '';
  const reasons = operational.reasons?.length
    ? `<ul>${operational.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
    : '<p>운영 배치에 추가 검토 사유가 없습니다.</p>';
  return `
    <section class="operational-detail lane-${escapeHtml(operational.lane.replaceAll('_', '-'))}">
      <div>
        <span class="memory-label">Operational Lane</span>
        <strong>${escapeHtml(operationalLaneLabel(operational.lane))}</strong>
      </div>
      <span>${operational.silentRiskPrevented ? '자동 보관 차단 · 조용한 누락 방지' : operational.autoConfirmed ? '자동 배치 가능' : '사용자 확인 권장'}</span>
      ${reasons}
    </section>
  `;
}

function assistantToolPanel(message, classification) {
  if (!message || !classification) return '';
  return `
    <section class="assistant-tools">
      <div class="assistant-tools-head">
        <div>
          <span class="memory-label">메일 도우미</span>
          <strong>요약·초안·일정 후보</strong>
        </div>
        <span>초안 복사만 가능 · 자동 발송 없음</span>
      </div>
      <div class="assistant-tool-buttons">
        <button type="button" data-assistant-action="confirm">맞음</button>
        <button type="button" data-assistant-action="summary">한 줄 요약</button>
        <button type="button" data-assistant-action="thread">스레드 요약</button>
        <button type="button" data-assistant-action="rapid_reply">빠른 회신 초안</button>
        <button type="button" data-assistant-action="improve">내 문장 다듬기</button>
        <button type="button" data-assistant-action="meeting">미팅 후보</button>
        <button type="button" data-assistant-action="meeting_confirmation">일정 확인 초안</button>
        <button type="button" data-assistant-action="attachments">첨부 요약</button>
        <button type="button" data-assistant-action="adjudicate">Luna 2차 검토</button>
      </div>
      <div id="assistantToolOutput" class="assistant-output" aria-live="polite">기능을 선택하면 현재 메일만 안전하게 처리합니다.</div>
      <div id="composeMount"></div>
    </section>
  `;
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
  const precision = message.precision;
  const lane = precision?.workState || legacyToPrecisionState(effectiveStatus(insight));
  const operationalLane = precision?.operational?.lane || 'review';
  const article = document.createElement('article');
  article.tabIndex = 0;
  article.setAttribute('role', 'button');
  article.dataset.messageId = String(message.id);
  article.setAttribute('aria-selected', String(message.id === selectedMessageId));
  article.className = `message-card precision-${lane.replaceAll('_', '-')} operational-${operationalLane.replaceAll('_', '-')}`;
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
  article.querySelector('.status-pill').textContent = `${operationalLaneLabel(operationalLane)} · ${precisionStateLabel(lane)}${precision?.reviewStatus === 'corrected' || insight?.userFeedback ? ' · 내 보정' : ''}`;
  article.querySelector('.message-meta').textContent = `${message.isRead ? '읽음' : '읽지않음'} · ${message.fromName || message.from || 'unknown'} · ${message.receivedAt ? new Date(message.receivedAt).toLocaleString('ko-KR') : '날짜 없음'}${insight?.isSpamCandidate ? ' · 광고성 후보' : ''}${insight?.isOnHold ? ' · 보류' : ''}`;
  article.querySelector('.message-summary').textContent = insight?.summary?.[0] || message.bodyPreview || '';
  article.querySelector('.message-next').textContent = precision
    ? precisionSummaryLine(precision)
    : insight?.nextActions?.[0]?.recommendedAction || '정밀 분류 필요';
  if (insight?.aiEnhanced) article.classList.add('ai-enhanced');
  if (!message.isRead) article.classList.add('unread');
  if (insight?.isSpamCandidate) article.classList.add('promo');
  article.addEventListener('click', () => selectMessage(message.id));
  article.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectMessage(message.id);
  });
  return article;
}

function scenarioActionCard(action) {
  const article = document.createElement('article');
  article.className = `mini-card scenario-action ${action.lane || 'active'}`;
  const isDraft = ['draft_reply', 'request_info', 'share_document'].includes(action.actionType);
  article.innerHTML = `
    <div class="mini-title"></div>
    <div class="mini-meta"></div>
    <p></p>
    <div class="scenario-action-buttons">
      ${isDraft ? '<button type="button" class="prepare-mail">회신 초안 보기</button><button type="button" class="custom-action">직접 작성</button>' : '<span class="read-only-action">읽기 전용 추천 · 외부 실행 없음</span>'}
    </div>
  `;
  article.querySelector('.mini-title').textContent = action.title || action.recommendedAction || '추천 액션';
  article.querySelector('.mini-meta').textContent = isDraft
    ? `초안 · 추천 첨부파일: ${recommendedAttachment(action)}`
    : `${statusLabel(action.lane)} · ${action.actionType || 'review'}`;
  article.querySelector('p').textContent = action.body || action.recommendedAction || '';
  article.querySelector('.prepare-mail')?.addEventListener('click', () => mountComposer(action));
  article.querySelector('.custom-action')?.addEventListener('click', () => mountComposer({
    ...action,
    id: `custom-${action.messageId || 'message'}`,
    actionType: 'draft_reply',
    title: '직접 작성',
    body: '',
    recommendedAction: '사용자 직접 작성',
  }));
  return article;
}

function recommendedAttachment(action) {
  const text = `${action.subject || ''} ${action.recommendedAction || ''} ${action.evidence || ''}`.toLowerCase();
  if (/제안|소개|자료|manual|메뉴얼|매뉴얼|제품/.test(text)) return '관련 제품 자료·매뉴얼·제안서 확인';
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

function legacyToPrecisionState(status) {
  return {
    urgent: 'action_required',
    active: 'action_required',
    waiting: 'waiting',
    done: 'completed',
    reference: 'reference'
  }[status] || 'review_required';
}

function precisionEvidenceList(classification) {
  if (!classification?.evidence) return [];
  return Object.entries(classification.evidence)
    .filter(([, item]) => item?.text)
    .map(([field, item]) => `${field}: ${item.text} (${item.rule || '근거'})`);
}

function precisionConfidenceList(classification) {
  if (!classification?.confidence) return [];
  return Object.entries(classification.confidence)
    .map(([field, value]) => `${field}: ${confidencePercent(value)}`);
}

function projectOptions(classification) {
  const current = classification?.primaryProjectId == null ? '' : String(classification.primaryProjectId);
  return [
    '<option value="">자동 판단 유지 / 미분류</option>',
    ...precisionProjects.map((project) => `<option value="${project.id}" ${String(project.id) === current ? 'selected' : ''}>${escapeHtml(project.name)}</option>`)
  ].join('');
}

function precisionCorrectionPanel(message, classification) {
  if (!classification) {
    return '<section class="precision-detail"><p>정밀 분류 결과가 아직 없습니다. 상단의 정밀 분류 새로고침을 실행하세요.</p></section>';
  }
  return `
    <section class="precision-detail">
      <div class="precision-detail-head">
        <div>
          <span class="memory-label">정밀 분류</span>
          <strong>${escapeHtml(precisionStateLabel(classification.workState))}</strong>
        </div>
        <span class="precision-review ${escapeHtml(classification.reviewStatus.replaceAll('_', '-'))}">${escapeHtml(classification.reviewStatus === 'corrected' ? '사용자 보정' : classification.reviewStatus === 'review_required' ? '검토 필요' : '자동 분류')}</span>
      </div>
      <dl class="precision-facts">
        <div><dt>다음 행동</dt><dd>${escapeHtml(nextActorLabel(classification.nextActor))}</dd></div>
        <div><dt>우선순위</dt><dd>${escapeHtml(priorityLabel(classification.priority))}</dd></div>
        <div><dt>프로젝트</dt><dd>${escapeHtml(projectDisplay(classification))}<small>${escapeHtml(projectResolutionLabel(classification.projectResolution))}</small></dd></div>
        <div><dt>기한</dt><dd>${escapeHtml(classification.dueText || '없음')}<small>${classification.dueAt ? escapeHtml(new Date(classification.dueAt).toLocaleString('ko-KR')) : ''}</small></dd></div>
      </dl>
      <div class="signal-row">${(classification.signals || []).map((signal) => `<span>${escapeHtml(signalLabel(signal))}</span>`).join('') || '<span>보조 신호 없음</span>'}</div>
      ${detailBlock('필드별 신뢰도', precisionConfidenceList(classification))}
      ${detailBlock('정밀 판단 근거', precisionEvidenceList(classification))}
      ${classification.reviewReasons?.length ? detailBlock('검토 사유', classification.reviewReasons) : ''}
      <details class="precision-correction">
        <summary>이 분류를 직접 보정</summary>
        <form id="precisionCorrectionForm">
          <input type="hidden" name="messageId" value="${escapeHtml(message.id)}" />
          <label>현재 업무 상태
            <select name="workState">
              ${['action_required', 'waiting', 'decision_required', 'completed', 'reference', 'review_required']
    .map((value) => `<option value="${value}" ${classification.workState === value ? 'selected' : ''}>${precisionStateLabel(value)}</option>`).join('')}
            </select>
          </label>
          <label>다음 행동 주체
            <select name="nextActor">
              ${['me', 'internal_team', 'external_party', 'shared', 'none', 'unknown'].map((value) => `<option value="${value}" ${classification.nextActor === value ? 'selected' : ''}>${nextActorLabel(value)}</option>`).join('')}
            </select>
          </label>
          <label>우선순위
            <select name="priority">
              ${['critical', 'high', 'normal', 'low'].map((value) => `<option value="${value}" ${classification.priority === value ? 'selected' : ''}>${priorityLabel(value)}</option>`).join('')}
            </select>
          </label>
          <label>확정 프로젝트
            <select name="primaryProjectId">${projectOptions(classification)}</select>
          </label>
          <label class="checkbox-row"><input type="checkbox" name="clearProject" />프로젝트 연결을 해제하고 미분류로 유지</label>
          <label>기한 원문<input name="dueText" type="text" maxlength="160" value="${escapeHtml(classification.dueText || '')}" placeholder="예: 내일 오후 3시" /></label>
          <label>보정 이유 코드<input name="reasonCode" type="text" maxlength="120" value="manual-review" /></label>
          <label>보정 메모<input name="note" type="text" maxlength="1000" placeholder="왜 수정했는지 간단히 기록" /></label>
          <div class="precision-correction-actions">
            <button type="submit" class="primary">정밀 분류 저장</button>
            <span id="precisionCorrectionStatus">자동 판단보다 우선해 저장됩니다.</span>
          </div>
        </form>
      </details>
    </section>
  `;
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
        ${feedbackStatuses.map((status) => `<button type="button" class="feedback-status ${applied === status ? 'selected' : ''}" data-status="${status}" aria-pressed="${applied === status}">${statusLabel(status)}</button>`).join('')}
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
        <h4>회신 초안 편집</h4>
        <span id="sendStatus">v1.2.2는 읽기 전용입니다. 초안은 복사만 할 수 있습니다.</span>
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
        <button id="copyDraft" type="button" class="primary">초안 복사</button>
        <button id="cancelCompose" type="button">닫기</button>
      </div>
    </section>
  `;
}

function renderAssistantOutput(value) {
  const output = messageDetail.querySelector('#assistantToolOutput');
  if (!output) return;
  if (typeof value === 'string') {
    output.textContent = value;
    return;
  }
  output.textContent = JSON.stringify(value, null, 2);
}

function mountAssistantDraft(draft) {
  mountComposer({
    id: `assistant-${draft.mode || 'draft'}-${selectedMessageId}`,
    to: draft.to || '',
    mailSubject: draft.subject || '',
    body: draft.body || '',
  });
  renderAssistantOutput('초안을 만들었습니다. 내용을 직접 확인한 뒤 클립보드로 복사하세요. 자동 발송은 차단되어 있습니다.');
}

async function runAssistantTool(action, messageId) {
  const requestSequence = ++assistantRequestSequence;
  renderAssistantOutput('처리 중입니다.');
  try {
    if (action === 'confirm') {
      const response = await apiFetch('/api/intelligence/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId })
      });
      const payload = await readApiPayload(response);
      if (requestSequence !== assistantRequestSequence || messageId !== selectedMessageId) return;
      if (!response.ok) throw new Error(payload.message || '분류 확인 저장 실패');
      const message = currentMessages.find((item) => item.id === messageId);
      if (message) message.precision = payload.classification;
      renderAssistantOutput('현재 분류를 확인했습니다. 확인 이력은 사용자 보정으로 저장되며 자동 판단보다 우선합니다.');
      await loadPrecisionOverview({ classify: false });
      renderFilteredView();
      selectMessage(messageId);
      return;
    }
    if (action === 'summary' || action === 'thread' || action === 'meeting' || action === 'attachments') {
      const endpoint = {
        summary: `/api/intelligence/message-summary?messageId=${encodeURIComponent(messageId)}`,
        thread: `/api/intelligence/thread-summary?messageId=${encodeURIComponent(messageId)}`,
        meeting: `/api/intelligence/meeting-candidate?messageId=${encodeURIComponent(messageId)}&timeZone=Asia%2FSeoul`,
        attachments: `/api/intelligence/attachments?messageId=${encodeURIComponent(messageId)}`
      }[action];
      const response = await apiFetch(endpoint);
      const payload = await readApiPayload(response);
      if (requestSequence !== assistantRequestSequence || messageId !== selectedMessageId) return;
      if (!response.ok) throw new Error(payload.message || '메일 도우미 실행 실패');
      if (action === 'summary') {
        renderAssistantOutput([payload.oneLine, ...(payload.detail || [])].filter(Boolean).join('\n'));
      } else if (action === 'thread') {
        renderAssistantOutput([
          payload.oneLine,
          `현재 운영함: ${operationalLaneLabel(payload.currentLane)}`,
          ...(payload.detailed || []).map((item) => `- ${item.oneLine} · ${operationalLaneLabel(item.lane)}`)
        ].join('\n'));
      } else if (action === 'meeting') {
        renderAssistantOutput(payload.meetingIntent
          ? ['미팅 의도 감지', `후보: ${(payload.candidateTimes || []).join(', ') || '시간 미확정'}`, '캘린더 가능 여부: 자동 확인 안 됨', '일정 생성: 차단'].join('\n')
          : '현재 본문에서 미팅 의도를 찾지 못했습니다.');
      } else {
        const summaries = payload.summaries || [];
        renderAssistantOutput(summaries.length
          ? summaries.map((item) => `${item.metadata?.name || '첨부파일'} · ${item.summaryStatus}\n${item.summary}`).join('\n\n')
          : '저장된 첨부 메타데이터가 없습니다.');
      }
      return;
    }
    if (action === 'rapid_reply' || action === 'meeting_confirmation' || action === 'improve') {
      let draftText = '';
      if (action === 'improve') {
        draftText = window.prompt('다듬을 메일 문장을 입력하세요. 서버는 초안만 만들고 발송하지 않습니다.', '') || '';
        if (!draftText.trim()) {
          renderAssistantOutput('다듬을 문장이 입력되지 않았습니다.');
          return;
        }
      }
      const response = await apiFetch('/api/intelligence/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          mode: action,
          draftText,
          timeZone: 'Asia/Seoul'
        })
      });
      const payload = await readApiPayload(response);
      if (requestSequence !== assistantRequestSequence || messageId !== selectedMessageId) return;
      if (!response.ok) throw new Error(payload.message || '초안 생성 실패');
      mountAssistantDraft(payload);
      return;
    }
    if (action === 'adjudicate') {
      const response = await apiFetch('/api/intelligence/adjudicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId })
      });
      const payload = await readApiPayload(response);
      if (requestSequence !== assistantRequestSequence || messageId !== selectedMessageId) return;
      if (!response.ok) throw new Error(payload.message || 'Luna 2차 검토 실패');
      if (payload.status === 'policy_blocked') {
        renderAssistantOutput('외부 AI가 운영 정책으로 꺼져 있습니다. Rules 결과를 유지하고 이 메일은 REVIEW에서 사람이 확인합니다.');
      } else if (payload.status === 'agreed') {
        renderAssistantOutput(`Rules와 Luna 후보가 일치했습니다.\n${JSON.stringify(payload.luna, null, 2)}\n자동 저장은 하지 않았습니다.`);
      } else if (payload.status === 'disagreed') {
        renderAssistantOutput(`Rules와 Luna가 불일치했습니다. REVIEW를 유지합니다.\nRules: ${JSON.stringify(payload.rules)}\nLuna: ${JSON.stringify(payload.luna)}`);
      } else {
        renderAssistantOutput(payload);
      }
    }
  } catch (error) {
    renderAssistantOutput(error instanceof Error ? error.message : '메일 도우미 실행 실패');
  }
}

function mountComposer(action) {
  const mount = messageDetail.querySelector('#composeMount') || actionList;
  mount.innerHTML = mailComposer(action);
  mount.querySelector('#cancelCompose').addEventListener('click', () => {
    mount.innerHTML = '';
    renderActionPanel();
  });
  mount.querySelector('#copyDraft').addEventListener('click', copyComposedDraft);
  mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyComposedDraft() {
  const status = document.querySelector('#sendStatus');
  const payload = {
    to: document.querySelector('#composeTo')?.value || '',
    cc: document.querySelector('#composeCc')?.value || '',
    subject: document.querySelector('#composeSubject')?.value || '',
    body: document.querySelector('#composeBody')?.value || '',
  };
  const draft = [`To: ${payload.to}`, payload.cc ? `Cc: ${payload.cc}` : '', `Subject: ${payload.subject}`, '', payload.body]
    .filter((value, index) => value || index === 3)
    .join('\n');
  try {
    await navigator.clipboard.writeText(draft);
    status.textContent = '초안을 클립보드에 복사했습니다. Outlook에서 최종 확인 후 직접 발송하세요.';
  } catch {
    const body = document.querySelector('#composeBody');
    body?.focus();
    body?.select();
    status.textContent = '클립보드 접근이 차단되었습니다. 본문을 직접 복사하세요.';
  }
}

function selectMessage(messageId) {
  selectedMessageId = messageId;
  const message = currentMessages.find((item) => item.id === messageId);
  const insight = insightFor(messageId);
  const precision = message?.precision || null;
  if (!message && !insight) return;

  const tasks = insight?.tasks || [];
  const preview = insight?.bodyPreview || message?.bodyPreview || message?.body || '';
  const fullBody = message?.body || preview || '';
  const outlookLink = safeExternalUrl(message?.webLink);
  const confidence = Number.isFinite(insight?.confidence) ? `${Math.round(insight.confidence * 100)}%` : '미측정';
  const analysisState = insight?.analysisState === 'policy_blocked'
    ? '외부 AI 정책 차단 · 규칙 기반 분석'
    : insight?.analysisState === 'degraded'
      ? 'AI 실패 · 규칙 기반 임시 판단'
      : insight?.analysisMode === 'ai'
        ? 'AI 분석'
        : '규칙 기반 분석';

  messageDetail.innerHTML = `
    <div class="detail-head">
      <span class="status-pill">${escapeHtml(precision ? `${operationalLaneLabel(precision.operational?.lane)} · ${precisionStateLabel(precision.workState)}` : statusLabel(effectiveStatus(insight)))}${precision?.reviewStatus === 'corrected' || insight?.userFeedback ? ' · 내 보정' : insight?.aiEnhanced ? ' · AI' : ''}</span>
      ${outlookLink ? `<a href="${escapeHtml(outlookLink)}" target="_blank" rel="noreferrer noopener">Outlook에서 열기</a>` : ''}
    </div>
    <div class="detail-content">
      <h3>${escapeHtml(insight?.subject || message?.subject || '(제목 없음)')}</h3>
      <p class="detail-meta">${escapeHtml(insight?.fromName || message?.fromName || message?.from || 'unknown')} · ${message?.receivedAt ? new Date(message.receivedAt).toLocaleString('ko-KR') : '날짜 없음'} · ${escapeHtml(message?.importance || 'normal')} · ${escapeHtml(analysisState)} · 신뢰도 ${escapeHtml(confidence)}</p>
      <section class="detail-block first">
        <h4>메일 내용</h4>
        <p class="detail-body">${escapeHtml(fullBody).slice(0, 5000)}</p>
      </section>
      ${operationalDetail(precision)}
      ${precisionCorrectionPanel(message, precision)}
      ${assistantToolPanel(message, precision)}
      ${insight ? feedbackPanel(insight) : ''}
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
  messageDetail.querySelector('#precisionCorrectionForm')?.addEventListener('submit', savePrecisionCorrection);
  messageDetail.querySelectorAll('[data-assistant-action]').forEach((button) => {
    button.addEventListener('click', () => runAssistantTool(button.dataset.assistantAction, messageId));
  });

  messageList.querySelectorAll('.message-card').forEach((node) => {
    node.classList.remove('selected');
    node.setAttribute('aria-selected', 'false');
  });
  const selectedCard = [...messageList.querySelectorAll('.message-card')].find((node) => node.dataset.messageId === String(messageId));
  selectedCard?.classList.add('selected');
  selectedCard?.setAttribute('aria-selected', 'true');
  renderActionPanel();
}

async function saveFeedback(messageId, userStatus) {
  const insight = insightFor(messageId);
  const status = messageDetail.querySelector('#feedbackStatus');
  const reason = messageDetail.querySelector('#feedbackReason')?.value || userStatus;
  const note = messageDetail.querySelector('#feedbackNote')?.value || '';
  status.textContent = '보정값 저장 중입니다.';
  try {
    const response = await apiFetch('/api/outlook/feedback', {
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
    const result = await readApiPayload(response);
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

async function savePrecisionCorrection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const messageId = String(formData.get('messageId') || '');
  const status = form.querySelector('#precisionCorrectionStatus');
  status.textContent = '정밀 분류 보정값 저장 중입니다.';
  const primaryProjectId = String(formData.get('primaryProjectId') || '').trim();
  const payload = {
    messageId,
    workState: formData.get('workState'),
    nextActor: formData.get('nextActor'),
    priority: formData.get('priority'),
    dueText: String(formData.get('dueText') || ''),
    primaryProjectId: primaryProjectId || undefined,
    clearProject: formData.get('clearProject') === 'on',
    reasonCode: String(formData.get('reasonCode') || 'manual-review'),
    note: String(formData.get('note') || '')
  };
  try {
    const response = await apiFetch('/api/intelligence/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await readApiPayload(response);
    if (!response.ok) throw new Error(result.message || '정밀 분류 보정 저장 실패');
    const message = currentMessages.find((item) => item.id === messageId);
    if (message) message.precision = result.classification;
    status.textContent = '저장됨 · 사용자 보정이 자동 판단보다 우선합니다.';
    await loadPrecisionOverview({ classify: false });
    renderFilteredView();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '정밀 분류 보정 저장 실패';
  }
}

function laneForMessage(messageId) {
  const precision = precisionFor(messageId);
  if (precision?.workState) return precision.workState;
  const insight = insightFor(messageId);
  if (!insight) return 'review_required';
  const applied = effectiveStatus(insight);
  if (applied === 'urgent') return 'action_required';
  if (applied === 'waiting') return 'waiting';
  if (applied === 'done') return 'completed';
  if (applied === 'reference') return 'reference';
  if (applied === 'active') return 'action_required';
  if (insight.tasks?.some((task) => task.lane === 'urgent')) return 'action_required';
  if (insight.tasks?.some((task) => task.lane === 'waiting')) return 'waiting';
  if (insight.tasks?.some((task) => task.lane === 'active')) return 'action_required';
  if (insight.tasks?.some((task) => task.lane === 'done')) return 'completed';
  return 'reference';
}

function statusLabel(status) {
  return {
    urgent: '긴급',
    active: '진행중',
    waiting: '대기',
    done: '완료',
    reference: '참고',
    action_required: '내 행동 필요',
    decision_required: '결정 필요',
    completed: '완료',
    review_required: '검토 필요'
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
    const matchesLane = activeFilter === 'all'
      || (activeFilter.startsWith('op:')
        ? operationalLaneForMessage(message.id) === activeFilter.slice(3)
        : laneForMessage(message.id) === activeFilter);
    const matchesSearch = !query || searchableText(message).includes(query);
    return matchesLane && matchesSearch;
  });
}

function actionVisible(action) { return Boolean(action?.messageId) && action.messageId === selectedMessageId; }

function refreshFilterButtons() {
  document.querySelectorAll('.metric').forEach((button) => {
    const selected = button.dataset.filter === activeFilter;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function renderFilteredView() {
  visibleMessages = filteredMessages().sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  refreshFilterButtons();

  Object.keys(counts).forEach((lane) => {
    counts[lane].textContent = currentMessages.filter((message) => laneForMessage(message.id) === lane).length;
  });
  Object.keys(operationalCounts).forEach((lane) => {
    if (operationalCounts[lane]) {
      operationalCounts[lane].textContent = currentMessages.filter((message) => operationalLaneForMessage(message.id) === lane).length;
    }
  });

  clear(messageList);
  const unreadCount = visibleMessages.filter((message) => !message.isRead).length;
  messageCount.textContent = `현재 로드 ${currentMessages.length}건 중 ${visibleMessages.length}건 · 읽지않음 ${unreadCount}건`;
  if (!visibleMessages.length) {
    messageList.appendChild(empty('조건에 맞는 메일이 없습니다.'));
    selectedMessageId = '';
    messageDetail.innerHTML = '<div class="empty">필터 또는 검색 조건을 조정하세요.</div>';
    renderActionPanel();
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
      const laneSummary = Object.keys(counts)
        .map((lane) => `${statusLabel(lane)} ${items.filter((item) => laneForMessage(item.id) === lane).length}`)
        .join(' · ');
      const operationalLaneSummary = Object.keys(operationalCounts)
        .map((lane) => `${operationalLaneLabel(lane)} ${items.filter((item) => operationalLaneForMessage(item.id) === lane).length}`)
        .join(' · ');
      group.innerHTML = '<div class="group-head"><strong></strong><span></span></div>';
      group.querySelector('strong').textContent = label;
      group.querySelector('span').textContent = `${items.length}건 · ${operationalLaneSummary} · ${laneSummary}`;
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
  currentResult = result && typeof result === 'object' ? { ...emptyResult(), ...result, calendar: Array.isArray(result.calendar) ? result.calendar : [], reminders: Array.isArray(result.reminders) ? result.reminders : [], insights: Array.isArray(result.insights) ? result.insights : [] } : emptyResult();
  currentMessages = Array.isArray(messages) ? messages : [];
  activeFilter = 'all';
  searchQuery = '';
  mailSearch.value = '';
  if (result?.precision?.summary) renderPrecisionOverview(result.precision.summary);
  renderFilteredView();
}

function renderMemoryStatus(storage) {
  const countsByTable = storage?.counts || {};
  const sync = storage?.sync || {};
  const folders = sync.folders || [];
  const jobs = storage?.jobs || [];
  const deadLetters = storage?.deadLetters || [];
  const ready = storage?.ready === true;
  memoryStatus.textContent = ready
    ? `SQLite schema v${storage.schemaVersion} · 정상`
    : 'SQLite 점검 필요';
  memoryMessageCount.textContent = String(countsByTable.messages || 0);
  memoryFolderCount.textContent = String(countsByTable.mail_folders || folders.length || 0);
  memoryJobCount.textContent = String(countsByTable.operator_jobs || jobs.length || 0);
  memoryWarningCount.textContent = String(deadLetters.length);
  const cursorFolders = folders.filter((folder) => folder.has_delta_cursor === 1).length;
  const resumeFolders = folders.filter((folder) => folder.has_resume_cursor === 1).length;
  memorySummary.textContent = ready
    ? `DB ${Math.max(Number(storage.sizeBytes || 0) / 1024 / 1024, 0).toFixed(1)} MB · Delta 커서 ${cursorFolders}개 · 재개 대기 ${resumeFolders}개 · 백업 ${(storage.backups || []).length}개`
    : '무결성 검사 결과를 확인하세요.';
}

function renderPrecisionOverview(summary) {
  const states = summary?.states || {};
  Object.entries(counts).forEach(([state, node]) => {
    if (node) node.textContent = String(states[state] || 0);
  });
  const total = Number(summary?.total || 0);
  const review = Number(summary?.reviewRequired || 0);
  const corrected = Number(summary?.corrected || 0);
  const confirmed = Number(summary?.projectResolution?.confirmed || summary?.assignedProjects || 0);
  const operational = summary?.calculated?.operational || summary?.operational || {};
  const operationalLanes = operational.lanes || {};
  Object.entries(operationalCounts).forEach(([lane, node]) => {
    if (node) node.textContent = String(operationalLanes[lane] || 0);
  });
  precisionStatus.textContent = total
    ? `저장 전체 정밀 분류 ${total}건 · DO NOW ${operationalLanes.do_now || 0} · WAITING ${operationalLanes.waiting || 0} · REVIEW ${operationalLanes.review || review} · ARCHIVE ${operationalLanes.archive || 0}`
    : '정밀 분류할 저장 메일이 없습니다.';
  precisionSummaryNode.textContent = total
    ? `사용자 보정 ${corrected}건 · 자동 보관 차단 ${operational.silentRiskPrevented || 0}건 · 확정 프로젝트 연결 ${confirmed}건 · 애매한 판단은 REVIEW에 남깁니다.`
    : 'Outlook을 연결하거나 저장 메일을 동기화하면 정밀 분류가 시작됩니다.';
}

async function loadAssistantPersonality() {
  if (!assistantRole || !assistantTone || !assistantOpening) return;
  try {
    const response = await apiFetch('/api/intelligence/personality');
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '초안 성격 확인 실패');
    assistantRole.value = payload.personality?.role || '';
    assistantTone.value = payload.personality?.tone || '';
    assistantOpening.value = payload.personality?.opening || '';
    assistantPersonalityStatus.textContent = '서버 로컬 설정 불러옴';
  } catch (error) {
    assistantPersonalityStatus.textContent = error instanceof Error ? error.message : '초안 성격 확인 실패';
  }
}

async function saveAssistantPersonality() {
  saveAssistantPersonalityButton.disabled = true;
  assistantPersonalityStatus.textContent = '저장 중';
  try {
    const response = await apiFetch('/api/intelligence/personality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: assistantRole.value,
        tone: assistantTone.value,
        opening: assistantOpening.value
      })
    });
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '초안 성격 저장 실패');
    assistantRole.value = payload.personality.role;
    assistantTone.value = payload.personality.tone;
    assistantOpening.value = payload.personality.opening;
    assistantPersonalityStatus.textContent = '저장됨 · 초안에만 적용';
  } catch (error) {
    assistantPersonalityStatus.textContent = error instanceof Error ? error.message : '초안 성격 저장 실패';
  } finally {
    saveAssistantPersonalityButton.disabled = false;
  }
}

function renderProjectRegistry() {
  projectRegistryCount.textContent = `${precisionProjects.length}개`;
  clear(projectRegistryList);
  if (!precisionProjects.length) {
    projectRegistryList.appendChild(empty('등록된 확정 프로젝트가 없습니다. 자동 생성하지 않습니다.'));
    return;
  }
  precisionProjects.forEach((project) => {
    const item = document.createElement('article');
    item.className = 'project-item';
    const name = document.createElement('strong');
    const detail = document.createElement('span');
    name.textContent = project.name;
    detail.textContent = `${project.projectKey} · 별칭 ${(project.aliases || []).join(', ') || '없음'}`;
    item.append(name, detail);
    projectRegistryList.appendChild(item);
  });
}

async function loadPrecisionProjects() {
  try {
    const response = await apiFetch('/api/intelligence/projects');
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '프로젝트 목록 확인 실패');
    precisionProjects = payload.projects || [];
    renderProjectRegistry();
  } catch (error) {
    projectRegistryList.textContent = error instanceof Error ? error.message : '프로젝트 목록 확인 실패';
  }
}

function renderSmartViews() {
  clear(smartViews);
  precisionSmartViews.forEach((view) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'smart-view';
    button.textContent = view.label;
    button.addEventListener('click', () => {
      mailSearch.value = view.query;
      searchPersistentMemory();
    });
    smartViews.appendChild(button);
  });
}

async function loadSmartViews() {
  try {
    const response = await apiFetch('/api/intelligence/smart-views');
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '스마트 뷰 확인 실패');
    precisionSmartViews = payload.views || [];
    renderSmartViews();
  } catch {
    precisionSmartViews = [];
    renderSmartViews();
  }
}

async function loadPrecisionOverview({ classify = true, force = false } = {}) {
  reclassifyPrecision.disabled = true;
  try {
    if (classify) {
      const classifyResponse = await apiFetch('/api/intelligence/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const classifyPayload = await classifyResponse.json();
      if (!classifyResponse.ok) throw new Error(classifyPayload.message || '정밀 분류 실패');
    }
    const response = await apiFetch('/api/intelligence/summary');
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '정밀 분류 상태 확인 실패');
    renderPrecisionOverview(payload);
    await loadPrecisionProjects();
  } catch (error) {
    precisionStatus.textContent = '정밀 분류 확인 실패';
    precisionSummaryNode.textContent = error instanceof Error ? error.message : '정밀 분류 상태 확인 실패';
  } finally {
    reclassifyPrecision.disabled = false;
  }
}

async function createPrecisionProject(event) {
  event.preventDefault();
  createProjectButton.disabled = true;
  precisionSummaryNode.textContent = '프로젝트를 등록하고 관련 저장 메일을 다시 분류하는 중입니다.';
  try {
    const aliases = projectAliases.value.split(',').map((item) => item.trim()).filter(Boolean);
    const response = await apiFetch('/api/intelligence/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: projectName.value.trim(),
        projectKey: projectKey.value.trim(),
        aliases
      })
    });
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '프로젝트 등록 실패');
    projectForm.reset();
    await loadPrecisionOverview({ classify: false });
    precisionSummaryNode.textContent = `${payload.project.name} 등록 완료 · 기존 메일 ${payload.reclassification?.processed || 0}건 재평가`;
    if (currentMessages.length) await loadOutlookMessages();
  } catch (error) {
    precisionSummaryNode.textContent = error instanceof Error ? error.message : '프로젝트 등록 실패';
  } finally {
    createProjectButton.disabled = false;
  }
}

async function loadMemoryStatus() {
  refreshMemory.disabled = true;
  try {
    const response = await apiFetch('/api/storage/status');
    const storage = await readApiPayload(response);
    if (!response.ok) throw new Error(storage.message || '메일 DB 상태 확인 실패');
    renderMemoryStatus(storage);
  } catch (error) {
    memoryStatus.textContent = 'SQLite 상태 확인 실패';
    memorySummary.textContent = error instanceof Error ? error.message : '메일 DB 상태 확인 실패';
  } finally {
    refreshMemory.disabled = false;
  }
}

async function synchronizePersistentMemory() {
  syncPersistentMail.disabled = true;
  fetchStatus.textContent = 'Outlook 전체 폴더 Delta 동기화를 실행 중입니다.';
  try {
    const response = await apiFetch('/api/outlook/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ top: Number(mailLimit.value), forceInitial: false })
    });
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || 'Delta 동기화 실패');
    const sync = payload.sync || {};
    fetchStatus.textContent = `Delta 동기화 완료 · 폴더 ${sync.completedFolders || 0}/${sync.discoveredFolders || 0} · 수집 ${sync.fetchedFromGraph || 0} · 반영 ${sync.upserted || 0} · 삭제 ${sync.deleted || 0} · 경고 ${sync.failedFolders || 0}`;
    await loadMemoryStatus();
    await loadOutlookMessages();
  } catch (error) {
    fetchStatus.textContent = error instanceof Error ? error.message : 'Delta 동기화 실패';
  } finally {
    syncPersistentMail.disabled = false;
  }
}

async function createPersistentMemoryBackup() {
  backupPersistentMail.disabled = true;
  memorySummary.textContent = 'SQLite 무결성 검사와 검증 백업을 실행 중입니다.';
  try {
    const response = await apiFetch('/api/storage/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '백업 생성 실패');
    memorySummary.textContent = `검증 백업 완료 · ${payload.backup.name} · ${(payload.backup.sizeBytes / 1024 / 1024).toFixed(1)} MB · SHA-256 ${payload.backup.checksumSha256.slice(0, 12)}…`;
    await loadMemoryStatus();
  } catch (error) {
    memorySummary.textContent = error instanceof Error ? error.message : '백업 생성 실패';
  } finally {
    backupPersistentMail.disabled = false;
  }
}

function renderDatabaseSearchResults(results, query, parsedQuery = null) {
  clear(databaseSearchResults);
  databaseSearchResults.hidden = false;
  const heading = document.createElement('strong');
  const filters = parsedQuery?.recognized?.map((item) => `${item.type}:${item.value}`).join(' · ') || '메일 근거 검색';
  heading.textContent = `지능형 탐색 “${query}” · ${results.length}건 · ${filters}`;
  databaseSearchResults.appendChild(heading);
  if (!results.length) {
    databaseSearchResults.appendChild(empty('일치하는 저장 메일이 없습니다.'));
    return;
  }
  results.forEach((result) => {
    const message = result.message || result;
    const classification = result.classification || message.precision;
    const item = document.createElement('article');
    item.className = 'memory-search-item';
    const content = document.createElement('div');
    const subject = document.createElement('strong');
    const metadata = document.createElement('span');
    subject.textContent = message.subject || '(제목 없음)';
    metadata.textContent = classification
      ? `${precisionStateLabel(classification.workState)} · ${nextActorLabel(classification.nextActor)} · ${priorityLabel(classification.priority)} · ${projectDisplay(classification)}${classification.dueText ? ` · ${classification.dueText}` : ''}`
      : `${message.fromName || message.from || 'unknown'} · ${message.receivedAt ? new Date(message.receivedAt).toLocaleString('ko-KR') : '날짜 없음'}`;
    content.append(subject, metadata);
    if (result.matchedBecause?.length) {
      const reasons = document.createElement('small');
      reasons.textContent = result.matchedBecause.join(' · ');
      content.appendChild(reasons);
    }
    item.appendChild(content);
    const outlookUrl = safeExternalUrl(message.webLink);
    if (outlookUrl) {
      const link = document.createElement('a');
      link.href = outlookUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Outlook 원문';
      item.appendChild(link);
    }
    item.addEventListener('click', () => {
      const existing = currentMessages.find((candidate) => candidate.id === message.id);
      if (!existing) {
        fetchStatus.textContent = 'Search result is not in the loaded mailbox.';
        return;
      }
      existing.precision = classification || existing.precision;
      searchQuery = '';
      activeFilter = 'all';
      renderFilteredView();
      selectMessage(message.id);
    });
    databaseSearchResults.appendChild(item);
  });
}

async function searchPersistentMemory() {
  const requestSequence = ++searchRequestSequence;
  const query = mailSearch.value.trim();
  if (!query) {
    fetchStatus.textContent = 'DB 전체 검색어를 입력하세요.';
    mailSearch.focus();
    return;
  }
  searchDatabase.disabled = true;
  try {
    const response = await apiFetch(`/api/intelligence/search?q=${encodeURIComponent(query)}&limit=25`);
    const payload = await readApiPayload(response);
    if (requestSequence !== searchRequestSequence) return;
    if (!response.ok) throw new Error(payload.message || '지능형 탐색 실패');
    renderDatabaseSearchResults(payload.results || [], query, payload.parsedQuery);
    fetchStatus.textContent = `정밀 분류 + SQLite 근거 탐색 완료 · ${payload.results?.length || 0}건`;
  } catch (error) {
    fetchStatus.textContent = error instanceof Error ? error.message : '지능형 탐색 실패';
  } finally {
    searchDatabase.disabled = false;
  }
}

async function loadStatus() {
  try {
    const response = await apiFetch('/api/outlook/config');
    const status = await readApiPayload(response);
    if (!response.ok) throw new Error(status.message || 'Outlook 상태 확인 실패');
    updateOutlookConnectionStatus(status);
    loginTenant.value = status.loginTenant || 'common';
    tenantId.value = status.tenantId || '';
    clientId.value = status.clientId || '';
    mailboxUser.value = status.mailboxUser || '';
    domainProfile.value = status.domainProfile || 'generic';
    aiProvider.value = status.aiProvider || 'rules';
    openaiCodexModel.value = status.openaiCodexModel || 'luna';
    xaiGrokModel.value = status.xaiGrokModel || 'grok-4.6';
    aiDataPolicyAccepted.checked = aiProvider.value !== 'rules' && status.aiOptedIn === true;
    syncExternalAiConsent();
    accessToken.placeholder = status.hasAccessToken ? '현재 서버 메모리의 토큰 사용 중' : '';
    clientSecret.placeholder = status.hasClientSecret ? '현재 서버 메모리의 Client Secret 사용 중' : '';
    await loadOauthProviderStatus();
  } catch (error) {
    updateOutlookConnectionStatus({}, {
      phase: 'error',
      message: error instanceof Error ? error.message : '상태 확인 실패',
    });
  }
}

async function saveConfig(event) {
  event.preventDefault();
  if (aiProvider.value !== 'rules' && !aiDataPolicyAccepted.checked) {
    updateFetchStatus('OAuth LLM으로 메일 데이터를 전송하려면 외부 AI 데이터 정책에 먼저 동의하세요.');
    aiDataPolicyAccepted.focus();
    return;
  }
  updateOutlookConnectionStatus({}, { phase: 'saving' });
  try {
    const response = await apiFetch('/api/outlook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: [REDACTED],
        tenantId: tenantId.value,
        clientId: clientId.value,
        clientSecret: clientSecret.value,
        mailboxUser: mailboxUser.value,
        domainProfile: domainProfile.value,
        loginTenant: loginTenant.value,
        aiProvider: aiProvider.value,
        aiDataPolicyAccepted: aiProvider.value !== 'rules' && aiDataPolicyAccepted.checked,
        openaiCodexModel: openaiCodexModel.value,
        xaiGrokModel: xaiGrokModel.value,
        persist: true
      })
    });
    const status = await readApiPayload(response);
    if (!response.ok) throw new Error(status.message || '저장 실패');
    updateOutlookConnectionStatus(status);
    accessToken.value = '';
    clientSecret.value = '';
    aiDataPolicyAccepted.checked = status.aiProvider !== 'rules' && status.aiOptedIn === true;
    syncExternalAiConsent();
    await loadOauthProviderStatus();
    await loadOutlookMessages();
  } catch (error) {
    updateOutlookConnectionStatus({}, {
      phase: 'error',
      message: error instanceof Error ? error.message : '설정 저장 실패',
    });
  }
}

async function startOutlookLogin() {
  const selectedClientId = clientId.value.trim();
  if (!selectedClientId) {
    updateOutlookConnectionStatus({}, { phase: 'error', message: 'Client ID를 먼저 입력하세요.' });
    clientId.focus();
    return;
  }
  const popup = window.open('', 'outlookLogin', 'width=720,height=760');
  if (!popup) {
    updateOutlookConnectionStatus({}, {
      phase: 'error',
      message: '로그인 팝업이 차단되었습니다. 브라우저에서 팝업을 허용하세요.',
    });
    return;
  }
  try {
    popup.document.title = 'Outlook 로그인 준비 중';
    const response = await apiFetch('/api/outlook/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: selectedClientId,
        tenantId: loginTenant.value,
        mailboxUser: mailboxUser.value.trim()
      })
    });
    const payload = await readApiPayload(response);
    if (!response.ok || !payload.authorizeUrl) throw new Error(payload.message || 'OAuth 시작 실패');
    const authorize = new URL(payload.authorizeUrl);
    if (authorize.protocol !== 'https:' || authorize.hostname !== 'login.microsoftonline.com') {
      throw new Error('허용되지 않은 OAuth 주소가 반환되었습니다.');
    }
    popup.location.href = authorize.href;
    updateOutlookConnectionStatus({}, { phase: 'oauth-pending' });

    let finished = false;
    let monitor = 0;
    let timeout = 0;
    const finish = async (phase, message = '') => {
      if (finished) return;
      finished = true;
      window.clearInterval(monitor);
      window.clearTimeout(timeout);
      if (phase === 'error') {
        updateOutlookConnectionStatus({}, { phase, message });
      } else {
        await loadStatus();
      }
    };

    monitor = window.setInterval(() => {
      if (popup.closed) {
        void finish('closed');
        return;
      }
      try {
        const callbackUrl = new URL(popup.location.href);
        if (callbackUrl.hostname !== 'localhost' || callbackUrl.port !== '3010' || callbackUrl.pathname !== '/auth/callback') return;
        const callbackText = popup.document.body?.textContent?.trim() || '';
        if (/Outlook login complete/i.test(callbackText)) {
          void finish('success');
        } else if (/Outlook login failed/i.test(callbackText)) {
          void finish('error', callbackText.replace(/\s+/g, ' ').slice(0, 180));
        }
      } catch {
        // Microsoft login is cross-origin until it returns to the localhost callback.
      }
    }, 600);
    timeout = window.setTimeout(() => {
      void finish('error', 'Microsoft 로그인 시간이 만료되었습니다. 새 로그인 창에서 다시 시도하세요.');
    }, 10 * 60 * 1000);
  } catch (error) {
    popup.close();
    updateOutlookConnectionStatus({}, {
      phase: 'error',
      message: error instanceof Error ? error.message : '로컬 보안 세션 생성 실패',
    });
  }
}

async function loadOutlookMessages() {
  loadOutlook.disabled = true;
  updateFetchStatus('Outlook Delta 동기화 후 SQLite 메일을 분석하는 중입니다.');
  try {
    const response = await apiFetch(`/api/outlook/analyze?top=${encodeURIComponent(mailLimit.value)}`);
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || 'Outlook fetch failed');
    const sync = payload.sync;
    const syncLabel = sync
      ? sync.mode === 'offline-cache'
        ? `SQLite 메일 DB · 전체 ${sync.totalCached}건${sync.status === 'degraded' ? ' · Graph 동기화 실패' : ''}`
        : `${sync.mode === 'full-reset' ? '전체 재동기화' : 'Delta 동기화'} · 폴더 ${sync.completedFolders || 0}/${sync.discoveredFolders || 0} · 수집 ${sync.fetchedFromGraph || 0} · 반영 ${sync.upserted || 0} · 삭제 ${sync.deleted || 0} · 전체 ${sync.totalCached || 0}건`
      : `${payload.messages.length}개 메일`;
    const ai = payload.result?.ai;
    const providerLabel = ai?.provider === 'openai-codex-oauth'
      ? 'OpenAI · ChatGPT OAuth'
      : ai?.provider === 'xai-grok-oauth'
        ? 'xAI · Grok OAuth'
        : '규칙';
    const aiLabel = ai?.status === 'policy_blocked'
      ? '외부 AI 정책 차단 · Rules 결과 사용 · 운영자 승인 필요'
      : ai?.status === 'failed'
        ? `AI 실패 (${providerLabel} · ${ai.code || 'UNKNOWN'}) → 규칙 기반 임시 판단`
        : ai?.enabled
          ? `${providerLabel} AI 적용 (${ai.model}${Number.isFinite(ai.analyzed) ? ` · 신규분석 ${ai.analyzed}건` : ''}${Number.isFinite(ai.cached) ? ` · 캐시 ${ai.cached}건` : ''})`
          : ai?.status === 'not-run'
            ? 'AI 미실행 · 규칙 기반'
            : '규칙 기반';
    updateFetchStatus(payload.connected
      ? `${syncLabel} 분석 완료 · ${aiLabel} · ${new Date(payload.analyzedAt).toLocaleString('ko-KR')}`
      : `${syncLabel} 분석 완료 · ${aiLabel} · ${payload.message}`);
    updateOutlookConnectionStatus({
      connected: payload.connected,
      mode: payload.mode,
      authMode: payload.mode,
      safety: { mode: 'read-only' },
    });
    render(payload.result, payload.messages);
    if (payload.precision?.summary) renderPrecisionOverview(payload.precision.summary);
    await loadPrecisionProjects();
    await loadMemoryStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Outlook을 가져오지 못했습니다.';
    updateFetchStatus(message + ' · 현재 화면은 마지막으로 로드한 데이터입니다.');
    updateOutlookConnectionStatus({}, { phase: 'error', message });
  } finally {
    loadOutlook.disabled = false;
  }
}

loadOutlook.addEventListener('click', loadOutlookMessages);
searchDatabase.addEventListener('click', searchPersistentMemory);
refreshMemory.addEventListener('click', loadMemoryStatus);
syncPersistentMail.addEventListener('click', synchronizePersistentMemory);
backupPersistentMail.addEventListener('click', createPersistentMemoryBackup);
reclassifyPrecision.addEventListener('click', async () => {
  await loadPrecisionOverview({ force: true });
  if (currentMessages.length) await loadOutlookMessages();
});
projectForm.addEventListener('submit', createPrecisionProject);
configForm.addEventListener('submit', saveConfig);
loginOutlook.addEventListener('click', startOutlookLogin);
clearConfig.addEventListener('click', async () => {
  try {
    const response = await apiFetch('/api/outlook/config', { method: 'DELETE' });
    const payload = await readApiPayload(response);
    if (!response.ok) throw new Error(payload.message || '설정 초기화 실패');
    accessToken.value = ''; tenantId.value = ''; clientId.value = ''; clientSecret.value = ''; mailboxUser.value = ''; domainProfile.value = 'generic'; loginTenant.value = 'common'; aiProvider.value = 'rules'; openaiCodexModel.value = 'luna'; xaiGrokModel.value = 'grok-4.6'; aiDataPolicyAccepted.checked = false;
    syncExternalAiConsent();
    latestOutlookStatus = {};
    updateOutlookConnectionStatus({ connected: false, safety: { mode: 'read-only' } });
    updateFetchStatus('Outlook 저장값을 초기화했습니다.');
  } catch (error) {
    updateOutlookConnectionStatus({}, { phase: 'error', message: error instanceof Error ? error.message : '설정 초기화 실패' });
  }
});
aiProvider.addEventListener('change', syncExternalAiConsent);
refreshOauthProviders.addEventListener('click', loadOauthProviderStatus);
testOauthProvider.addEventListener('click', testSelectedOauthProvider);
saveAssistantPersonalityButton?.addEventListener('click', saveAssistantPersonality);
document.querySelectorAll('.metric').forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = activeFilter === button.dataset.filter ? 'all' : button.dataset.filter;
    renderFilteredView();
  });
});
mailSearch.addEventListener('input', () => {
  searchQuery = mailSearch.value;
  if (!searchQuery.trim()) {
    searchRequestSequence += 1;
    databaseSearchResults.hidden = true;
    clear(databaseSearchResults);
  }
  renderFilteredView();
});

const fetchStatusObserver = new MutationObserver(() => {
  fetchStatus.title = fetchStatus.textContent?.trim() || '';
});
fetchStatusObserver.observe(fetchStatus, { childList: true, characterData: true, subtree: true });
updateFetchStatus(fetchStatus.textContent);

syncExternalAiConsent();
loadStatus().finally(() => loadOutlookMessages());
loadMemoryStatus();
loadPrecisionOverview();
loadSmartViews();
loadAssistantPersonality();

// --- Column Resize (Drag & Drop) ---
(function initColumnResize() {
  const shell = document.getElementById('mailShell');
  if (!shell) return;

  const resizers = [...shell.querySelectorAll('.col-resizer')];
  const panels = [
    shell.querySelector('.mail-list-panel'),
    shell.querySelector('.detail-panel'),
    shell.querySelector('.action-column'),
  ];
  const widthVariables = ['--mail-list-width', '--mail-detail-width', '--mail-action-width'];
  const minimumWidths = [240, 320, 280];
  const desktopQuery = window.matchMedia('(min-width: 1181px)');

  if (panels.some((panel) => !panel) || resizers.length !== 2) return;

  function measuredWidths() {
    return panels.map((panel) => panel.getBoundingClientRect().width);
  }

  function setPanelWidth(index, width) {
    shell.style.setProperty(widthVariables[index], `${Math.round(width)}px`);
    const resizer = resizers[index] || resizers[index - 1];
    if (resizer) resizer.setAttribute('aria-valuenow', String(Math.round(width)));
  }

  function resizeAdjacentPanels(index, delta, startWidths) {
    const total = startWidths[index] + startWidths[index + 1];
    const left = Math.min(
      total - minimumWidths[index + 1],
      Math.max(minimumWidths[index], startWidths[index] + delta),
    );
    setPanelWidth(index, left);
    setPanelWidth(index + 1, total - left);
    resizers[index].setAttribute('aria-valuemin', String(minimumWidths[index]));
    resizers[index].setAttribute('aria-valuemax', String(Math.round(total - minimumWidths[index + 1])));
  }

  function resetPanelWidths() {
    widthVariables.forEach((variable) => shell.style.removeProperty(variable));
  }

  resizers.forEach((resizer) => {
    const columnIndex = Number.parseInt(resizer.dataset.col || '', 10);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex > 1) return;
    const widths = measuredWidths();
    resizer.setAttribute('aria-valuemin', String(minimumWidths[columnIndex]));
    resizer.setAttribute('aria-valuemax', String(Math.round(widths[columnIndex] + widths[columnIndex + 1] - minimumWidths[columnIndex + 1])));
    resizer.setAttribute('aria-valuenow', String(Math.round(widths[columnIndex])));

    resizer.addEventListener('mousedown', (event) => {
      if (!desktopQuery.matches || event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidths = measuredWidths();
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent) => {
        resizeAdjacentPanels(columnIndex, moveEvent.clientX - startX, startWidths);
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

    resizer.addEventListener('keydown', (event) => {
      if (!desktopQuery.matches || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const startWidths = measuredWidths();
      resizeAdjacentPanels(columnIndex, event.key === 'ArrowRight' ? 24 : -24, startWidths);
    });

    resizer.addEventListener('dblclick', resetPanelWidths);
  });

  desktopQuery.addEventListener('change', (event) => {
    if (!event.matches) resetPanelWidths();
  });
})();
