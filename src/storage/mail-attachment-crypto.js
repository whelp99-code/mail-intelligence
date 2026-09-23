import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENCRYPTION_AAD_VERSION = 'aad-v1';
export const ENCRYPTION_POLICY_VERSION = 'policy-v1';
export const ATTACHMENT_KEY_VERSION = 'k1';

function fail(code, statusCode = 503) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function requiredBuffer(value, label, length) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (length && buffer.length !== length) fail('ATTACHMENT_CRYPTO_INVALID', 500);
  if (!buffer.length) fail('ATTACHMENT_CRYPTO_INVALID', 500);
  return buffer;
}

export function buildAttachmentAad({
  assetId,
  mailboxId,
  encryptionAadVersion = ENCRYPTION_AAD_VERSION,
  encryptionPolicyVersion = ENCRYPTION_POLICY_VERSION,
}) {
  return Buffer.from(`${assetId}|${mailboxId}|${encryptionAadVersion}|${encryptionPolicyVersion}`, 'utf8');
}

export function encryptAttachment(plaintext, {
  key,
  assetId,
  mailboxId,
  encryptionAadVersion = ENCRYPTION_AAD_VERSION,
  encryptionPolicyVersion = ENCRYPTION_POLICY_VERSION,
  keyVersion = ATTACHMENT_KEY_VERSION,
} = {}) {
  const secret = requiredBuffer(key, 'key', 32);
  const bytes = requiredBuffer(plaintext);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, nonce);
  cipher.setAAD(buildAttachmentAad({
    assetId,
    mailboxId,
    encryptionAadVersion,
    encryptionPolicyVersion,
  }));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion,
    encryptionAadVersion,
    encryptionPolicyVersion,
  };
}

export function decryptAttachment({
  ciphertext,
  nonce,
  authTag,
  key,
  assetId,
  mailboxId,
  encryptionAadVersion = ENCRYPTION_AAD_VERSION,
  encryptionPolicyVersion = ENCRYPTION_POLICY_VERSION,
} = {}) {
  const secret = requiredBuffer(key, 'key', 32);
  const decipher = createDecipheriv('aes-256-gcm', secret, requiredBuffer(nonce, 'nonce', 12));
  decipher.setAAD(buildAttachmentAad({
    assetId,
    mailboxId,
    encryptionAadVersion,
    encryptionPolicyVersion,
  }));
  decipher.setAuthTag(requiredBuffer(authTag, 'authTag', 16));
  return Buffer.concat([decipher.update(requiredBuffer(ciphertext)), decipher.final()]);
}

export function parseAttachmentKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;
  const utf8 = Buffer.from(raw, 'utf8');
  return utf8.length === 32 ? utf8 : null;
}
