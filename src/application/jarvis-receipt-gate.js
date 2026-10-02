import { createHash, verify } from 'node:crypto';

const DOMAIN = 'orca-jarvis/command-approval/v1\0';
const WINDOW_MS = 30 * 60_000;

export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error('unsupported');
}

export function commandDigest(input) {
  const body = canonicalize({
    schema_version: input.schema_version,
    request_id: input.request_id,
    action: input.action,
    action_level: input.action_level,
    target: input.target,
    args: input.args,
    reversible: input.reversible,
    requested_by: input.requested_by,
    requested_at: input.requested_at,
    expires_at: input.expires_at,
    nonce: input.nonce,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function verifyJarvisReceipt(receipt, publicKeyPem, now, pinnedKeyId) {
  if (!receipt || typeof receipt !== 'object' || receipt.key_id !== pinnedKeyId) return false;
  if (receipt.algorithm !== 'Ed25519' || receipt.decision !== 'approve' || receipt.max_uses !== 1 || receipt.status !== 'issued' || receipt.schema_version !== 1) return false;
  const issued = Date.parse(receipt.issued_at);
  const notBefore = Date.parse(receipt.not_before);
  const expires = Date.parse(receipt.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(notBefore) || !Number.isFinite(expires)) return false;
  if (issued > now || notBefore > now || expires <= now || expires - issued > WINDOW_MS) return false;
  const payload = { ...receipt };
  delete payload.signature;
  try {
    return verify(null, Buffer.from(DOMAIN + canonicalize(payload)), publicKeyPem, Buffer.from(String(receipt.signature), 'base64url'));
  } catch {
    return false;
  }
}

export function matchingMailItem(command, draft) {
  const items = command?.args?.items;
  if (!Array.isArray(items)) return undefined;
  return items.find((item) => item
    && item.action_kind === 'mail.send'
    && item.mail_draft_id === draft.draft_id
    && item.payload_digest === draft.payload_digest);
}

export function ensureReceiptUseTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS jarvis_receipt_uses (
    receipt_id TEXT NOT NULL,
    item_digest TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (receipt_id, item_digest)
  )`);
}

export function consumeReceiptItem(db, receiptId, itemDigest, draftId, now) {
  ensureReceiptUseTable(db);
  const prior = db.prepare('SELECT draft_id FROM jarvis_receipt_uses WHERE receipt_id=? AND item_digest=?').get(receiptId, itemDigest);
  if (prior) {
    const error = new Error('RECEIPT_ALREADY_USED');
    error.statusCode = 409;
    error.code = 'RECEIPT_ALREADY_USED';
    throw error;
  }
  db.prepare('INSERT INTO jarvis_receipt_uses(receipt_id, item_digest, draft_id, used_at) VALUES(?,?,?,?)')
    .run(receiptId, itemDigest, draftId, new Date(now).toISOString());
}
