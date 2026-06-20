/**
 * Mail Intelligence - 다크모드
 */

export function initTheme() {
  const themeToggle = document.querySelector('#themeToggle');
  if (!themeToggle) return;

  // 저장된 테마 불러오기
  const savedTheme = localStorage.getItem('mail-intelligence-theme') || 'light';
  setTheme(savedTheme);

  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('mail-intelligence-theme', newTheme);
  });

  // 시스템 테마 변경 감지
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('mail-intelligence-theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  
  const themeToggle = document.querySelector('#themeToggle');
  if (themeToggle) {
    themeToggle.textContent = theme === 'light' ? '🌙 다크모드' : '☀️ 라이트모드';
  }
}
