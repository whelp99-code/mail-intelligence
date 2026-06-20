import assert from 'node:assert/strict';
import {
  buildAttachmentEntry,
  fingerprintAttachment,
  mergeAttachmentsIntoArchive
} from '../src/attachmentSync.mjs';

const hashA = fingerprintAttachment({
  name: 'quote.pdf',
  size: 1200,
  messageId: 'm1',
  attachmentId: 'a1'
});

const entry = buildAttachmentEntry({
  message: {
    id: 'm1',
    subject: '견적 요청',
    from: 'buyer@example.com',
    receivedAt: '2026-06-16T00:00:00.000Z'
  },
  attachment: { id: 'a1', name: 'quote.pdf', size: 1200, contentType: 'application/pdf' },
  contentHash: hashA,
  accountEmail: 'me@company.com'
});

assert.equal(entry.category, 'document');
assert.equal(entry.contentHash, hashA);

const merged = mergeAttachmentsIntoArchive({ version: 1, entries: [entry] }, [entry]);
assert.equal(merged.added, 0);
assert.equal(merged.skippedDuplicates, 0);

const dupEntry = { ...entry, id: 'm1:a2' };
const mergedDup = mergeAttachmentsIntoArchive({ version: 1, entries: [entry] }, [dupEntry]);
assert.equal(mergedDup.added, 0);
assert.equal(mergedDup.skippedDuplicates, 1);

const merged2 = mergeAttachmentsIntoArchive({ version: 1, entries: [] }, [entry]);
assert.equal(merged2.added, 1);
assert.equal(merged2.archive.entries.length, 1);

console.log('verify-attachment-sync: PASS');
