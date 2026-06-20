/**
 * Mail Intelligence - 공통 유틸리티 모듈
 */

/**
 * HTML 특수문자 이스케이프
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * CSS 선택자에 안전한 ID 생성
 */
export function safeSelector(value) {
  return CSS.escape(String(value));
}

/**
 * 토스트 알림 표시
 */
export function showToast(message, type = 'info') {
  const container = document.querySelector('#toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // 3초 후 자동 제거
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * DOM 안전 쿼리 (optional chaining 지원)
 */
export function safeQuery(selector) {
  return document.querySelector(selector) || null;
}

/**
 * 이벤트 위임 헬퍼
 */
export function delegateEvent(parent, eventType, selector, handler) {
  if (typeof parent === 'string') {
    parent = document.querySelector(parent);
  }
  if (!parent) return;

  parent.addEventListener(eventType, (e) => {
    const target = e.target.closest(selector);
    if (target && parent.contains(target)) {
      handler(e, target);
    }
  });
}
