/**
 * Mail company-memory donor publisher.
 *
 * Emits keys-only outbox rows from authenticated Mail source records and maps
 * them into a signed `sb-company` receive envelope. Acknowledgement
 * (PENDING → EMITTED) happens only after exit 0 and a matching workspace /
 * request-digest / operation / candidate / state receipt.
 *
 * Signing material is operator-injected. This module does not invent a shared
 * key with Second Brain or CRM. Live Mail ingest is not bound here. A send
 * draft that reaches status `sent` enqueues one keys-only INBOX_RECEIVED row
 * keyed by draft_id.
 */
import { createHash } from 'node:crypto';

const AUTHORITY_DOMAIN = Buffer.from('second-brain/company-memory-authority/v1\0');
const REQUEST_DOMAIN = Buffer.from('second-brain/company-memory-request/v1\0');
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OUTBOX_KINDS = new Set(['INBOX_RECEIVED', 'WORK_LINKED', 'WORK_LINK_CORRECTED']);

export const MAIL_COMPANY_MEMORY_ADAPTER_STATUS = 'outbox_ready';

export class CompanyMemoryDonorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompanyMemoryDonorError';
    this.code = code;
  }
}

export function canonicalCompanyMemoryBytes(value) {
  const text = JSON.stringify(canonicalize(value));
  if ([...text].some((character) => character.charCodeAt(0) < 32 && character !== '\t' && character !== '\n' && character !== '\r')) {
    throw new CompanyMemoryDonorError('NON_CANONICAL_CONTROL', 'canonical json contains control characters');
  }
  if (text.normalize('NFC') !== text) {
    throw new CompanyMemoryDonorError('NON_CANONICAL_NFC', 'canonical json is not NFC');
  }
  return Buffer.from(text, 'utf8');
}

export function createMailProductDonorPort(options) {
  if (!options?.db) {
    throw new CompanyMemoryDonorError(
      'MAIL_ADAPTER_NOT_IMPLEMENTED',
      'Mail company-memory donor adapter requires a Mail database; CRM cannot invent this port',
    );
  }
  const resolveSource = typeof options.resolveSource === 'function' ? options.resolveSource : () => null;
  return {
    listPending() {
      return options.db.prepare(
        `SELECT * FROM mail_company_memory_outbox
         WHERE status = 'PENDING'
         ORDER BY created_at ASC, id ASC`,
      ).all().map((row) => {
        const event = mapOutboxRow(row);
        return { event, source: resolveSource(event) };
      });
    },
    markEmitted(workspaceId, id) {
      markMailCompanyMemoryEmitted(options.db, workspaceId, id);
    },
  };
}

export function mailSentDraftSourceLocator(draftId) {
  return `mail-send-draft:${requiredText(draftId, 'draft_id')}`;
}

export function enqueueSentDraftCompanyMemoryOutbox(db, input, now) {
  if (!db) {
    throw new CompanyMemoryDonorError(
      'MAIL_ADAPTER_NOT_IMPLEMENTED',
      'Mail company-memory outbox requires a Mail database',
    );
  }
  assertMailCompanyMemoryOutbox(db);
  const draftId = requiredText(input?.draftId ?? input?.draft?.draft_id, 'draft_id');
  const draft = sameDraft(input?.draft, draftId) ? input.draft : loadSendDraft(db, draftId);
  if (!draft) {
    throw new CompanyMemoryDonorError('DRAFT_NOT_FOUND', 'send draft not found');
  }
  if (String(draft.status || '').normalize('NFC').trim() !== 'sent') {
    throw new CompanyMemoryDonorError('DRAFT_NOT_SENT', 'send draft is not sent');
  }
  requiredText(draft.graph_message_id, 'graph_message_id');
  return enqueueMailCompanyMemoryOutbox(db, {
    workspaceId: input?.workspaceId,
    kind: 'INBOX_RECEIVED',
    provider: input?.provider || 'outlook',
    mailbox: resolveDraftMailbox(db, draft, input?.mailbox),
    sourceLocator: mailSentDraftSourceLocator(draftId),
    sourceEventId: draftId,
  }, now);
}

export function enqueueMailCompanyMemoryOutbox(db, input, now) {
  if (!db) {
    throw new CompanyMemoryDonorError('MAIL_ADAPTER_NOT_IMPLEMENTED', 'Mail company-memory outbox requires a Mail database');
  }
  const workspaceId = canonicalWorkspaceId(input?.workspaceId);
  const kind = requiredText(input?.kind, 'kind');
  if (!OUTBOX_KINDS.has(kind)) {
    throw new CompanyMemoryDonorError('INVALID_INPUT', 'kind is not a CRM-consumable mail outbox event');
  }
  const provider = requiredText(input.provider, 'provider');
  const mailbox = requiredText(input.mailbox, 'mailbox');
  const sourceLocator = requiredText(input.sourceLocator, 'source_locator');
  const sourceEventId = requiredText(input.sourceEventId, 'source_event_id');
  const createdAt = requiredText(now || '', 'created_at');
  const id = outboxId({ workspaceId, kind, provider, mailbox, sourceLocator, sourceEventId });
  const workItemId = optionalText(input.workItemId);
  const linkId = optionalText(input.linkId);
  db.prepare(
    `INSERT INTO mail_company_memory_outbox
      (id, workspace_id, kind, provider, mailbox, source_locator, source_event_id, work_item_id, link_id, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?)
     ON CONFLICT(workspace_id, kind, provider, mailbox, source_locator, source_event_id) DO NOTHING`,
  ).run(id, workspaceId, kind, provider, mailbox, sourceLocator, sourceEventId, workItemId, linkId, createdAt, createdAt);
  const row = db.prepare(
    `SELECT * FROM mail_company_memory_outbox
     WHERE workspace_id = ? AND kind = ? AND provider = ? AND mailbox = ? AND source_locator = ? AND source_event_id = ?`,
  ).get(workspaceId, kind, provider, mailbox, sourceLocator, sourceEventId);
  return mapOutboxRow(row);
}

export async function publishCompanyMemoryDonor(input) {
  const context = validatedContext(input.context);
  const signer = validatedSigner(input.signer);
  const issuedAt = formatInstant(input.now);
  const expiresAt = formatInstant(new Date(input.now.getTime() + 60_000));
  const pendingRows = input.outbox.listPending();
  const emitted = [];
  const pending = [];
  const rejected = [];

  for (const row of pendingRows) {
    const outcome = await publishOne({
      context,
      signer,
      transport: input.transport,
      outbox: input.outbox,
      row,
      issuedAt,
      expiresAt,
    });
    if (outcome.status === 'emitted') {
      emitted.push(row.event.id);
    } else {
      pending.push(row.event.id);
      rejected.push({ id: row.event.id, code: outcome.code });
    }
  }

  return { attempted: pendingRows.length, emitted, pending, rejected };
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CompanyMemoryDonorError('NON_CANONICAL_JSON', 'non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const record = value;
    const result = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  throw new CompanyMemoryDonorError('NON_CANONICAL_JSON', 'unsupported json value');
}

function canonicalWorkspaceId(value) {
  const normalized = String(value ?? '').normalize('NFC').trim();
  if (!CANONICAL_UUID.test(normalized)) {
    throw new CompanyMemoryDonorError('COMPANY_WORKSPACE_REQUIRED', 'workspace_id must be a canonical UUID');
  }
  return normalized;
}

function closedId(value, field) {
  const normalized = String(value ?? '').normalize('NFC').trim();
  if (!CLOSED_ID.test(normalized)) {
    throw new CompanyMemoryDonorError('COMPANY_AUTHORITY_REQUIRED', `${field} is not a closed identifier`);
  }
  return normalized;
}

function requiredText(value, field) {
  const normalized = String(value ?? '').normalize('NFC').trim();
  if (!normalized) {
    throw new CompanyMemoryDonorError('INVALID_INPUT', `${field} is required`);
  }
  return normalized;
}

function optionalText(value) {
  if (value == null) return null;
  const normalized = String(value).normalize('NFC').trim();
  return normalized || null;
}

function sameDraft(draft, draftId) {
  if (!draft || typeof draft !== 'object') return false;
  return String(draft.draft_id || '').normalize('NFC').trim() === draftId;
}

function loadSendDraft(db, draftId) {
  try {
    return db.prepare('SELECT * FROM mail_send_drafts WHERE draft_id = ?').get(draftId) || null;
  } catch {
    throw new CompanyMemoryDonorError('DRAFT_NOT_FOUND', 'send draft not found');
  }
}

function resolveDraftMailbox(db, draft, fallback) {
  const provided = optionalText(fallback);
  if (provided) return provided;
  let row;
  try {
    row = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(draft.mailbox_id);
  } catch {
    row = null;
  }
  return requiredText(
    optionalText(row?.address) || optionalText(row?.graph_user) || optionalText(row?.mailbox_key),
    'mailbox',
  );
}

function assertMailCompanyMemoryOutbox(db) {
  let row;
  try {
    row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_company_memory_outbox'",
    ).get();
  } catch {
    throw new CompanyMemoryDonorError('COMPANY_MEMORY_OUTBOX_UNAVAILABLE', 'mail company-memory outbox schema is unavailable');
  }
  if (!row || typeof row.name !== 'string' || !row.name.trim()) {
    throw new CompanyMemoryDonorError('COMPANY_MEMORY_OUTBOX_UNAVAILABLE', 'mail company-memory outbox schema is unavailable');
  }
}

function formatInstant(value) {
  const iso = value.toISOString();
  if (iso.length !== 24 || !iso.endsWith('Z') || !Number.isFinite(value.getTime())) {
    throw new CompanyMemoryDonorError('INSTANT_INVALID', 'now must be a UTC millisecond instant');
  }
  return iso;
}

function validatedContext(context) {
  const workspaceId = canonicalWorkspaceId(context.workspaceId);
  if (!Number.isSafeInteger(context.deletionSequence) || context.deletionSequence < 0) {
    throw new CompanyMemoryDonorError('COMPANY_AUTHORITY_REQUIRED', 'deletion_sequence must be a non-negative integer');
  }
  if (!DIGEST.test(context.deletionSetRoot)) {
    throw new CompanyMemoryDonorError('COMPANY_AUTHORITY_REQUIRED', 'deletion_set_root must be a sha256 digest');
  }
  return {
    providerInstanceId: closedId(context.providerInstanceId, 'provider_instance_id'),
    workspaceId,
    principalId: requiredText(context.principalId, 'principal_id'),
    agentId: closedId(context.agentId, 'agent_id'),
    sessionId: closedId(context.sessionId, 'session_id'),
    projects: context.projects.map((project, index) => requiredText(project, `projects[${index}]`)),
    policyRevision: closedId(context.policyRevision, 'policy_revision'),
    deletionSequence: context.deletionSequence,
    deletionSetRoot: context.deletionSetRoot,
  };
}

function validatedSigner(signer) {
  closedId(signer.keyId, 'signing_key_id');
  return signer;
}

function workspaceDecision(contextWorkspaceId, eventWorkspaceId, sourceWorkspaceId) {
  try {
    const eventWorkspace = canonicalWorkspaceId(eventWorkspaceId);
    if (eventWorkspace !== contextWorkspaceId) return { ok: false, code: 'COMPANY_WORKSPACE_MISMATCH' };
    if (sourceWorkspaceId === undefined) return { ok: true };
    const sourceWorkspace = canonicalWorkspaceId(sourceWorkspaceId);
    if (sourceWorkspace !== contextWorkspaceId) return { ok: false, code: 'COMPANY_WORKSPACE_MISMATCH' };
    return { ok: true };
  } catch (error) {
    if (error instanceof CompanyMemoryDonorError && error.code === 'COMPANY_WORKSPACE_REQUIRED') {
      return { ok: false, code: 'COMPANY_WORKSPACE_REQUIRED' };
    }
    throw error;
  }
}

function candidateId(source) {
  return `mail:v1:${source.workspaceId}:${source.provider}:${source.mailbox}:${source.sourceLocator}:${source.sourceEventId}`;
}

function receiveArguments(source) {
  const locator = {};
  for (const [key, value] of Object.entries(source.locator || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      locator[requiredText(key, 'locator.key')] = value;
      continue;
    }
    if (typeof value !== 'string') {
      throw new CompanyMemoryDonorError('INVALID_INPUT', 'locator values must be strings or finite numbers');
    }
    locator[requiredText(key, 'locator.key')] = requiredText(value, 'locator.value');
  }
  return {
    candidate_id: candidateId(source),
    source_system: 'mail',
    source_locator: requiredText(source.sourceLocator, 'source_locator'),
    source_event_id: requiredText(source.sourceEventId, 'source_event_id'),
    content: requiredText(source.content, 'content'),
    parser_version: requiredText(source.parserVersion, 'parser_version'),
    locator,
  };
}

function requestDigest(operation, argumentsValue) {
  const digest = createHash('sha256')
    .update(REQUEST_DOMAIN)
    .update(canonicalCompanyMemoryBytes({ arguments: argumentsValue, operation }))
    .digest('hex');
  return `sha256:${digest}`;
}

function nonceFor(eventId) {
  const cleaned = String(eventId).normalize('NFC').replace(/[^A-Za-z0-9._:-]/g, ':');
  const nonce = `mail:${cleaned}`;
  if (CLOSED_ID.test(nonce) && nonce.length <= 128) return nonce;
  return `mail:${createHash('sha256').update(eventId).digest('hex')}`;
}

function outboxId(input) {
  const digest = createHash('sha256')
    .update([input.workspaceId, input.kind, input.provider, input.mailbox, input.sourceLocator, input.sourceEventId].join('\0'))
    .digest('hex');
  return `mail:v1:${digest}`;
}

function mapOutboxRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    provider: row.provider,
    mailbox: row.mailbox,
    sourceLocator: row.source_locator,
    sourceEventId: row.source_event_id,
    workItemId: row.work_item_id,
    linkId: row.link_id,
    status: row.status,
    createdAt: row.created_at,
    version: row.version,
  };
}

function markMailCompanyMemoryEmitted(db, workspaceId, id) {
  const workspace = canonicalWorkspaceId(workspaceId);
  const item = db.prepare('SELECT * FROM mail_company_memory_outbox WHERE id = ?').get(requiredText(id, 'outbox.id'));
  if (!item) {
    throw new CompanyMemoryDonorError('OUTBOX_NOT_FOUND', 'mail company-memory outbox event not found');
  }
  if (canonicalWorkspaceId(item.workspace_id) !== workspace) {
    throw new CompanyMemoryDonorError('COMPANY_WORKSPACE_MISMATCH', 'outbox workspace does not match');
  }
  if (item.status === 'EMITTED') return mapOutboxRow(item);
  db.prepare(
    `UPDATE mail_company_memory_outbox
     SET status = 'EMITTED', version = version + 1, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'PENDING'`,
  ).run(new Date().toISOString(), item.id, workspace);
  const next = db.prepare('SELECT * FROM mail_company_memory_outbox WHERE id = ?').get(item.id);
  return mapOutboxRow(next);
}

function signedRequest(input) {
  const argumentsValue = input.argumentsValue;
  const digest = requestDigest('receive', argumentsValue);
  const candidate = argumentsValue.candidate_id;
  if (typeof candidate !== 'string') {
    throw new CompanyMemoryDonorError('INVALID_INPUT', 'candidate_id is required');
  }
  const unsigned = {
    schema_version: 1,
    provider_instance_id: input.context.providerInstanceId,
    workspace_id: input.context.workspaceId,
    principal_id: input.context.principalId,
    agent_id: input.context.agentId,
    session_id: input.context.sessionId,
    projects: [...input.context.projects],
    policy_revision: input.context.policyRevision,
    purpose: 'company_memory_receive',
    operation: 'receive',
    request_digest: digest,
    deletion_sequence: input.context.deletionSequence,
    deletion_set_root: input.context.deletionSetRoot,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    nonce: nonceFor(input.eventId),
    signing_key_id: input.signer.keyId,
  };
  const signature = input.signer.sign(Buffer.concat([AUTHORITY_DOMAIN, canonicalCompanyMemoryBytes(unsigned)]));
  if (signature.byteLength !== 64) {
    throw new CompanyMemoryDonorError('COMPANY_AUTHORITY_REQUIRED', 'Ed25519 signature must be 64 bytes');
  }
  const encoded = Buffer.from(signature).toString('base64url');
  if (encoded.includes('=')) {
    throw new CompanyMemoryDonorError('COMPANY_AUTHORITY_REQUIRED', 'signature must be unpadded base64url');
  }
  const request = canonicalCompanyMemoryBytes({
    arguments: argumentsValue,
    authority: { ...unsigned, signature: encoded },
  });
  return { request, digest, candidateId: candidate };
}

function parseReceipt(stdout) {
  try {
    const parsed = JSON.parse(Buffer.from(stdout).toString('utf8').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const receipt = parsed.receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function receiptMatches(receipt, expected) {
  const result = receipt.result;
  const state = result && typeof result === 'object' && !Array.isArray(result) ? result.state : undefined;
  return (
    receipt.workspace_id === expected.workspaceId
    && receipt.request_digest === expected.requestDigest
    && receipt.operation === expected.operation
    && receipt.candidate_id === expected.candidateId
    && state === expected.state
  );
}

async function publishOne(input) {
  const event = input.row.event;
  if (event.status === 'EMITTED') return { status: 'emitted' };

  const workspace = workspaceDecision(input.context.workspaceId, event.workspaceId, input.row.source?.workspaceId);
  if (!workspace.ok) return { status: 'pending', code: workspace.code };
  if (!input.row.source) return { status: 'pending', code: 'COMPANY_SOURCE_REQUIRED' };

  let request;
  let digest;
  let candidate;
  try {
    const built = signedRequest({
      context: input.context,
      signer: input.signer,
      argumentsValue: receiveArguments(input.row.source),
      eventId: event.id,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    request = built.request;
    digest = built.digest;
    candidate = built.candidateId;
  } catch (error) {
    const code = error instanceof CompanyMemoryDonorError ? error.code : 'COMPANY_REQUEST_INVALID';
    return { status: 'pending', code };
  }

  let result;
  try {
    result = await input.transport.invoke(request);
  } catch {
    return { status: 'pending', code: 'COMPANY_TRANSPORT_FAILED' };
  }
  if (result.exitCode !== 0) return { status: 'pending', code: 'COMPANY_RECEIPT_REQUIRED' };

  const receipt = parseReceipt(result.stdout);
  if (
    !receipt
    || !receiptMatches(receipt, {
      workspaceId: input.context.workspaceId,
      requestDigest: digest,
      operation: 'receive',
      candidateId: candidate,
      state: 'candidate',
    })
  ) {
    return { status: 'pending', code: 'COMPANY_RECEIPT_MISMATCH' };
  }

  input.outbox.markEmitted(event.workspaceId, event.id);
  return { status: 'emitted' };
}
