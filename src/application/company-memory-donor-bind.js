/**
 * Env-gated server bind for the Mail company-memory donor tick.
 *
 * Absent COMPANY_MEMORY_* → disabled. Incomplete, unknown, or unreadable
 * command/key files → fail closed. Personal `sb` is rejected. A Mail sqlite
 * db binds `mail_company_memory_outbox` and fails closed if that schema is
 * missing. Empty outbox is used only when no db. This module does not write
 * personal memory, talk to the loopback API, or invent a shared signing key.
 */
import { spawn } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  createMailProductDonorPort,
  mailSentDraftSourceLocator,
  publishCompanyMemoryDonor,
} from './company-memory-donor.js';

const REQUIRED_ENV = [
  'COMPANY_MEMORY_SB_COMPANY',
  'COMPANY_MEMORY_SB_COMPANY_CONFIG',
  'COMPANY_MEMORY_SIGNING_KEY_FILE',
  'COMPANY_MEMORY_AUTHORITY_FILE',
];

const REQUIRED_SET = new Set(REQUIRED_ENV);

export function loadCompanyMemoryDonorBind(env) {
  const companyKeys = Object.keys(env).filter((key) => key.startsWith('COMPANY_MEMORY_'));
  if (companyKeys.length === 0) {
    return { enabled: false };
  }

  const unknown = companyKeys.filter((key) => !REQUIRED_SET.has(key));
  const command = readRequired(env, 'COMPANY_MEMORY_SB_COMPANY');
  const configPath = readRequired(env, 'COMPANY_MEMORY_SB_COMPANY_CONFIG');
  const signingKeyFile = readRequired(env, 'COMPANY_MEMORY_SIGNING_KEY_FILE');
  const authorityFile = readRequired(env, 'COMPANY_MEMORY_AUTHORITY_FILE');

  if (unknown.length > 0 || !command || !configPath || !signingKeyFile || !authorityFile) {
    throw incomplete('donor env is incomplete or unknown');
  }

  if (
    !isAbsolute(command)
    || !isAbsolute(configPath)
    || !isAbsolute(signingKeyFile)
    || !isAbsolute(authorityFile)
    || !existsSync(command)
    || !existsSync(configPath)
    || !existsSync(signingKeyFile)
    || !existsSync(authorityFile)
  ) {
    throw incomplete('donor command or key files are missing');
  }

  if (basename(command) !== 'sb-company') {
    throw new Error('COMPANY_MEMORY_COMMAND_INVALID: command must be an absolute sb-company path');
  }

  const authority = loadAuthority(authorityFile);
  loadSigner(signingKeyFile, authority.keyId);

  return {
    enabled: true,
    command,
    configPath,
    signingKeyFile,
    authorityFile,
    workspaceId: authority.context.workspaceId,
  };
}

export async function runBoundCompanyMemoryDonorTick(env, options = {}) {
  const bind = loadCompanyMemoryDonorBind(env);
  if (!bind.enabled) {
    return { skipped: true };
  }

  const authority = loadAuthority(bind.authorityFile);
  const signer = loadSigner(bind.signingKeyFile, authority.keyId);
  const transport = createSbCompanyTransport(bind.command, bind.configPath);
  const outbox = options.outbox ?? resolveMailOutbox(options.db);
  const now = options.now ?? new Date();
  const result = await publishCompanyMemoryDonor({
    context: authority.context,
    signer,
    transport,
    outbox,
    now,
  });
  return { skipped: false, result };
}

export function resolveMailCompanyMemorySource(db, event) {
  if (!db || !event) return null;
  const locator = String(event.sourceLocator || '').normalize('NFC').trim();
  const sourceEventId = String(event.sourceEventId || '').normalize('NFC').trim();
  const mailbox = String(event.mailbox || '').normalize('NFC').trim();
  const provider = String(event.provider || '').normalize('NFC').trim();
  const workspaceId = String(event.workspaceId || '').normalize('NFC').trim();
  if (!locator || !sourceEventId || !mailbox || !provider || !workspaceId) return null;
  const fromMessage = resolveMessageCompanyMemorySource(db, {
    locator, sourceEventId, mailbox, provider, workspaceId, kind: event.kind,
  });
  if (fromMessage) return fromMessage;
  return resolveSentDraftCompanyMemorySource(db, {
    locator, sourceEventId, mailbox, provider, workspaceId,
  });
}

function resolveMessageCompanyMemorySource(db, input) {
  let row;
  try {
    row = db.prepare(
      `SELECT m.graph_id, m.body_text, m.body_preview
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       WHERE m.deleted_at IS NULL
         AND (m.graph_id = ? OR m.graph_id = ? OR m.internet_message_id = ?)
         AND (mb.address = ? OR mb.graph_user = ? OR mb.mailbox_key = ?)
       LIMIT 1`,
    ).get(input.locator, input.sourceEventId, input.sourceEventId, input.mailbox, input.mailbox, input.mailbox);
  } catch {
    return null;
  }
  if (!row) return null;
  const content = String(row.body_text || row.body_preview || '').normalize('NFC').trim();
  if (!content) return null;
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    mailbox: input.mailbox,
    sourceLocator: input.locator,
    sourceEventId: input.sourceEventId,
    content,
    parserVersion: 'mail:company-memory:1',
    locator: {
      kind: input.kind === 'INBOX_RECEIVED' ? 'mail_message' : 'mail_work',
      graph_id: row.graph_id,
    },
  };
}

function resolveSentDraftCompanyMemorySource(db, input) {
  if (input.locator !== mailSentDraftSourceLocator(input.sourceEventId)) return null;
  let row;
  try {
    row = db.prepare(
      `SELECT d.draft_id, d.graph_message_id, d.sent_at
       FROM mail_send_drafts d
       JOIN mailboxes mb ON mb.id = d.mailbox_id
       WHERE d.draft_id = ?
         AND d.status = 'sent'
         AND (mb.address = ? OR mb.graph_user = ? OR mb.mailbox_key = ?)
       LIMIT 1`,
    ).get(input.sourceEventId, input.mailbox, input.mailbox, input.mailbox);
  } catch {
    return null;
  }
  if (!row) return null;
  const draftId = String(row.draft_id || '').normalize('NFC').trim();
  const graphId = String(row.graph_message_id || '').normalize('NFC').trim();
  const sentAt = String(row.sent_at || '').normalize('NFC').trim();
  if (!draftId || !graphId || !sentAt) return null;
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    mailbox: input.mailbox,
    sourceLocator: input.locator,
    sourceEventId: input.sourceEventId,
    content: `mail-send-receipt:v1:draft_id=${draftId}:graph_message_id=${graphId}:sent_at=${sentAt}`,
    parserVersion: 'mail:company-memory:1',
    locator: {
      kind: 'mail_send_draft',
      draft_id: draftId,
      graph_id: graphId,
    },
  };
}

function resolveMailOutbox(db) {
  if (!db) return emptyOutbox();
  assertOutboxSchema(db);
  return createMailProductDonorPort({
    db,
    resolveSource: (event) => resolveMailCompanyMemorySource(db, event),
  });
}

function emptyOutbox() {
  return {
    listPending() {
      return [];
    },
    markEmitted(workspaceId, id) {
      void workspaceId;
      void id;
    },
  };
}

function assertOutboxSchema(db) {
  let row;
  try {
    row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_company_memory_outbox'",
    ).get();
  } catch {
    throw companyMemoryOutboxUnavailable('mail company-memory outbox schema is unavailable');
  }
  if (!row || typeof row.name !== 'string' || !row.name.trim()) {
    throw companyMemoryOutboxUnavailable('mail company-memory outbox schema is unavailable');
  }
}

function companyMemoryOutboxUnavailable(detail) {
  return new Error(`COMPANY_MEMORY_OUTBOX_UNAVAILABLE: ${detail}`);
}

function readRequired(env, key) {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.normalize('NFC').trim();
  return trimmed ? trimmed : undefined;
}

function incomplete(detail) {
  return new Error(`COMPANY_MEMORY_ENV_INCOMPLETE: ${detail}`);
}

function loadAuthority(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw incomplete('authority file is unreadable or not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw incomplete('authority file must be a JSON object');
  }
  const projects = parsed.projects;
  if (!Array.isArray(projects) || projects.some((item) => typeof item !== 'string')) {
    throw incomplete('authority projects must be strings');
  }
  return {
    keyId: requiredString(parsed.keyId, 'keyId'),
    context: {
      providerInstanceId: requiredString(parsed.providerInstanceId, 'providerInstanceId'),
      workspaceId: requiredString(parsed.workspaceId, 'workspaceId'),
      principalId: requiredString(parsed.principalId, 'principalId'),
      agentId: requiredString(parsed.agentId, 'agentId'),
      sessionId: requiredString(parsed.sessionId, 'sessionId'),
      projects: projects.map((project) => String(project)),
      policyRevision: requiredString(parsed.policyRevision, 'policyRevision'),
      deletionSequence: requiredNumber(parsed.deletionSequence, 'deletionSequence'),
      deletionSetRoot: requiredString(parsed.deletionSetRoot, 'deletionSetRoot'),
    },
  };
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.normalize('NFC').trim()) {
    throw incomplete(`${field} is required`);
  }
  return value.normalize('NFC').trim();
}

function requiredNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw incomplete(`${field} must be a number`);
  }
  return value;
}

function loadSigner(file, keyId) {
  let pem;
  try {
    pem = readFileSync(file, 'utf8');
  } catch {
    throw incomplete('signing key file is unreadable');
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('not ed25519');
    }
    return {
      keyId,
      sign(message) {
        return sign(null, message, privateKey);
      },
    };
  } catch {
    throw incomplete('signing key file must be an Ed25519 PKCS8 PEM');
  }
}

function createSbCompanyTransport(command, configPath) {
  return {
    async invoke(canonicalRequest) {
      return await new Promise((resolve, reject) => {
        const child = spawn(command, ['--config', configPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SB_CONFIG: join(dirname(configPath), 'personal-sb-unused.toml'),
          },
        });
        if (!child.stdin || !child.stdout || !child.stderr) {
          child.kill();
          reject(new Error('COMPANY_TRANSPORT_FAILED'));
          return;
        }
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => {
          stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr.push(chunk);
        });
        child.stdin.on('error', (error) => {
          if (error.code !== 'EPIPE') reject(error);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
        });
        child.stdin.end(Buffer.from(canonicalRequest));
      });
    },
  };
}
