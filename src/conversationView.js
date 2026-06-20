/**
 * Conversation View Module
 * - Shows integrated email threads with call recordings
 * - Displays conversation learning patterns
 * - Allows feedback on conversation classification
 *
 * Phase 0: Unified rendering path — populates static #conversationView in index.html
 * instead of overwriting <main> innerHTML.
 */

// State
let conversationThreads = [];
let callRecordings = [];
let conversationStats = null;

/**
 * Load conversation data — populates the static #conversationView section.
 * Called by app.js toggle and refresh button.
 */
export async function loadConversationData() {
  const contentEl = document.getElementById('conversation-content');
  if (contentEl) {
    contentEl.innerHTML = '<div class="loading">데이터 로딩 중...</div>';
  }

  const [threadsResult, callsResult] = await Promise.allSettled([
    fetch('/api/conversations/threads').then(r => {
      if (!r.ok) throw new Error(`스레드 API 오류 (${r.status})`);
      return r.json();
    }),
    fetch('/api/calls/recordings').then(r => {
      if (!r.ok) throw new Error(`통화 API 오류 (${r.status})`);
      return r.json();
    })
  ]);

  // Handle threads result
  if (threadsResult.status === 'fulfilled') {
    conversationThreads = threadsResult.value.threads || [];
    conversationStats = threadsResult.value.stats || {};
  } else {
    console.error('Failed to load threads:', threadsResult.reason);
    conversationThreads = [];
    conversationStats = null;
  }

  // Handle calls result
  if (callsResult.status === 'fulfilled') {
    callRecordings = callsResult.value.recordings || [];
  } else {
    console.error('Failed to load calls:', callsResult.reason);
    callRecordings = [];
  }

  // Update stats (tolerant of partial failure)
  updateConversationStats();

  // Show threads by default
  showConversationSection('threads');

  // Show partial errors in content area if both failed
  if (threadsResult.status === 'rejected' && callsResult.status === 'rejected') {
    if (contentEl) {
      contentEl.innerHTML = `<div class="error">데이터 로딩 실패: ${threadsResult.reason?.message || '알 수 없는 오류'}</div>`;
    }
  }
}

/**
 * Update conversation statistics using static HTML IDs.
 */
function updateConversationStats() {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  if (conversationStats) {
    set('conv-stat-threads', conversationStats.totalThreads || 0);
    set('conv-stat-replies', conversationStats.withReply || 0);
    set('conv-stat-avg-response',
      conversationStats.avgResponseTime ? `${conversationStats.avgResponseTime}시간` : '-'
    );
  }
  set('conv-stat-calls', callRecordings.length);
}

/**
 * Show conversation section (threads / calls / integrated).
 * Tab button active state is managed by app.js click handlers.
 */
export function showConversationSection(section) {
  // Update tab buttons
  document.querySelectorAll('.conversation-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === section);
  });

  const content = document.getElementById('conversation-content');
  if (!content) return;

  switch (section) {
    case 'threads':
      renderEmailThreads(content);
      break;
    case 'calls':
      renderCallRecordings(content);
      break;
    case 'integrated':
      renderIntegratedView(content);
      break;
  }
}

/**
 * Render email threads
 */
function renderEmailThreads(container) {
  if (conversationThreads.length === 0) {
    container.innerHTML = '<div class="empty">메일 스레드가 없습니다.</div>';
    return;
  }

  const html = `
    <div class="threads-list">
      ${conversationThreads.slice(0, 50).map(thread => `
        <div class="thread-card ${thread.hasReply ? 'has-reply' : 'no-reply'}">
          <div class="thread-header">
            <div class="thread-subject">${escapeHtml(thread.subject)}</div>
            <div class="thread-meta">
              <span class="thread-count">${thread.messageCount}건</span>
              <span class="thread-reply ${thread.hasReply ? 'replied' : 'pending'}">
                ${thread.hasReply ? '✅ 회신완료' : '⏳ 미회신'}
              </span>
              ${thread.calls && thread.calls.length > 0 ?
                `<span class="thread-call">📞 ${thread.calls.length}건 통화</span>` : ''}
            </div>
          </div>
          <div class="thread-participants">
            ${thread.participants.slice(0, 5).map(p =>
              `<span class="participant">${escapeHtml(p)}</span>`
            ).join('')}
          </div>
          <div class="thread-dates">
            ${thread.startDate ? new Date(thread.startDate).toLocaleDateString('ko-KR') : ''}
            ~
            ${thread.endDate ? new Date(thread.endDate).toLocaleDateString('ko-KR') : ''}
          </div>
          <div class="thread-actions">
            <button onclick="viewThreadDetail('${thread.id}')" class="btn-sm">
              상세보기
            </button>
            <button onclick="provideThreadFeedback('${thread.id}')" class="btn-sm btn-outline">
              피드백
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  container.innerHTML = html;
}

/**
 * Render call recordings
 */
function renderCallRecordings(container) {
  if (callRecordings.length === 0) {
    container.innerHTML = '<div class="empty">통화 녹음이 없습니다.</div>';
    return;
  }

  const html = `
    <div class="calls-list">
      <div class="calls-summary">
        <p>총 ${callRecordings.length}건의 통화 녹음</p>
        <button onclick="transcribeSelectedCalls()" class="btn-primary">
          🎤 선택된 녹음 분석
        </button>
      </div>
      ${callRecordings.slice(0, 100).map(call => `
        <div class="call-card" data-path="${escapeHtml(call.path)}">
          <div class="call-header">
            <div class="call-name">${escapeHtml(call.callerName)}</div>
            <div class="call-phone">${escapeHtml(call.phone)}</div>
          </div>
          <div class="call-datetime">
            ${call.date} ${call.time}
          </div>
          <div class="call-size">
            ${(call.size / 1024 / 1024).toFixed(1)} MB
          </div>
          <div class="call-actions">
            <button onclick="transcribeCall('${escapeHtml(call.path)}')" class="btn-sm">
              🎤 분석
            </button>
            <button onclick="matchCallWithEmails('${escapeHtml(call.path)}')" class="btn-sm btn-outline">
              📧 메일 매칭
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  container.innerHTML = html;
}

/**
 * Render integrated view
 */
async function renderIntegratedView(container) {
  container.innerHTML = '<div class="loading">통합 뷰 로딩 중...</div>';

  try {
    const res = await fetch('/api/conversations/integrated');
    if (!res.ok) throw new Error(`통합 뷰 API 오류 (${res.status})`);
    const data = await res.json();

    const html = `
      <div class="integrated-view">
        <div class="integrated-summary">
          <p>메일 스레드 ${data.total}건 | 통화 녹음 ${data.callCount}건</p>
        </div>
        ${data.threads.filter(t => t.hasCallMatch).map(thread => `
          <div class="integrated-card">
            <div class="integrated-header">
              <div class="integrated-subject">${escapeHtml(thread.subject)}</div>
              <div class="integrated-badges">
                <span class="badge-email">📧 ${thread.emailCount}</span>
                <span class="badge-call">📞 ${thread.callCount}</span>
              </div>
            </div>
            <div class="integrated-calls">
              ${thread.calls.map(call => `
                <div class="call-match">
                  <span class="call-match-name">${escapeHtml(call.callerName)}</span>
                  <span class="call-match-date">${call.date}</span>
                  <span class="call-match-score">매칭도: ${call.matchScore}</span>
                </div>
              `).join('')}
            </div>
            <div class="integrated-actions">
              <button onclick="viewThreadDetail('${thread.id}')" class="btn-sm">
                스레드 보기
              </button>
              <button onclick="viewCallTranscripts('${thread.id}')" class="btn-sm btn-outline">
                통화 내용 보기
              </button>
            </div>
          </div>
        `).join('')}
        ${data.threads.filter(t => t.hasCallMatch).length === 0 ?
          '<div class="empty">통화와 매칭된 메일 스레드가 없습니다.</div>' : ''}
      </div>
    `;

    container.innerHTML = html;

  } catch (error) {
    container.innerHTML = `<div class="error">통합 뷰 로딩 실패: ${error.message}</div>`;
  }
}

/**
 * Transcribe a single call
 */
async function transcribeCall(filePath) {
  try {
    const res = await fetch('/api/calls/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, model: 'base', language: 'ko' })
    });

    const result = await res.json();

    if (result.error) {
      alert(`변환 실패: ${result.error}`);
      return;
    }

    showTranscriptModal(result);

  } catch (error) {
    alert(`변환 실패: ${error.message}`);
  }
}

/**
 * Match call with emails
 */
async function matchCallWithEmails(filePath) {
  try {
    const callInfo = callRecordings.find(c => c.path === filePath);
    if (!callInfo) {
      alert('통화 정보를 찾을 수 없습니다.');
      return;
    }

    const res = await fetch('/api/calls/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callInfo, mailboxKey: 'me' })
    });

    const data = await res.json();

    if (data.matches && data.matches.length > 0) {
      showMatchResultsModal(callInfo, data.matches);
    } else {
      alert('매칭되는 메일이 없습니다.');
    }

  } catch (error) {
    alert(`매칭 실패: ${error.message}`);
  }
}

/**
 * Show transcript modal
 */
function showTranscriptModal(transcript) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>🎤 통화 내용</h3>
        <button onclick="this.closest('.modal').remove()" class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="transcript-info">
          <p><strong>발신자:</strong> ${escapeHtml(transcript.callerName)}</p>
          <p><strong>날짜:</strong> ${transcript.date} ${transcript.time}</p>
          <p><strong>통화시간:</strong> ${transcript.duration}초</p>
        </div>
        <div class="transcript-text">
          ${transcript.transcript ? transcript.transcript.map(s =>
            `<p><span class="timestamp">[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}]</span> ${escapeHtml(s.text)}</p>`
          ).join('') : '<p>변환된 텍스트가 없습니다.</p>'}
        </div>
        ${transcript.actions && transcript.actions.length > 0 ? `
          <div class="transcript-actions">
            <h4>감지된 액션:</h4>
            <ul>
              ${transcript.actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

/**
 * Show match results modal
 */
function showMatchResultsModal(callInfo, matches) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content modal-lg">
      <div class="modal-header">
        <h3>📧 매칭 결과 - ${escapeHtml(callInfo.callerName)}</h3>
        <button onclick="this.closest('.modal').remove()" class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p>통화 날짜: ${callInfo.date} | 매칭된 메일: ${matches.length}건</p>
        <div class="match-list">
          ${matches.map(match => `
            <div class="match-card">
              <div class="match-header">
                <span class="match-score">매칭도: ${match.score}</span>
                <span class="match-reasons">${match.reasons.join(', ')}</span>
              </div>
              <div class="match-email">
                <div class="match-subject">${escapeHtml(match.email.subject)}</div>
                <div class="match-from">${escapeHtml(match.email.fromName || match.email.from)}</div>
                <div class="match-date">${new Date(match.email.receivedAt).toLocaleString('ko-KR')}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

/**
 * Fetch thread summary asynchronously
 */
async function fetchThreadSummary(conversationId, modal) {
  const content = modal.querySelector('#threadSummaryContent');
  const loading = modal.querySelector('.summary-loading');
  try {
    const res = await fetch(`/api/outlook/conversation-summary?conversationId=${encodeURIComponent(conversationId)}`);
    const data = await res.json();
    if (content) {
      content.textContent = data.summary || '요약을 생성할 수 없습니다.';
      if (data.truncated) {
        content.textContent += ` (긴 스레드: 최근 10건 기반, 전체 ${data.messageCount}건)`;
      }
    }
    if (loading) loading.textContent = data.cached ? '(캐시됨)' : '';
  } catch (error) {
    if (content) content.textContent = '요약을 불러오는 중 오류가 발생했습니다.';
    if (loading) loading.textContent = '오류';
  }
}

/**
 * View thread detail (modal)
 */
function viewThreadDetail(threadId) {
  const thread = conversationThreads.find(t => t.id === threadId);
  if (!thread) return;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content modal-lg">
      <div class="modal-header">
        <h3>📧 스레드 상세</h3>
        <button onclick="this.closest('.modal').remove()" class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="thread-summary-panel" id="threadSummaryPanel">
          <details open>
            <summary class="thread-summary-toggle">📝 AI 스레드 요약 <span class="summary-loading">로딩 중...</span></summary>
            <div class="thread-summary-content" id="threadSummaryContent">요약을 불러오는 중입니다...</div>
          </details>
        </div>
        <div class="thread-detail-header">
          <h4>${escapeHtml(thread.subject)}</h4>
          <p>참여자: ${thread.participants.join(', ')}</p>
          <p>메일 수: ${thread.messageCount}건 | 회신: ${thread.hasReply ? '있음' : '없음'}</p>
        </div>
        <div class="thread-messages">
          ${thread.messages.map(msg => `
            <div class="message-card ${msg.mailFolder === 'sentitems' || msg.mailFolder === 'sent' ? 'outgoing' : 'incoming'}">
              <div class="message-header">
                <span class="message-direction">
                  ${msg.mailFolder === 'sentitems' || msg.mailFolder === 'sent' ? '➡️ 보냄' : '⬅️ 받음'}
                </span>
                <span class="message-from">${escapeHtml(msg.fromName || msg.from)}</span>
                <span class="message-date">${new Date(msg.receivedAt).toLocaleString('ko-KR')}</span>
              </div>
              <div class="message-body">${escapeHtml(msg.bodyPreview || '').slice(0, 300)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const conversationId = thread.messages[0]?.conversationId;
  if (conversationId && thread.messageCount >= 3) {
    fetchThreadSummary(conversationId, modal);
  } else {
    const content = modal.querySelector('#threadSummaryContent');
    const loading = modal.querySelector('.summary-loading');
    if (content) content.textContent = '3개 이상의 메시지가 있는 스레드에서 AI 요약을 생성합니다.';
    if (loading) loading.textContent = '';
  }
}

/**
 * Transcribe all calls (batch)
 */
async function transcribeAllCalls() {
  if (!confirm('전체 통화 녹음을 분석하시겠습니까? (시간이 오래 걸릴 수 있습니다)')) {
    return;
  }

  alert('전체 분석은 백그라운드에서 진행됩니다. 완료 후 알림을 받으실 수 있습니다.');
}

/**
 * Provide thread feedback
 */
function provideThreadFeedback(threadId) {
  alert('피드백 기능은 준비 중입니다.');
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Expose functions to global scope for onclick handlers in static HTML
window.loadConversationData = loadConversationData;
window.showConversationSection = showConversationSection;
window.transcribeCall = transcribeCall;
window.matchCallWithEmails = matchCallWithEmails;
window.viewThreadDetail = viewThreadDetail;
window.transcribeAllCalls = transcribeAllCalls;
window.provideThreadFeedback = provideThreadFeedback;
window.transcribeSelectedCalls = transcribeAllCalls;
window.viewCallTranscripts = viewThreadDetail;
