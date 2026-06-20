/**
 * Mail Intelligence - 검색 강화
 */

import { escapeHtml } from './utils.js';

const SAVED_SEARCHES_KEY = 'mail-intelligence-saved-searches';

export function initSearch() {
  const searchInput = document.querySelector('#mailSearch');
  if (!searchInput) return;

  // 검색어 입력 시 하이라이팅
  searchInput.addEventListener('input', () => {
    highlightSearchResults(searchInput.value);
  });

  // 검색 저장 버튼 추가
  addSaveSearchButton();
}

function highlightSearchResults(query) {
  if (!query.trim()) {
    // 하이라이팅 제거
    document.querySelectorAll('.search-highlight').forEach(el => {
      el.outerHTML = el.textContent;
    });
    return;
  }

  const messageCards = document.querySelectorAll('.message-card');
  messageCards.forEach(card => {
    const subject = card.querySelector('.message-subject');
    const summary = card.querySelector('.message-summary');
    
    if (subject) highlightText(subject, query);
    if (summary) highlightText(summary, query);
  });
}

function highlightText(element, query) {
  const text = element.textContent;
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  
  if (regex.test(text)) {
    element.innerHTML = text.replace(regex, '<mark class="search-highlight">$1</mark>');
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addSaveSearchButton() {
  const searchField = document.querySelector('.search-field');
  if (!searchField) return;

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'save-search-btn';
  saveBtn.textContent = '💾';
  saveBtn.title = '검색 저장';
  saveBtn.addEventListener('click', saveCurrentSearch);

  searchField.appendChild(saveBtn);

  // 저장된 검색 목록 드롭다운
  const savedList = document.createElement('div');
  savedList.className = 'saved-searches-list';
  savedList.id = 'savedSearchesList';
  searchField.appendChild(savedList);

  // 저장된 검색 불러오기
  loadSavedSearches();
}

function saveCurrentSearch() {
  const searchInput = document.querySelector('#mailSearch');
  if (!searchInput || !searchInput.value.trim()) return;

  const query = searchInput.value.trim();
  const savedSearches = getSavedSearches();
  
  // 중복 체크
  if (savedSearches.includes(query)) {
    return;
  }

  savedSearches.unshift(query);
  
  // 최대 10개까지만 저장
  if (savedSearches.length > 10) {
    savedSearches.pop();
  }

  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(savedSearches));
  loadSavedSearches();
}

function getSavedSearches() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || '[]');
  } catch {
    return [];
  }
}

function loadSavedSearches() {
  const savedList = document.querySelector('#savedSearchesList');
  if (!savedList) return;

  const savedSearches = getSavedSearches();
  
  if (savedSearches.length === 0) {
    savedList.style.display = 'none';
    return;
  }

  savedList.innerHTML = `
    <div class="saved-searches-header">저장된 검색</div>
    ${savedSearches.map((query, index) => `
      <div class="saved-search-item" data-query="${escapeHtml(query)}">
        <span class="saved-search-text">${escapeHtml(query)}</span>
        <button class="saved-search-delete" data-index="${index}" title="삭제">✕</button>
      </div>
    `).join('')}
  `;

  // 클릭 이벤트
  savedList.querySelectorAll('.saved-search-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.saved-search-delete')) return;
      const query = item.dataset.query;
      const searchInput = document.querySelector('#mailSearch');
      if (searchInput) {
        searchInput.value = query;
        searchInput.dispatchEvent(new Event('input'));
      }
    });
  });

  // 삭제 이벤트
  savedList.querySelectorAll('.saved-search-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const savedSearches = getSavedSearches();
      savedSearches.splice(index, 1);
      localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(savedSearches));
      loadSavedSearches();
    });
  });

  // 포커스 시 표시
  const searchInput = document.querySelector('#mailSearch');
  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      savedList.style.display = 'block';
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        savedList.style.display = 'none';
      }, 200);
    });
  }
}
