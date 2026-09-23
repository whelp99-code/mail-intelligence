import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  DRIVE_LINK_WARNING,
  digestDriveLinks,
  normalizeDriveLinks,
  parseDriveLink,
  renderDriveLinks,
} from '../src/application/drive-links.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return new MailSendDrafts(db);
}

const FILE = 'https://drive.google.com/file/d/abcDEF123-_/view';
const DOC = 'https://docs.google.com/document/d/docId123/edit';
const SHEET = 'https://docs.google.com/spreadsheets/d/sheetId123/edit';
const SLIDE = 'https://docs.google.com/presentation/d/slideId123/edit';

test('parser accepts allowlisted Drive and Docs URLs and keeps only resourcekey', () => {
  assert.deepEqual(parseDriveLink(`${FILE}?usp=sharing&resourcekey=rk-1`), {
    url: `${FILE}?resourcekey=rk-1`,
    file_id: 'abcDEF123-_',
    kind: 'file',
    resource_key: 'rk-1',
  });
  assert.equal(parseDriveLink(DOC).kind, 'document');
  assert.equal(parseDriveLink(SHEET).kind, 'spreadsheets');
  assert.equal(parseDriveLink(SLIDE).kind, 'presentation');
  assert.equal(
    parseDriveLink('https://drive.google.com/file/d/abcDEF123-_/view?url=https://evil.example').url,
    FILE,
  );
});

test('parser rejects host, userinfo, port, redirect, CRLF, and unallowlisted paths', () => {
  const bad = [
    'http://drive.google.com/file/d/abc/view',
    'https://evil.example/file/d/abc/view',
    'https://drive.google.com.evil.com/file/d/abc/view',
    'https://user:pass@drive.google.com/file/d/abc/view',
    'https://drive.google.com:8443/file/d/abc/view',
    'https://drive.google.com/open?id=abc',
    'https://docs.google.com/document/u/0/',
    'https://drive.google.com/file/d/abc/preview',
    `${FILE}\r\nBcc: other@example.com`,
    'javascript:alert(1)',
  ];
  for (const url of bad) {
    assert.throws(() => parseDriveLink(url), { code: 'INVALID_DRIVE_LINK' });
  }
});

test('unacknowledged or malformed drive_links fail closed and never fetch', () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches += 1;
    return original ? original(...args) : new Response();
  };
  try {
    assert.throws(() => normalizeDriveLinks([{ url: FILE }]), { code: 'INVALID_DRIVE_LINK' });
    assert.throws(() => normalizeDriveLinks([{ url: FILE, access_acknowledged: false }]), { code: 'INVALID_DRIVE_LINK' });
    assert.throws(() => normalizeDriveLinks([{ url: 'https://example.com', access_acknowledged: true }]), { code: 'INVALID_DRIVE_LINK' });
    const links = normalizeDriveLinks([{ url: `${FILE}?utm=1`, label: 'Spec', access_acknowledged: true }]);
    assert.equal(links[0].url, FILE);
    assert.match(renderDriveLinks(links), new RegExp(DRIVE_LINK_WARNING.slice(0, -1)));
    assert.match(renderDriveLinks(links), /- Spec: https:\/\/drive\.google\.com\/file\/d\/abcDEF123-_\/view/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0);
});

test('acknowledged links append the same rendered body used for v2 digest and approval', (t) => {
  const service = fixture(t);
  const input = {
    request_id: 'link-001',
    to: ['test@example.com'],
    subject: 'Self test',
    body_text: 'Synthetic fixture only.',
    drive_links: [{ url: FILE, label: 'Spec', access_acknowledged: true }],
  };
  const { draft } = service.create(1, 'ui', input);
  const links = digestDriveLinks(normalizeDriveLinks(input.drive_links));
  const expectedBody = `${input.body_text}${renderDriveLinks(links)}`;
  assert.equal(draft.digest_version, 2);
  assert.equal(draft.body_text, expectedBody);
  assert.deepEqual(draft.links, links);
  assert.equal(draft.payload_digest, createHash('sha256').update(JSON.stringify({
    version: 2,
    to: ['test@example.com'],
    cc: [],
    subject: 'Self test',
    body_text: expectedBody,
    message_id: null,
    attachments: [],
    links,
  })).digest('hex'));
  assert.equal(service.create(1, 'ui', input).replay, true);
  assert.throws(
    () => service.create(1, 'ui', {
      ...input,
      drive_links: [{ url: DOC, label: 'Other', access_acknowledged: true }],
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const changed = service.create(1, 'ui', {
    ...input,
    request_id: 'link-002',
    drive_links: [{ url: DOC, label: 'Other', access_acknowledged: true }],
  }).draft;
  assert.notEqual(changed.draft_id, draft.draft_id);
  assert.notEqual(changed.payload_digest, draft.payload_digest);
});

test('link-only drafts never count as attachment receipt evidence', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', {
    request_id: 'link-only',
    to: ['test@example.com'],
    subject: 'Link only',
    body_text: 'No files.',
    drive_links: [{ url: FILE, access_acknowledged: true }],
  });
  assert.deepEqual(draft.attachments, []);
  assert.equal(draft.links.length, 1);
  service.approve(1, draft.draft_id, {
    actor: 'session:owner',
    digest: draft.payload_digest,
    allowSend: true,
    hasSendScope: true,
  });
  assert.equal(service.claim(1, draft.draft_id), true);
});
