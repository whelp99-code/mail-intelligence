import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AttachmentAccessError,
  attachmentIsAllowed,
  findMessageAttachment,
  publicAttachmentMetadata,
  resolveAttachmentBytes,
  saveOperatorDownload,
} from '../src/application/attachment-access.js';

test('only allowlisted attachment types can be downloaded', () => {
  assert.equal(attachmentIsAllowed({ name: 'quote.pdf', contentType: 'application/pdf', size: 100 }), true);
  assert.equal(attachmentIsAllowed({ name: 'payload.exe', contentType: 'application/octet-stream', size: 100 }), false);
  assert.equal(attachmentIsAllowed({ name: 'huge.pdf', contentType: 'application/pdf', size: 20 * 1024 * 1024 }), false);
});

test('cached contentBytes are preferred over Graph and can be saved under a controlled path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-attach-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attachment = {
    graphAttachmentId: 'att-1',
    name: '견적서.pdf',
    contentType: 'application/pdf',
    size: 12,
    source: { contentBytes: Buffer.from('%PDF-fixture').toString('base64') },
  };
  const bytes = await resolveAttachmentBytes({
    attachment,
    downloadFromGraph: async () => {
      throw new Error('Graph should not be called for cached bytes');
    },
  });
  assert.equal(bytes.toString(), '%PDF-fixture');
  const saved = await saveOperatorDownload({
    directory,
    messageId: 'msg-1',
    attachment,
    bytes,
  });
  assert.match(saved.relativePath, /^operator-downloads\//);
  const written = await readFile(join(directory, saved.relativePath.replace('operator-downloads/', '')));
  assert.equal(written.toString(), '%PDF-fixture');
  assert.equal(findMessageAttachment([attachment], 'att-1'), attachment);
  assert.equal(publicAttachmentMetadata(attachment).downloadAllowed, true);
});

test('missing or disallowed attachments fail closed', async () => {
  await assert.rejects(
    () => resolveAttachmentBytes({ attachment: null }),
    (error) => error instanceof AttachmentAccessError && error.code === 'ATTACHMENT_NOT_FOUND',
  );
  await assert.rejects(
    () => resolveAttachmentBytes({
      attachment: { name: 'tool.exe', contentType: 'application/x-msdownload', size: 10 },
    }),
    (error) => error instanceof AttachmentAccessError && error.code === 'ATTACHMENT_TYPE_NOT_ALLOWED',
  );
});
