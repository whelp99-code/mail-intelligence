import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  attachmentTypeLabel,
  formatReceivedAttachmentSize,
  receivedAttachmentView,
  renderReceivedAttachments,
} from '../src/received-attachments.js';

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
  }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

const doc = { createElement: (tag) => new FakeNode(tag) };

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

function all(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children) all(child, predicate, out);
  return out;
}

const synthetic = {
  attachments: [
    { name: 'quote-2026.pdf', contentType: 'application/pdf', size: 250_000, isInline: false },
    { name: 'image001.png', contentType: 'image/png', size: 4_000, isInline: true },
    { name: '<img src=x onerror=alert(1)>.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 3_500_000, isInline: false },
  ],
};

test('view separates real files from inline images and labels type and size', () => {
  const view = receivedAttachmentView(synthetic);
  assert.equal(view.total, 3);
  assert.equal(view.inlineCount, 1);
  assert.deepEqual(view.files.map((file) => file.name), ['quote-2026.pdf', '<img src=x onerror=alert(1)>.xlsx']);
  assert.equal(view.files[0].meta, 'PDF · 244.1 KB');
  assert.equal(view.files[1].meta, '스프레드시트 · 3.3 MB');
  assert.equal(formatReceivedAttachmentSize(0), '');
  assert.equal(attachmentTypeLabel({ attachmentType: '#microsoft.graph.itemAttachment' }), '첨부된 메일·항목');
  assert.equal(attachmentTypeLabel({ contentType: '' }), '형식 미상');
  assert.equal(receivedAttachmentView({ attachments: [{ name: '  ', isInline: false }] }).files[0].name, '이름 없는 첨부 파일');
});

test('ready state renders one row per file with names as text, not markup', () => {
  const container = new FakeNode('section');
  renderReceivedAttachments(container, { status: 'ready', payload: synthetic }, doc);
  assert.equal(container.hidden, false);
  const rows = all(container, (node) => node.className === 'attachment-row');
  assert.equal(rows.length, 2);
  assert.match(container.textContent, /첨부 파일 2개/);
  assert.match(container.textContent, /본문에 삽입된 이미지 1개는 목록에서 제외/);
  assert.match(container.textContent, /Outlook에서/);
  const hostile = find(container, (node) => node.textContent === '<img src=x onerror=alert(1)>.xlsx' && node.className === 'attachment-row-name');
  assert.ok(hostile, 'file name is carried as textContent');
  assert.equal(all(container, (node) => node.tagName === 'img').length, 0);
});

test('inline-only messages explain that there is no separate file', () => {
  const container = new FakeNode('section');
  renderReceivedAttachments(container, { status: 'ready', payload: { attachments: [synthetic.attachments[1]] } }, doc);
  assert.equal(container.hidden, false);
  assert.equal(all(container, (node) => node.className === 'attachment-row').length, 0);
  assert.match(container.textContent, /별도 첨부 파일은 없고, 본문에 삽입된 이미지 1개/);
});

test('messages without stored attachments hide the section', () => {
  const container = new FakeNode('section');
  renderReceivedAttachments(container, { status: 'loading' }, doc);
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /불러오는 중/);
  renderReceivedAttachments(container, { status: 'ready', payload: { attachments: [] } }, doc);
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
  renderReceivedAttachments(container, { status: 'ready', payload: {} }, doc);
  assert.equal(container.hidden, true);
});

test('API failure is shown to the operator instead of an empty list', () => {
  const container = new FakeNode('section');
  renderReceivedAttachments(container, { status: 'error', message: 'MESSAGE_NOT_FOUND' }, doc);
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /첨부 파일 목록을 불러오지 못했습니다\. \(MESSAGE_NOT_FOUND\)/);
});

test('message detail loads the list through the read-only endpoint and ignores stale responses', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ renderReceivedAttachments \} from '\.\/received-attachments\.js';/);
  assert.match(app, /id="receivedAttachments"/);
  assert.match(app, /\/api\/intelligence\/attachments\?messageId=\$\{encodeURIComponent\(messageId\)\}/);
  assert.match(app, /requestSequence !== receivedAttachmentSequence \|\| messageId !== selectedMessageId/);
  const loader = app.slice(app.indexOf('async function loadReceivedAttachments'), app.indexOf('async function loadReceivedAttachments') + 1200);
  assert.doesNotMatch(loader, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
});
