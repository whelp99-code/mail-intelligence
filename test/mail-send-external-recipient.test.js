import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMailSendApi } from '../src/application/mail-send-api.js';
import { GraphSendClient } from '../src/adapters/microsoft-graph-send.js';
import {
  companyDomainsFromEnvironment,
  externalRecipientAddresses,
} from '../src/security/mail-send-company-domain.js';
import { initializeSendReview } from '../src/send-review.js';

const secret = 'synthetic-restricted-draft-token-0123456789';
const claims = Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url');
const domains = ['blro.example'];

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let sends = 0;
  const api = createMailSendApi({
    getStore: () => ({ db }),
    getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null,
    readBody: async (req) => req.body,
    getAccessToken: async () => `fixture.${claims}.fixture`,
    serviceToken: secret,
    allowSend: true,
    accessKeyRequired: true,
    companyDomains: domains,
    getAttachmentKey: async () => Buffer.alloc(32, 17),
    clientFactory: () => ({
      sendOnce: async () => {
        sends += 1;
        return { graphMessageId: 'fixture-not-a-network-send', sentAt: '2026-10-31T08:00:00Z' };
      },
    }),
    ...options,
  });
  const human = { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' };
  const call = (method, path, payload = {}, headers = human) => api(
    { method, body: payload, headers },
    new URL(`http://127.0.0.1:3010/api/mail/send-drafts${path}`),
  );
  return { call, sends: () => sends, db };
}

let requestSerial = 0;
async function draft(f, to, cc = []) {
  const created = await f.call('POST', '', {
    request_id: `external-recipient-${++requestSerial}`,
    to,
    cc,
    subject: 'Synthetic',
    body_text: 'This test must not send mail.',
  }, { authorization: `Bearer ${secret}` });
  assert.equal(created.status, 201);
  return created.body.draft;
}

test('company domain config is empty unless set', () => {
  assert.equal(companyDomainsFromEnvironment({}), null);
  assert.equal(companyDomainsFromEnvironment({ MAIL_INTELLIGENCE_COMPANY_DOMAINS: '  ' }), null);
  assert.deepEqual(companyDomainsFromEnvironment({ MAIL_INTELLIGENCE_COMPANY_DOMAINS: 'BLRO.example, partner.example' }), ['blro.example', 'partner.example']);
  assert.throws(() => companyDomainsFromEnvironment({ MAIL_INTELLIGENCE_COMPANY_DOMAINS: 'not a domain' }), { code: 'MAIL_COMPANY_DOMAIN_INVALID' });
});

test('external recipient is rejected before send and passes only after the extra confirmation', async (t) => {
  const f = fixture(t);
  const outside = await draft(f, ['vendor@other.example'], ['ops@blro.example']);
  await assert.rejects(
    f.call('POST', `/${outside.draft_id}/approve`, { confirm: true, payload_digest: outside.payload_digest }),
    { code: 'EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED' },
  );
  assert.equal(f.sends(), 0);
  assert.equal(f.db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id=?').get(outside.draft_id).status, 'needs_approval');

  const approved = await f.call('POST', `/${outside.draft_id}/approve`, {
    confirm: true,
    payload_digest: outside.payload_digest,
    external_recipient_confirmed: true,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.draft.status, 'sent');
  assert.equal(f.sends(), 1);
  assert.equal(approved.body.draft.graph_message_id, 'fixture-not-a-network-send');
});

test('internal recipients need no extra confirmation and are not external', async (t) => {
  assert.deepEqual(externalRecipientAddresses({ to: ['ops@blro.example'], cc: ['finance@blro.example'] }, domains), []);
  const f = fixture(t);
  const inside = await draft(f, ['ops@blro.example'], ['finance@blro.example']);
  const approved = await f.call('POST', `/${inside.draft_id}/approve`, { confirm: true, payload_digest: inside.payload_digest });
  assert.equal(approved.body.draft.status, 'sent');
  assert.equal(f.sends(), 1);
});

test('Graph sendOnce refuses an external recipient before any HTTP send', async () => {
  let calls = 0;
  const client = new GraphSendClient({
    accessToken: `fixture.${claims}.fixture`,
    companyDomains: domains,
    fetchImpl: async () => { calls += 1; throw new Error('network must not be called'); },
  });
  const draft = {
    draft_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    status: 'sending',
    approved_at: '2026-10-31T08:00:00Z',
    approved_by: 'session:fixture',
    to: ['vendor@other.example'],
    cc: [],
    subject: 'Synthetic',
    body_text: 'no send',
  };
  await assert.rejects(client.sendOnce(draft, { allowSend: true }), { code: 'EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED' });
  assert.equal(calls, 0);
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.className = '';
    this._text = '';
    this.disabled = false;
    this.type = '';
    this.id = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.dataset = {};
  }
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
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  querySelector(selector) { return query(this, selector); }
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.tagName === selector.toLowerCase();
}
function query(root, selector) {
  let found = null;
  const walk = (node) => {
    if (!found && matches(node, selector)) found = node;
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return found;
}

function reviewDocument() {
  const createElement = (tag) => new FakeNode(tag);
  const body = createElement('body');
  const panel = createElement('section'); panel.id = 'sendDraftReview';
  const ids = ['sendDraftList', 'sendDraftDetail', 'sendDraftStatus', 'attachmentLive', 'composeAttachmentList'];
  const nodes = Object.fromEntries(ids.map((id) => {
    const node = createElement(id === 'composeAttachmentList' ? 'ul' : 'div');
    node.id = id;
    return [id, node];
  }));
  const form = createElement('form'); form.id = 'sendDraftForm';
  for (const id of ['sendDraftTo', 'sendDraftCc', 'sendDraftSubject', 'sendDraftBody', 'attachmentFileInput', 'driveLinkUrl', 'driveLinkLabel', 'driveFileId']) {
    const input = createElement('input'); input.id = id; form.append(input);
  }
  for (const id of ['saveSendDraft', 'attachLocalFiles', 'attachDriveLink', 'refreshSendDrafts', 'confirmDriveLink', 'confirmDriveImport', 'connectGoogleDrive']) {
    const button = createElement('button'); button.id = id; form.append(button);
  }
  const drive = createElement('div'); drive.id = 'driveLinkComposer'; drive.hidden = true;
  const driveAck = createElement('input'); driveAck.id = 'driveLinkAck'; drive.append(driveAck);
  const driveFiles = createElement('div'); driveFiles.id = 'driveFileComposer'; driveFiles.hidden = true;
  const driveStatus = createElement('p'); driveStatus.id = 'driveConnectionStatus';
  const exportMime = createElement('select'); exportMime.id = 'driveExportMime';
  form.append(drive, driveFiles, driveStatus, exportMime, nodes.attachmentLive, nodes.composeAttachmentList);
  const refresh = form.querySelector('#refreshSendDrafts');
  panel.append(nodes.sendDraftStatus, form, nodes.sendDraftList, nodes.sendDraftDetail, refresh);
  body.append(panel);
  return { body, createElement, createTextNode: (text) => Object.assign(new FakeNode('#text'), { _text: text }), querySelector: (selector) => query(body, selector) };
}

test('send review warns only for a recipient outside the company domain', async () => {
  const document = reviewDocument();
  globalThis.document = document;
  const drafts = {
    outside: {
      draft_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      status: 'needs_approval', source: 'ui', to: ['vendor@other.example'], cc: [],
      subject: '밖', body_text: 'synthetic', payload_digest: 'outside-digest',
    },
    inside: {
      draft_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      status: 'needs_approval', source: 'ui', to: ['ops@blro.example'], cc: ['finance@blro.example'],
      subject: '안', body_text: 'synthetic', payload_digest: 'inside-digest',
    },
  };
  const approvals = [];
  const apiFetch = async (url, options = {}) => {
    const id = String(url).split('/').pop();
    const found = Object.values(drafts).find((item) => item.draft_id === id);
    if (options.method === 'POST' && String(url).endsWith('/approve')) {
      approvals.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ draft: { ...(found || drafts.outside), status: 'sent' }, send_enabled: true, company_domains: domains }) };
    }
    if (found) return { ok: true, json: async () => ({ draft: found, send_enabled: true, company_domains: domains }) };
    return { ok: true, json: async () => ({ drafts: Object.values(drafts), send_enabled: true, company_domains: domains }) };
  };
  initializeSendReview(apiFetch);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  const buttons = [];
  const walk = (node) => {
    if (node.tagName === 'button' && node.parent?.id === 'sendDraftList') buttons.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(document.body);
  assert.equal(buttons.length, 2);
  buttons[0].listeners.click[0]();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  const detail = document.querySelector('#sendDraftDetail');
  assert.equal(document.querySelector('#externalRecipientWarning')?.textContent.includes('vendor@other.example'), true);
  const approve = document.querySelector('#approveSendDraft');
  document.querySelector('#confirmSendDraft').checked = true;
  document.querySelector('#confirmSendDraft').listeners.change[0]();
  assert.equal(approve.disabled, true);
  document.querySelector('#confirmExternalRecipient').checked = true;
  document.querySelector('#confirmExternalRecipient').listeners.change[0]();
  assert.equal(approve.disabled, false);
  approve.listeners.click[0]();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.equal(approvals[0].external_recipient_confirmed, true);

  buttons[1].listeners.click[0]();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.equal(document.querySelector('#externalRecipientWarning'), null);
  assert.equal(document.querySelector('#confirmExternalRecipient'), null);
  assert.match(document.querySelector('#sendDraftDetail').textContent, /ops@blro.example/);
});
test('unset company domains warn for every recipient', async (t) => {
  const recipients = { to: ['ops@blro.example'], cc: ['finance@blro.example'] };
  assert.deepEqual(externalRecipientAddresses(recipients, null), ['ops@blro.example', 'finance@blro.example']);
  assert.deepEqual(externalRecipientAddresses(recipients, []), ['ops@blro.example', 'finance@blro.example']);
  const f = fixture(t, { companyDomains: null });
  const item = await draft(f, ['ops@blro.example'], ['finance@blro.example']);
  await assert.rejects(
    f.call('POST', `/${item.draft_id}/approve`, { confirm: true, payload_digest: item.payload_digest }),
    { code: 'EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED' },
  );
  assert.equal(f.sends(), 0);

  const document = reviewDocument();
  globalThis.document = document;
  const shown = {
    draft_id: 'cccccccc-dddd-4eee-8fff-000000000001',
    status: 'needs_approval', source: 'ui', to: ['ops@blro.example'], cc: [],
    subject: '미설정', body_text: 'synthetic', payload_digest: 'unset-digest',
  };
  initializeSendReview(async (url) => {
    if (String(url).endsWith(shown.draft_id)) {
      return { ok: true, json: async () => ({ draft: shown, send_enabled: true, company_domains: [] }) };
    }
    return { ok: true, json: async () => ({ drafts: [shown], send_enabled: true, company_domains: [] }) };
  });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  const button = document.querySelector('#sendDraftList').children.find((node) => node.tagName === 'button');
  button.listeners.click[0]();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.match(document.querySelector('#externalRecipientWarning').textContent, /ops@blro.example/);
  assert.equal(document.querySelector('#approveSendDraft').disabled, true);
});
