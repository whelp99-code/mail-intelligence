import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app] = await Promise.all([
  readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
]);

test('desktop mail workspace is the first primary section and keeps five grid tracks', () => {
  const mailShell = html.indexOf('id="mailShell"');
  const precision = html.indexOf('id="precisionIntelligence"');
  const memory = html.indexOf('id="persistentMemory"');
  const settings = html.indexOf('id="configForm"');

  assert.ok(mailShell > 0);
  assert.ok(mailShell < precision, 'mail workspace must precede secondary precision details');
  assert.ok(precision < memory);
  assert.ok(memory < settings);
  assert.equal((html.match(/class="col-resizer"/g) || []).length, 2);
  assert.equal((html.match(/role="separator"/g) || []).length, 2);
  assert.equal((html.match(/aria-orientation="vertical"/g) || []).length, 2);
  assert.equal((html.match(/aria-valuemin=/g) || []).length, 2);
  assert.equal((html.match(/aria-valuemax=/g) || []).length, 2);
  assert.equal((html.match(/aria-valuenow=/g) || []).length, 2);

  assert.match(css, /\.mail-shell\s*\{[\s\S]*?grid-template-columns:\s*\n\s*minmax\(240px,[\s\S]*?\) 6px\s*\n\s*minmax\(320px,[\s\S]*?\) 6px\s*\n\s*minmax\(280px,/);
  assert.match(css, /height:\s*clamp\(540px, calc\(100vh - 178px\), 760px\)/);
  assert.doesNotMatch(app, /shell\.style\.gridTemplateColumns/);
  assert.doesNotMatch(app, /\.style\.flex\s*=/);
  assert.match(app, /--mail-list-width/);
  assert.match(app, /resizeAdjacentPanels/);
  assert.match(app, /setAttribute\('aria-valuenow'/);
});

test('scope labels distinguish loaded, stored, and global precision counts', () => {
  assert.match(html, /Precision Classification · 저장 전체/);
  assert.match(html, /저장 메일/);
  assert.match(app, /현재 로드 \$\{currentMessages\.length\}건 중/);
  assert.match(app, /저장 전체 정밀 분류/);
});

test('settings are split, bounded, and secondary sections remain collapsed by default', () => {
  assert.match(html, /class="config-section config-section-outlook" open/);
  assert.match(html, /<summary><span>Outlook 인증<\/span>/);
  assert.match(html, /<summary><span>고급 Outlook 인증<\/span>/);
  assert.match(html, /<summary><span>AI Provider<\/span>/);
  assert.match(html, /<summary><span>초안 작성 성격<\/span>/);
  assert.equal((html.match(/class="config-section[^"]*" open/g) || []).length, 1);
  assert.match(css, /\.config-panel\[open\] \.config-grid\s*\{[\s\S]*?max-height:\s*min\(68vh, 620px\);[\s\S]*?overflow:\s*auto/);
  assert.match(css, /\.config-section-grid-primary/);
});

test('responsive layout hides desktop resizers and connection state has one renderer', () => {
  assert.match(css, /@media \(width <= 1180px\) \{[\s\S]*?\.mail-shell\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(width <= 1180px\) \{[\s\S]*?\.col-resizer\s*\{\s*display:\s*none;/);
  assert.match(app, /function updateOutlookConnectionStatus/);
  assert.match(app, /for \(const node of \[connectionStatus, configStatus\]\)/);
  assert.match(app, /phase === 'oauth-pending'/);
  assert.match(app, /Outlook login failed/);
  assert.match(app, /new MutationObserver/);
});
