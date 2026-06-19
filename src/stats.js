/**
 * Mail Intelligence - 통계 대시보드
 */

import { escapeHtml } from './utils.js';

export function initStats() {
  const statsToggle = document.querySelector('#statsToggle');
  if (!statsToggle) return;

  statsToggle.addEventListener('click', () => {
    const isStats = document.body.classList.toggle('stats-mode');
    statsToggle.textContent = isStats ? '메일 보기' : '통계 보기';
    if (isStats) {
      renderStatsDashboard();
    } else {
      renderMailView();
    }
    window.persistMailboxUiState?.();
  });
}

export function renderStatsDashboard() {
  const mailShell = document.querySelector('#mailShell');
  if (!mailShell) return;

  const messages = window.currentMessages || [];
  const result = window.currentResult;

  // 통계 데이터 계산
  const stats = calculateStats(messages, result);

  mailShell.innerHTML = `
    <div class="stats-dashboard">
      <div class="stats-header">
        <h2>📊 메일 통계 대시보드</h2>
        <p class="stats-subtitle">전체 ${stats.total}건 메일 분석 결과</p>
      </div>

      <div class="stats-grid">
        <!-- 상태별 분포 -->
        <div class="stats-card">
          <h3>상태별 분포</h3>
          <div class="status-chart">
            ${createStatusBar(stats.statusCounts, stats.total)}
          </div>
          <div class="status-legend">
            ${Object.entries(stats.statusCounts).map(([status, count]) => `
              <div class="legend-item">
                <span class="legend-dot ${status}"></span>
                <span>${getStatusLabel(status)}: ${count}건</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 발신자 TOP 5 -->
        <div class="stats-card">
          <h3>발신자 TOP 5</h3>
          <div class="sender-list">
            ${stats.topSenders.map((sender, index) => `
              <div class="sender-item">
                <span class="sender-rank">${index + 1}</span>
                <span class="sender-name">${escapeHtml(sender.name)}</span>
                <span class="sender-count">${sender.count}건</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 오늘의 메일 -->
        <div class="stats-card">
          <h3>오늘의 메일</h3>
          <div class="today-stats">
            <div class="today-item">
              <span class="today-label">전체</span>
              <span class="today-value">${stats.today.total}건</span>
            </div>
            <div class="today-item">
              <span class="today-label">읽지 않음</span>
              <span class="today-value unread">${stats.today.unread}건</span>
            </div>
            <div class="today-item">
              <span class="today-label">긴급</span>
              <span class="today-value urgent">${stats.today.urgent}건</span>
            </div>
          </div>
        </div>

        <!-- 읽음 비율 -->
        <div class="stats-card">
          <h3>읽음 비율</h3>
          <div class="read-chart">
            <div class="read-bar">
              <div class="read-fill" style="width: ${stats.readPercentage}%"></div>
            </div>
            <span class="read-percentage">${stats.readPercentage}%</span>
          </div>
          <div class="read-details">
            <span>읽음: ${stats.readCount}건</span>
            <span>안읽음: ${stats.unreadCount}건</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function calculateStats(messages, result) {
  const statusCounts = { urgent: 0, active: 0, waiting: 0, done: 0 };
  const senderMap = {};
  let readCount = 0;
  let unreadCount = 0;
  let todayTotal = 0;
  let todayUnread = 0;
  let todayUrgent = 0;

  const today = new Date().toDateString();

  messages.forEach(message => {
    // 상태별 카운트
    const insight = result?.messageInsights?.find(i => i.id === message.id);
    const status = insight?.effectiveStatus || insight?.status || 'active';
    if (statusCounts[status] !== undefined) {
      statusCounts[status]++;
    }

    // 발신자 카운트
    const sender = message.fromName || message.from || 'unknown';
    senderMap[sender] = (senderMap[sender] || 0) + 1;

    // 읽음 카운트
    if (message.isRead) {
      readCount++;
    } else {
      unreadCount++;
    }

    // 오늘 메일 카운트
    if (message.receivedAt && new Date(message.receivedAt).toDateString() === today) {
      todayTotal++;
      if (!message.isRead) todayUnread++;
      if (status === 'urgent') todayUrgent++;
    }
  });

  // 발신자 TOP 5
  const topSenders = Object.entries(senderMap)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const total = messages.length;
  const readPercentage = total > 0 ? Math.round((readCount / total) * 100) : 0;

  return {
    total,
    statusCounts,
    topSenders,
    readCount,
    unreadCount,
    readPercentage,
    today: { total: todayTotal, unread: todayUnread, urgent: todayUrgent }
  };
}

function createStatusBar(statusCounts, total) {
  if (total === 0) return '<div class="status-bar-empty">데이터 없음</div>';

  const percentages = {
    urgent: (statusCounts.urgent / total) * 100,
    active: (statusCounts.active / total) * 100,
    waiting: (statusCounts.waiting / total) * 100,
    done: (statusCounts.done / total) * 100
  };

  return `
    <div class="status-bar">
      <div class="status-segment urgent" style="width: ${percentages.urgent}%"></div>
      <div class="status-segment active" style="width: ${percentages.active}%"></div>
      <div class="status-segment waiting" style="width: ${percentages.waiting}%"></div>
      <div class="status-segment done" style="width: ${percentages.done}%"></div>
    </div>
  `;
}

function getStatusLabel(status) {
  const labels = { urgent: '긴급', active: '진행중', waiting: '대기', done: '완료' };
  return labels[status] || status;
}

function renderMailView() {
  window.restoreMailShellLayout?.();

  if (typeof window.renderFilteredView === 'function') {
    window.renderFilteredView();
  }
}
