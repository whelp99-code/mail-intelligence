import { createHash, verify } from 'node:crypto';
import { AttachmentPipeline } from '../application/attachment-pipeline.js';
import { canonicalCompanyMemoryBytes } from '../application/company-memory-donor.js';
import { mailSourceDigest } from './cwos-mail-command.js';

export const PRICE_ATTACHMENT_APPROVAL_DOMAIN = Buffer.from('mail-intelligence/price-upload-approval/v1\0');

function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { code, statusCode });
}

/** Explicit binding only. The caller supplies native Price session and scoped approval. */
export class PriceAttachmentUploader {
  constructor({ intake, companyId, origin, csrfToken, approvalKey, readBytes, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['http:', 'https:'].includes(url.protocol)) fail('PRICE_BINDING_INVALID');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('PRICE_BINDING_INVALID');
    if (!/^[A-Za-z0-9_-]+$/.test(companyId) || typeof csrfToken !== 'string' || !csrfToken
      || approvalKey?.asymmetricKeyType !== 'ed25519' || typeof readBytes !== 'function') fail('PRICE_BINDING_INVALID');
    this.intake = intake;
    this.companyId = companyId;
    this.origin = url.origin;
    this.csrfToken = csrfToken;
    this.approvalKey = approvalKey;
    this.readBytes = readBytes;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pipeline = new AttachmentPipeline({ db: intake.store.db });
  }

  proposal(mailboxUser, messageId, attachmentId) {
    const { source, mailbox } = this.intake.source(mailboxUser, messageId);
    const attachment = this.intake.store.getAttachmentsForMessage(mailbox.id, messageId)
      .find(item => item.graphAttachmentId === attachmentId);
    if (!attachment || !source.revision || !attachment.lastModifiedAt) fail('PRICE_SOURCE_REVISION_REQUIRED');
    if (!this.pipeline.canExpose(attachment.databaseId, mailbox.id)) fail('ATTACHMENT_SCAN_REQUIRED');
    const processing = this.pipeline.status(attachment.databaseId, mailbox.id);
    return {
      schemaVersion: 1, purpose: 'price.source.upload', companyId: this.companyId, mailboxUser,
      messageId, sourceRevision: source.revision, sourceDigest: mailSourceDigest(source),
      attachmentId, attachmentRevision: attachment.lastModifiedAt,
      filename: attachment.name, sizeBytes: attachment.size, contentDigest: processing.sha256,
    };
  }

  authorize(proposal, approval) {
    if (!approval?.claim || typeof approval.signature !== 'string') fail('PRICE_APPROVAL_REQUIRED');
    const claim = approval.claim;
    if (Object.keys(claim).length !== Object.keys(proposal).length + 3
      || Object.entries(proposal).some(([key, value]) => claim[key] !== value)
      || typeof claim.approvedBy !== 'string' || !claim.approvedBy
      || typeof claim.nonce !== 'string' || !claim.nonce) fail('PRICE_APPROVAL_SCOPE_MISMATCH');
    if (!Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= this.now()) fail('PRICE_APPROVAL_EXPIRED');
    if (!verify(null, Buffer.concat([PRICE_ATTACHMENT_APPROVAL_DOMAIN, canonicalCompanyMemoryBytes(claim)]),
      this.approvalKey, Buffer.from(approval.signature, 'base64url'))) fail('PRICE_APPROVAL_SIGNATURE_INVALID');
  }

  async upload({ mailboxUser, messageId, attachmentId, approval }) {
    const proposal = this.proposal(mailboxUser, messageId, attachmentId);
    this.authorize(proposal, approval);
    const bytes = Buffer.from(await this.readBytes({ mailboxUser, messageId, attachmentId }));
    const current = () => {
      if (JSON.stringify(this.proposal(mailboxUser, messageId, attachmentId)) !== JSON.stringify(proposal)) {
        fail('PRICE_ATTACHMENT_STALE', 409);
      }
      this.authorize(proposal, approval);
    };
    current();
    if (bytes.length !== proposal.sizeBytes
      || createHash('sha256').update(bytes).digest('hex') !== proposal.contentDigest) fail('PRICE_ATTACHMENT_BYTES_CHANGED', 409);
    const prefix = `/api/companies/${this.companyId}`;
    const idempotencyKey = `mail-price-${createHash('sha256').update(canonicalCompanyMemoryBytes(proposal)).digest('hex')}`;
    const manifest = {
      idempotency_key: idempotencyKey,
      files: [{ client_file_id: 'source', filename: proposal.filename, size_bytes: bytes.length, sha256: proposal.contentDigest }],
    };
    const batch = await this.request('POST', `${prefix}/uploads`, manifest, current);
    if (!/^[A-Za-z0-9_-]+$/.test(batch.id)
      || !batch.files || batch.files.length !== 1 || batch.files[0].sha256 !== proposal.contentDigest
      || batch.files[0].size_bytes !== proposal.sizeBytes || batch.files[0].filename !== proposal.filename) {
      fail('PRICE_UPLOAD_RECEIPT_MISMATCH', 502);
    }
    if (batch.state !== 'SEALED') {
      for (let offset = 0, index = 0; offset < bytes.length; offset += 1_000_000, index++) {
        const chunk = bytes.subarray(offset, offset + 1_000_000);
        await this.request('PUT', `${prefix}/uploads/${batch.id}/files/source/chunks/${index}`, chunk, current);
      }
    }
    const completed = await this.request('POST', `${prefix}/uploads/${batch.id}/complete`, { expected_revision: batch.revision }, current);
    const documentId = completed.files?.[0]?.document?.id;
    if (!/^[A-Za-z0-9_-]+$/.test(documentId) || completed.state !== 'SEALED') fail('PRICE_UPLOAD_RECEIPT_MISMATCH', 502);
    const document = await this.request('GET', `${prefix}/documents/${documentId}`, null, current);
    if (document.sha256 !== proposal.contentDigest || document.size_bytes !== proposal.sizeBytes
      || document.company_id !== this.companyId || document.accounting_complete !== false) fail('PRICE_UPLOAD_RECEIPT_MISMATCH', 502);
    return {
      authorityLevel: 'SOURCE_UPLOAD_ONLY', companyId: this.companyId, proposal,
      source: this.intake.source(mailboxUser, messageId).source,
      idempotencyKey, batchId: batch.id, batchRevision: completed.revision,
      documentId, blobId: document.blob_id, sha256: document.sha256,
      accountingComplete: false,
    };
  }

  async request(method, path, payload, assertCurrent) {
    assertCurrent();
    const binary = Buffer.isBuffer(payload);
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: {
        'x-csrf-token': this.csrfToken,
        'content-type': binary ? 'application/octet-stream' : 'application/json',
        ...(binary ? { 'x-chunk-sha256': createHash('sha256').update(payload).digest('hex') } : {}),
      },
      ...(payload ? { body: binary ? payload : JSON.stringify(payload) } : {}),
    });
    if (response.status >= 300 && response.status < 400
      || response.url && new URL(response.url).origin !== this.origin) fail('PRICE_CREDENTIAL_REDIRECT', 502);
    const data = await response.json();
    if (![200, 201].includes(response.status)) fail(data.code || 'PRICE_UPLOAD_FAILED', response.status);
    return data;
  }
}
