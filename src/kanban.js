/**
 * Mail Intelligence - Kanban Board View
 * 메일을 칸반 보드 형태로 시각화하고 드래그 앤 드롭으로 상태 변경
 */

import { escapeHtml, safeSelector, showToast, delegateEvent } from './utils.js';
import { setReminder } from './notifications.js';
import {
  groupMessagesByThread,
  latestMessageInThread,
  threadLabel,
  userRepliedInThread
} from './threadIdentity.mjs';

const VALID_LANES = ['urgent', 'active', 'waiting', 'done'];

const LANE_CONFIG = {
  urgent: { icon: '🔥', label: '긴급' },
  active: { icon: '⚡', label: '진행중' },
  waiting: { icon: '⏳', label: '대기' },
  done: { icon: '✅', label: '완료' }
};

let kanbanMode = false;

export function initKanban() {
  const kanbanToggle = document.querySelector('#kanbanToggle');
  if (!kanbanToggle) return;

  kanbanToggle.addEventListener('click', () => {
    kanbanMode = !kanbanMode;
    kanbanToggle.textContent = kanbanMode ? '리스트 보기' : '칸반 보기';
    document.body.classList.toggle('kanban-mode', kanbanMode);

    if (kanbanMode) {
      renderKanbanBoard();
    } else {
      renderListView();
    }
  });
}

export function renderKanbanBoard() {
  const mailShell = document.querySelector('#mailShell');
  if (!mailShell) return;

  try {
    // 현재 메일 데이터 가져오기
    const currentMessages = window.currentMessages || [];
    const currentResult = window.currentResult;

    // Kanban 컨테이너 생성
    const kanbanContainer = document.createElement('div');
    kanbanContainer.id = 'kanbanContainer';
    kanbanContainer.className = 'kanban-board';

    // 4칼럼 생성
    VALID_LANES.forEach(lane => {
      const config = LANE_CONFIG[lane];
      const column = document.createElement('div');
      column.className = `kanban-column`;
      column.dataset.lane = lane;

      column.innerHTML = `
        <div class="kanban-header ${lane}">
          <span class="kanban-icon">${config.icon}</span>
          <h3>${config.label}</h3>
          <span class="kanban-count" id="kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}Count">0</span>
        </div>
        <div class="kanban-cards" id="kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}"></div>
      `;

      kanbanContainer.appendChild(column);
    });

    // 기존 내용 숨기고 Kanban 표시
    mailShell.innerHTML = '';
    mailShell.appendChild(kanbanContainer);

    // 메일을 상태별로 분류
    const lanes = { urgent: [], active: [], waiting: [], done: [] };
    const mailboxUser = document.querySelector('#mailboxUser')?.value || '';
    const threadMap = groupMessagesByThread(currentMessages, { mailboxUser });

    threadMap.forEach((threadMessages) => {
      const message = latestMessageInThread(threadMessages);
      const insight = currentResult?.messageInsights?.find((i) => i.id === message.id);
      let status = insight?.effectiveStatus || insight?.status || 'active';
      if (userRepliedInThread(threadMessages, mailboxUser) && status === 'active') status = 'waiting';
      const lane = VALID_LANES.includes(status) ? status : 'active';
      lanes[lane].push({ message, insight, threadMessages });
    });

    // 각 칼럼에 카드 렌더링
    Object.entries(lanes).forEach(([lane, items]) => {
      const container = document.querySelector(`#kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}`);
      const countEl = document.querySelector(`#kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}Count`);
      if (container) {
        items.forEach(({ message, insight, threadMessages }) => {
          container.appendChild(createKanbanCard(message, insight, lane, threadMessages));
        });
      }
      if (countEl) {
        countEl.textContent = items.length;
      }
    });

    // 이벤트 위임 설정
    setupEventDelegation();

  } catch (error) {
    console.error('Kanban render error:', error);
    showToast('칸반 보드 렌더링 중 오류가 발생했습니다.', 'error');
  }
}

function createKanbanCard(message, insight, currentLane, threadMessages = []) {
  const card = document.createElement('div');
  card.className = `kanban-card ${currentLane}`;
  card.draggable = true;
  card.dataset.messageId = message.id;

  const sender = message.fromName || message.from || 'unknown';
  const domain = String(message.from || '').split('@')[1] || sender;
  const summary = insight?.summary?.[0] || message.bodyPreview || '';
  const isUnread = !message.isRead;
  const isAiEnhanced = insight?.aiEnhanced;
  const threadCount = threadMessages.length;
  const threadBadge = threadCount > 1 ? `<span class="kanban-thread-badge">${threadCount}통</span>` : '';
  const repliedBadge = userRepliedInThread(threadMessages, document.querySelector('#mailboxUser')?.value || '')
    ? '<span class="kanban-thread-badge">회신함</span>'
    : '';

  card.innerHTML = `
    <div class="kanban-card-header">
      ${threadBadge}${repliedBadge}
      <span class="kanban-card-sender">${escapeHtml(sender)}</span>
      ${isUnread ? '<span class="kanban-unread-dot"></span>' : ''}
      ${isAiEnhanced ? '<span class="kanban-ai-badge">AI</span>' : ''}
    </div>
    <div class="kanban-card-subject">${escapeHtml(message.subject || '(제목 없음)')}</div>
    <div class="kanban-card-summary">${escapeHtml(summary.slice(0, 100))}</div>
    <div class="kanban-card-meta">
      <span class="kanban-card-domain">${escapeHtml(domain)}</span>
      <span class="kanban-card-date">${message.receivedAt ? new Date(message.receivedAt).toLocaleDateString('ko-KR') : ''}</span>
    </div>
    <div class="kanban-card-actions">
      <button class="kanban-action-btn" data-action="detail" title="상세 보기">📋</button>
      <button class="kanban-action-btn" data-action="move" title="상태 변경">🔄</button>
    </div>
  `;

  return card;
}

function setupEventDelegation() {
  const kanbanContainer = document.querySelector('#kanbanContainer');
  if (!kanbanContainer) return;

  // 카드 클릭 이벤트 위임
  delegateEvent(kanbanContainer, 'click', '.kanban-card', (e, card) => {
    if (e.target.closest('.kanban-action-btn')) return;
    const messageId = card.dataset.messageId;
    if (messageId && typeof window.selectMessage === 'function') {
      window.selectMessage(messageId);
    }
  });

  // 액션 버튼 이벤트 위임
  delegateEvent(kanbanContainer, 'click', '.kanban-action-btn', (e, btn) => {
    e.stopPropagation();
    const card = btn.closest('.kanban-card');
    if (!card) return;

    const messageId = card.dataset.messageId;
    const action = btn.dataset.action;

    if (action === 'detail') {
      if (typeof window.selectMessage === 'function') {
        window.selectMessage(messageId);
      }
    } else if (action === 'move') {
      showMoveMenu(messageId, card);
    }
  });

  // 드래그 앤 드롭 이벤트 위임
  delegateEvent(kanbanContainer, 'dragstart', '.kanban-card', (e, card) => {
    e.dataTransfer.setData('text/plain', card.dataset.messageId);
    card.classList.add('dragging');
  });

  delegateEvent(kanbanContainer, 'dragend', '.kanban-card', (e, card) => {
    card.classList.remove('dragging');
  });

  delegateEvent(kanbanContainer, 'dragover', '.kanban-cards', (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  });

  delegateEvent(kanbanContainer, 'dragleave', '.kanban-cards', (e) => {
    e.currentTarget.classList.remove('drag-over');
  });

  delegateEvent(kanbanContainer, 'drop', '.kanban-cards', (e, column) => {
    e.preventDefault();
    column.classList.remove('drag-over');

    const messageId = e.dataTransfer.getData('text/plain');
    const targetLane = column.id.replace('kanban', '').toLowerCase();

    if (messageId && VALID_LANES.includes(targetLane)) {
      moveKanbanCard(messageId, targetLane);
    }
  });
}

function showMoveMenu(messageId, card) {
  // 기존 메뉴 제거
  const existingMenu = document.querySelector('.kanban-move-menu');
  if (existingMenu) existingMenu.remove();

  const currentLane = card.closest('.kanban-column')?.dataset.lane;
  const menu = document.createElement('div');
  menu.className = 'kanban-move-menu';

  // 상태 변경 옵션
  VALID_LANES.forEach(lane => {
    if (lane === currentLane) return;
    const config = LANE_CONFIG[lane];
    const btn = document.createElement('button');
    btn.className = 'kanban-move-option';
    btn.dataset.targetLane = lane;
    btn.innerHTML = `${config.icon} ${config.label}`;
    menu.appendChild(btn);
  });

  // 구분선
  const divider = document.createElement('div');
  divider.className = 'kanban-move-divider';
  menu.appendChild(divider);

  // 리마인더 옵션
  const reminderOptions = [
    { hours: 1, label: '⏰ 1시간 후 리마인더' },
    { hours: 3, label: '⏰ 3시간 후 리마인더' },
    { hours: 24, label: '⏰ 내일 리마인더' }
  ];

  reminderOptions.forEach(option => {
    const btn = document.createElement('button');
    btn.className = 'kanban-move-option reminder-option';
    btn.dataset.hours = option.hours;
    btn.textContent = option.label;
    menu.appendChild(btn);
  });

  card.appendChild(menu);

  // 메뉴 클릭 이벤트 위임
  delegateEvent(menu, 'click', '.kanban-move-option', (e, btn) => {
    if (btn.classList.contains('reminder-option')) {
      const hours = parseInt(btn.dataset.hours);
      const message = (window.currentMessages || []).find(m => m.id === messageId);
      const subject = message?.subject || '메일';
      setReminder(messageId, hours, `${subject} - 확인이 필요합니다.`);
      menu.remove();
    } else {
      const targetLane = btn.dataset.targetLane;
      if (targetLane && VALID_LANES.includes(targetLane)) {
        moveKanbanCard(messageId, targetLane);
        menu.remove();
      }
    }
  });

  // 외부 클릭 시 메뉴 닫기
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

async function moveKanbanCard(messageId, targetLane) {
  try {
    const safeId = safeSelector(messageId);
    const card = document.querySelector(`[data-message-id="${safeId}"]`);
    if (!card) return;

    const targetContainer = document.querySelector(`#kanban${targetLane.charAt(0).toUpperCase() + targetLane.slice(1)}`);
    if (!targetContainer) return;

    // 카드 이동
    card.className = `kanban-card ${targetLane}`;
    targetContainer.appendChild(card);

    // 카운트 업데이트
    updateKanbanCounts();

    // 피드백 저장 (reasonCode 포함)
    if (typeof window.saveFeedback === 'function') {
      const saved = await window.saveFeedback(messageId, targetLane, targetLane);
      if (!saved) {
        showToast('카드 이동 상태 저장에 실패했습니다.', 'error');
        return;
      }
    }

    showToast(`${LANE_CONFIG[targetLane].label}(으)로 이동되었습니다.`, 'success');

  } catch (error) {
    console.error('Move card error:', error);
    showToast('카드 이동 중 오류가 발생했습니다.', 'error');
  }
}

function updateKanbanCounts() {
  VALID_LANES.forEach(lane => {
    const container = document.querySelector(`#kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}`);
    const countEl = document.querySelector(`#kanban${lane.charAt(0).toUpperCase() + lane.slice(1)}Count`);
    if (container && countEl) {
      countEl.textContent = container.children.length;
    }
  });
}

function renderListView() {
  window.restoreMailShellLayout?.();

  if (typeof window.renderFilteredView === 'function') {
    window.renderFilteredView();
  }
}
