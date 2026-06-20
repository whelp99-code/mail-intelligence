/**
 * Mail Intelligence - 알림 시스템
 */

import { showToast } from './utils.js';

const REMINDERS_KEY = 'mail-intelligence-reminders';

export function initNotifications() {
  // 브라우저 알림 권한 요청
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // 저장된 리마인더 확인
  checkReminders();

  // 1분마다 리마인더 확인
  setInterval(checkReminders, 60000);
}

export function setReminder(messageId, hours, message) {
  const reminders = getReminders();
  const reminderTime = new Date(Date.now() + hours * 60 * 60 * 1000);

  reminders.push({
    messageId,
    message: message || `메일 ID: ${messageId} - 확인이 필요합니다.`,
    reminderTime: reminderTime.toISOString(),
    createdAt: new Date().toISOString()
  });

  localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
  showToast(`리마인더가 ${hours}시간 후로 설정되었습니다.`, 'success');
}

function getReminders() {
  try {
    return JSON.parse(localStorage.getItem(REMINDERS_KEY) || '[]');
  } catch {
    return [];
  }
}

function checkReminders() {
  const reminders = getReminders();
  const now = new Date();
  const pendingReminders = [];
  const triggeredReminders = [];

  reminders.forEach(reminder => {
    const reminderTime = new Date(reminder.reminderTime);
    if (reminderTime <= now) {
      triggeredReminders.push(reminder);
    } else {
      pendingReminders.push(reminder);
    }
  });

  // 트리거된 리마인더 처리
  triggeredReminders.forEach(reminder => {
    showNotification(reminder.message);
    showToast(`⏰ 리마인더: ${reminder.message}`, 'info');
  });

  // 처리된 리마인더 제거
  if (triggeredReminders.length > 0) {
    localStorage.setItem(REMINDERS_KEY, JSON.stringify(pendingReminders));
  }
}

function showNotification(message) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Mail Intelligence 리마인더', {
      body: message,
      icon: '/favicon.ico',
      badge: '/favicon.ico'
    });
  }
}

export function getReminderCount() {
  return getReminders().length;
}

export function clearReminders() {
  localStorage.removeItem(REMINDERS_KEY);
  showToast('모든 리마인더가 삭제되었습니다.', 'success');
}
