import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  composeSaveBlocked,
  encodeBrowserFileName,
  formatAttachmentBytes,
  initializeSendReview,
} from '../src/send-review.js';

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this._text = '';
    this.disabled = false;
    this.type = '';
    this.id = '';
    this.href = '';
    this.target = '';
    this.rel = '';
    this.value = '';
    this.checked = false;
    this.open = false;
    this.files = [];
    this.hidden = false;
  }
  reset() { this.value = ''; }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) {
    for (const item of nodes) {
      const node = typeof item === 'string' ? Object.assign(new FakeNode('#text'), { _text: item }) : item;
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  click() { (this.listeners.click || []).forEach((fn) => fn()); }
  addEventListener(name, fn) { this.listeners[name] = this.listeners[name] || []; this.listeners[name].push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
  querySelector(selector) { return query(this, selector); }
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.tagName === selector.toLowerCase();
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function query(root, selector) {
  let found = null;
  walk(root, (node) => { if (!found && matches(node, selector)) found = node; });
  return found;
}

function createDocument() {
  const createElement = (tag) => new FakeNode(tag);
  const body = createElement('body');
  const panel = createElement('section'); panel.id = 'sendDraftReview';
  const list = createElement('div'); list.id = 'sendDraftList';
  const detail = createElement('article'); detail.id = 'sendDraftDetail';
  const status = createElement('p'); status.id = 'sendDraftStatus';
  const form = createElement('form'); form.id = 'sendDraftForm';
  const compose = createElement('details'); compose.className = 'send-compose';
  const to = createElement('input'); to.id = 'sendDraftTo'; to.value = 'self@example.com';
  const cc = createElement('input'); cc.id = 'sendDraftCc';
  const subject = createElement('input'); subject.id = 'sendDraftSubject'; subject.value = 'UI fixture';
  const bodyInput = createElement('textarea'); bodyInput.id = 'sendDraftBody'; bodyInput.value = 'Synthetic only.';
  const save = createElement('button'); save.id = 'saveSendDraft'; save.type = 'submit';
  const attach = createElement('button'); attach.id = 'attachLocalFiles'; attach.type = 'button';
  const attachLink = createElement('button'); attachLink.id = 'attachDriveLink'; attachLink.type = 'button';
  const fileInput = createElement('input'); fileInput.id = 'attachmentFileInput'; fileInput.type = 'file';
  const driveComposer = createElement('div'); driveComposer.id = 'driveLinkComposer'; driveComposer.hidden = true;
  const driveUrl = createElement('input'); driveUrl.id = 'driveLinkUrl';
  const driveLabel = createElement('input'); driveLabel.id = 'driveLinkLabel';
  const driveAck = createElement('input'); driveAck.id = 'driveLinkAck'; driveAck.type = 'checkbox';
  const confirmLink = createElement('button'); confirmLink.id = 'confirmDriveLink'; confirmLink.type = 'button';
  driveComposer.append(driveUrl, driveLabel, driveAck, confirmLink);
  const live = createElement('p'); live.id = 'attachmentLive';
  const composeList = createElement('ul'); composeList.id = 'composeAttachmentList';
  const refresh = createElement('button'); refresh.id = 'refreshSendDrafts';
  form.append(to, cc, subject, bodyInput, attach, attachLink, fileInput, driveComposer, live, composeList, save);
  compose.append(form);
  panel.append(status, compose, list, detail, refresh);
  body.append(panel);
  return {
    body,
    createElement,
    createTextNode: (text) => Object.assign(new FakeNode('#text'), { _text: text }),
    querySelector: (selector) => query(body, selector),
  };
}

test('helpers encode names, format sizes, and block unfinished uploads', () => {
  assert.equal(formatAttachmentBytes(12), '12 bytes');
  assert.match(formatAttachmentBytes(2048), /2048 bytes/);
  assert.equal(composeSaveBlocked([{ state: 'uploading' }]), true);
  assert.equal(composeSaveBlocked([{ state: 'failed' }]), true);
  assert.equal(composeSaveBlocked([{ state: 'ready' }]), false);
  const encoded = encodeBrowserFileName('<img src=x>.txt');
  assert.doesNotMatch(encoded, /[<>]/);
});

test('compose UI uploads a synthetic file, blocks save while pending, and keeps filename in textContent', async () => {
  const document = createDocument();
  globalThis.document = document;
  globalThis.URL.createObjectURL = () => 'blob:fixture';
  globalThis.URL.revokeObjectURL = () => {};
  if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
  const uploaded = [];
  let created;
  const apiFetch = async (url, options = {}) => {
    if (url === '/api/mail/send-drafts' && !options.method) {
      return { ok: true, json: async () => ({ drafts: created ? [created] : [], send_enabled: true }) };
    }
    if (url === '/api/mail/attachment-assets') {
      uploaded.push(options);
      return {
        ok: true,
        json: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          name: '<img src=x>.txt',
          mime: 'text/plain',
          size: 4,
          sha256: 'abcd',
          state: 'ready',
        }),
      };
    }
    if (url === '/api/mail/send-drafts' && options.method === 'POST') {
      created = {
        draft_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        status: 'needs_approval',
        source: 'ui',
        to: ['self@example.com'],
        cc: [],
        subject: 'UI fixture',
        body_text: 'Synthetic only.',
        payload_digest: 'digest',
        attachments: [{
          id: '11111111-1111-4111-8111-111111111111',
          name: '<img src=x>.txt',
          size: 4,
          origin: 'local',
          state: 'ready',
        }],
      };
      return { ok: true, json: async () => ({ draft: created, replay: false }) };
    }
    if (String(url).endsWith('/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')) {
      return { ok: true, json: async () => ({ draft: created, send_enabled: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  initializeSendReview(apiFetch);
  await Promise.resolve();
  const fileInput = document.querySelector('#attachmentFileInput');
  fileInput.files = [{ name: '<img src=x>.txt', size: 4, type: 'text/plain' }];
  await fileInput.listeners.change[0]();
  const rowName = document.querySelector('.attachment-row-name');
  assert.equal(rowName.textContent, '<img src=x>.txt');
  assert.doesNotMatch(JSON.stringify(uploaded[0].headers), /<img/);
  const form = document.querySelector('#sendDraftForm');
  await form.listeners.submit[0]({ preventDefault() {} });
  const detail = document.querySelector('#sendDraftDetail');
  assert.match(detail.textContent, /<img src=x>\.txt/);
  assert.match(detail.textContent, /수신인, 본문, 첨부파일\/링크를 확인했습니다/);
  assert.match(detail.textContent, /다운로드하여 검토/);
});

test('markup keeps the three attachment actions, live status, and overflow wrapping', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="attachLocalFiles"/);
  assert.match(html, /id="attachDriveFiles"/);
  assert.match(html, /id="attachDriveLink"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="composeAttachmentList"/);
  assert.match(html, /id="driveLinkComposer"/);
  assert.match(html, /id="attachDriveLink"/);
  assert.doesNotMatch(html, /id="attachDriveLink"[^>]*disabled/);
  assert.doesNotMatch(html, /id="attachDriveFiles"[^>]*disabled/);
  assert.match(html, /id="driveFileComposer"/);
  assert.match(html, /파일 첨부가 아닌 링크이며 수신자의 접근 권한은 확인되지 않았습니다/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.drive-link-row/);
  assert.match(css, /@media \(width <= 720px\)/);
  assert.match(html, /<label>수신자/);
  assert.match(html, /<label>본문/);
  assert.doesNotMatch(html, /재발송/);
  assert.match(html, /tabindex="0"/);
});

test('Drive link composer requires the access warning and stores acknowledged links', async () => {
  const document = createDocument();
  globalThis.document = document;
  let created;
  const apiFetch = async (url, options = {}) => {
    if (url === '/api/mail/send-drafts' && !options.method) {
      return { ok: true, json: async () => ({ drafts: created ? [created] : [], send_enabled: true }) };
    }
    if (url === '/api/mail/send-drafts' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      created = {
        draft_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        status: 'needs_approval',
        source: 'ui',
        to: ['self@example.com'],
        cc: [],
        subject: 'UI fixture',
        body_text: `Synthetic only.\n\n---\nGoogle Drive 링크 (파일 첨부가 아닌 링크이며 수신자의 접근 권한은 확인되지 않았습니다.)\n- Spec: ${body.drive_links[0].url}\n`,
        payload_digest: 'digest',
        attachments: [],
        links: body.drive_links,
      };
      return { ok: true, json: async () => ({ draft: created, replay: false }) };
    }
    if (String(url).endsWith('/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')) {
      return { ok: true, json: async () => ({ draft: created, send_enabled: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  initializeSendReview(apiFetch);
  await Promise.resolve();
  document.querySelector('#attachDriveLink').click();
  assert.equal(document.querySelector('#driveLinkComposer').hidden, false);
  document.querySelector('#driveLinkUrl').value = 'https://drive.google.com/file/d/abcDEF123/view?usp=sharing';
  document.querySelector('#driveLinkLabel').value = 'Spec';
  document.querySelector('#confirmDriveLink').click();
  assert.match(document.querySelector('#attachmentLive').textContent, /접근 권한 미확인/);
  document.querySelector('#driveLinkAck').checked = true;
  document.querySelector('#confirmDriveLink').click();
  assert.match(document.querySelector('.drive-link-row').textContent, /파일 첨부가 아닌 링크/);
  const form = document.querySelector('#sendDraftForm');
  await form.listeners.submit[0]({ preventDefault() {} });
  assert.equal(created.links[0].access_acknowledged, true);
  assert.equal(created.links[0].url, 'https://drive.google.com/file/d/abcDEF123/view');
  assert.match(document.querySelector('#sendDraftDetail').textContent, /파일 첨부가 아닌 링크이며 수신자의 접근 권한은 확인되지 않았습니다/);
  assert.equal(document.querySelector('#sendDraftDetail').textContent.includes(created.body_text.trim()), true);
});
