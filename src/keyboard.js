/**
 * Mail Intelligence - 키보드 단축키
 */

import { showToast } from './utils.js';

const SHORTCUTS = {
  'j': { description: '다음 메일', action: 'nextMessage' },
  'k': { description: '이전 메일', action: 'prevMessage' },
  'e': { description: '아카이브 (완료)', action: 'archive' },
  'r': { description: '회신', action: 'reply' },
  's': { description: '상태 변경', action: 'changeStatus' },
  '/': { description: '검색', action: 'focusSearch' },
  '?': { description: '도움말', action: 'showHelp' },
  'Escape': { description: '닫기', action: 'close' },
  'Enter': { description: '메일 열기', action: 'openMail' }
};

const STATUS_CYCLE = ['urgent', 'active', 'waiting', 'done'];
const STATUS_LABELS = { urgent: '긴급', active: '진행중', waiting: '대기', done: '완료' };

let helpPanelVisible = false;

export function initKeyboard() {
  document.addEventListener('keydown', handleKeydown);
}

function handleKeydown(event) {
  // 입력 필드에서는 단축키 무시 (Escape 제외)
  if (event.key !== 'Escape' && isInputFocused()) {
    return;
  }

  const shortcut = SHORTCUTS[event.key];
  if (!shortcut) return;

  event.preventDefault();
  executeAction(shortcut.action);
}

function isInputFocused() {
  const activeElement = document.activeElement;
  if (!activeElement) return false;

  const tag = activeElement.tagName;
  const isEditable = activeElement.isContentEditable;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  return isEditable || isInput;
}

function executeAction(action) {
  switch (action) {
    case 'nextMessage':
      navigateMessage(1);
      break;
    case 'prevMessage':
      navigateMessage(-1);
      break;
    case 'archive':
      archiveMessage();
      break;
    case 'reply':
      replyToMessage();
      break;
    case 'changeStatus':
      changeMessageStatus();
      break;
    case 'focusSearch':
      focusSearch();
      break;
    case 'showHelp':
      toggleHelp();
      break;
    case 'close':
      closeAll();
      break;
    case 'openMail':
      openSelectedMail();
      break;
  }
}

function navigateMessage(direction) {
  const threadIds = window.threadGroupList || [];
  const messages = window.currentMessages || [];
  const pool = threadIds.length
    ? threadIds.map((id) => messages.find((m) => m.id === id)).filter(Boolean)
    : messages;
  if (pool.length === 0) return;

  const currentIndex = pool.findIndex((m) => m.id === window.selectedMessageId);
  let nextIndex;

  if (currentIndex === -1) {
    nextIndex = direction > 0 ? 0 : pool.length - 1;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = pool.length - 1;
    if (nextIndex >= pool.length) nextIndex = 0;
  }

  const nextMessage = pool[nextIndex];
  if (nextMessage && typeof window.selectMessage === 'function') {
    window.selectMessage(nextMessage.id);
    scrollToMessage(nextMessage.id);
  }
}

function scrollToMessage(messageId) {
  const threadCard = document.querySelector(
    `.thread-card [data-message-id="${messageId}"]`
  )?.closest('.thread-card');
  const card =
    threadCard ||
    document.querySelector(`[data-message-id="${messageId}"]`) ||
    document.querySelectorAll('.message-card')[
      (window.currentMessages || []).findIndex((m) => m.id === messageId)
    ];
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.classList.add('keyboard-focused');
    document.querySelectorAll('.thread-card.keyboard-focused').forEach((node) => {
      if (node !== card && node.classList.contains('thread-card')) {
        node.classList.remove('keyboard-focused');
      }
    });
    setTimeout(() => card.classList.remove('keyboard-focused'), 1000);
  }
}

function archiveMessage() {
  const messageId = window.selectedMessageId;
  if (!messageId) {
    showToast('선택된 메일이 없습니다.', 'info');
    return;
  }

  if (typeof window.saveFeedback === 'function') {
    window.saveFeedback(messageId, 'done', 'done');
    showToast('메일이 완료로 이동되었습니다.', 'success');
    
    // 다음 메일로 이동
    setTimeout(() => navigateMessage(1), 300);
  }
}

function replyToMessage() {
  const messageId = window.selectedMessageId;
  if (!messageId) {
    showToast('선택된 메일이 없습니다.', 'info');
    return;
  }

  const messages = window.currentMessages || [];
  const threadMessages = typeof window.threadGroupsFor === 'function'
    ? [...window.threadGroupsFor(messages).values()].find((items) => items.some((m) => m.id === messageId))
    : null;
  if (threadMessages && typeof window.userRepliedInThread === 'function') {
    const mailbox = document.querySelector('#mailboxUser')?.value || '';
    if (window.userRepliedInThread(threadMessages, mailbox)) {
      showToast('이미 회신한 스레드입니다.', 'info');
      return;
    }
  }

  const message = messages.find(m => m.id === messageId);
  if (!message) return;

  // 회신 모달 열기 (기존 app.js의 mountComposer 활용)
  if (typeof window.mountComposer === 'function') {
    window.mountComposer({
      id: `reply-${messageId}`,
      to: message.from || '',
      subject: `RE: ${message.subject || ''}`,
      body: '',
      recommendedAction: '회신 작성',
      messageId: messageId
    });
  } else {
    showToast('회신 기능을 사용할 수 없습니다.', 'error');
  }
}

function changeMessageStatus() {
  const messageId = window.selectedMessageId;
  if (!messageId) {
    showToast('선택된 메일이 없습니다.', 'info');
    return;
  }

  const insight = (window.currentResult?.messageInsights || []).find(i => i.id === messageId);
  const currentStatus = insight?.effectiveStatus || insight?.status || 'active';
  const currentIndex = STATUS_CYCLE.indexOf(currentStatus);
  const nextIndex = (currentIndex + 1) % STATUS_CYCLE.length;
  const nextStatus = STATUS_CYCLE[nextIndex];

  if (typeof window.saveFeedback === 'function') {
    window.saveFeedback(messageId, nextStatus, nextStatus);
    showToast(`상태가 ${STATUS_LABELS[nextStatus]}(으)로 변경되었습니다.`, 'success');
  }
}

function focusSearch() {
  const searchInput = document.querySelector('#mailSearch');
  if (searchInput) {
    searchInput.focus();
    searchInput.select();
  }
}

function toggleHelp() {
  helpPanelVisible = !helpPanelVisible;
  
  let helpPanel = document.querySelector('#keyboardHelp');
  
  if (helpPanelVisible) {
    if (!helpPanel) {
      helpPanel = document.createElement('div');
      helpPanel.id = 'keyboardHelp';
      helpPanel.className = 'keyboard-help-panel';
      helpPanel.innerHTML = `
        <div class="keyboard-help-content">
          <h3>키보드 단축키</h3>
          <div class="shortcut-list">
            ${Object.entries(SHORTCUTS).map(([key, { description }]) => `
              <div class="shortcut-item">
                <kbd>${key === ' ' ? 'Space' : key}</kbd>
                <span>${description}</span>
              </div>
            `).join('')}
          </div>
          <button class="close-help" onclick="document.querySelector('#keyboardHelp').remove()">닫기</button>
        </div>
      `;
      document.body.appendChild(helpPanel);
    }
    helpPanel.style.display = 'flex';
  } else if (helpPanel) {
    helpPanel.style.display = 'none';
  }
}

function closeAll() {
  // 도움말 패널 닫기
  const helpPanel = document.querySelector('#keyboardHelp');
  if (helpPanel) {
    helpPanel.style.display = 'none';
    helpPanelVisible = false;
  }

  // Kanban 모달 닫기
  const moveMenu = document.querySelector('.kanban-move-menu');
  if (moveMenu) moveMenu.remove();

  // 검색 포커스 해제
  const searchInput = document.querySelector('#mailSearch');
  if (searchInput === document.activeElement) {
    searchInput.blur();
  }
}

function openSelectedMail() {
  const messageId = window.selectedMessageId;
  if (messageId && typeof window.selectMessage === 'function') {
    window.selectMessage(messageId);
  }
}
