import { createHash, timingSafeEqual } from 'node:crypto';
import { MailSendDrafts } from './mail-send-drafts.js';
import { GraphSendClient, hasMailSendScope } from '../adapters/microsoft-graph-send.js';

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function equal(value, expected) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createMailSendApi({
  getStore, getMailbox, getSession, readBody, getAccessToken,
  serviceToken = '', agentTokens = {}, allowSend = false, accessKeyRequired = false,
  recipientAllowlist = null,
  clientFactory = (options) => new GraphSendClient(options),
}) {
  const tokens = { ...agentTokens };
  if (serviceToken) tokens['grok-bot'] = tokens['grok-bot'] || serviceToken;
  const reconciliation = new Map();
  return async (req, url) => {
    const match = /^\/api\/mail\/send-drafts(?:\/([0-9a-f-]{36})(?:\/(approve|cancel))?)?$/.exec(url.pathname);
    if (!match) fail(404, 'MAIL_DRAFT_ROUTE_NOT_FOUND');
    const [, id, action] = match;
    const authorization = String(req.headers.authorization || '');
    const bot = authorization.startsWith('Bearer ');
    let session;
    let agentSource = null;
    if (bot) {
      const presented = authorization.slice(7);
      for (const source of ['grok-bot', 'jarvis']) {
        const token = String(tokens[source] || '');
        if (token.length >= 32 && equal(presented, token)) {
          agentSource = source;
          break;
        }
      }
      if (!agentSource) fail(401, 'DRAFT_TOKEN_REQUIRED');
      if (action) fail(403, 'HUMAN_APPROVAL_REQUIRED');
      if (req.method !== 'GET' && req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
      if (!id && req.method === 'GET') fail(403, 'DRAFT_LIST_FORBIDDEN');
    } else {
      session = getSession(req);
      if (!session) fail(401, 'SESSION_REQUIRED');
      if (req.method === 'POST') {
        if (!equal(req.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REQUIRED');
        if (req.headers.origin !== url.origin) fail(403, 'ORIGIN_REJECTED');
      }
    }
    const store = getStore();
    const drafts = new MailSendDrafts(store.db, { recipientAllowlist });
    const mailbox = getMailbox();
    const decorate = (draft) => {
      const source = draft.message_id === null ? null : store.db.prepare('SELECT subject,web_link FROM messages WHERE id=? AND mailbox_id=?').get(draft.message_id, mailbox.id);
      return { ...draft, original_message: source ? { subject: source.subject, webLink: source.web_link } : null };
    };
    if (!id && req.method === 'POST') {
      const result = drafts.create(mailbox.id, bot ? agentSource : 'ui', await readBody(req));
      return { status: result.replay ? 200 : 201, body: { draft: decorate(result.draft), replay: result.replay } };
    }
    if (!id && req.method === 'GET') return { status: 200, body: { drafts: drafts.list(mailbox.id).map(decorate), send_enabled: allowSend } };
    if (!id) fail(405, 'METHOD_NOT_ALLOWED');
    let draft = drafts.get(mailbox.id, id);
    if (bot && draft.owner_principal !== `agent:${agentSource}`) fail(404, 'DRAFT_NOT_FOUND');
    const reconcile = async () => {
      if (!reconciliation.has(id)) {
        const operation = (async () => {
          try {
            const client = clientFactory({ accessToken: await getAccessToken(), mailboxUser: mailbox.graphUser, recipientAllowlist });
            const outcome = await client.reconcile(drafts.get(mailbox.id, id));
            return drafts.recordOutcome(mailbox.id, id, outcome);
          } catch {
            return drafts.get(mailbox.id, id);
          }
        })();
        reconciliation.set(id, operation);
      }
      try { return await reconciliation.get(id); } finally { reconciliation.delete(id); }
    };
    if (!action && req.method === 'GET') {
      if (draft.status === 'sending') draft = await reconcile();
      return { status: 200, body: { draft: decorate(draft), send_enabled: allowSend } };
    }
    if (req.method !== 'POST' || !action) fail(405, 'METHOD_NOT_ALLOWED');
    const body = await readBody(req);
    const actor = `session:${createHash('sha256').update(session.token).digest('hex').slice(0, 24)}`;
    if (action === 'cancel') {
      if (Object.keys(body).length) fail(400, 'INVALID_CANCEL_FIELDS');
      return { status: 200, body: { draft: decorate(drafts.cancel(mailbox.id, id, actor)) } };
    }
    if (!allowSend) fail(403, 'MAIL_SEND_DISABLED');
    if (!accessKeyRequired) fail(403, 'AUTHENTICATED_OPERATOR_REQUIRED');
    if (Object.keys(body).some((key) => !['payload_digest', 'confirm'].includes(key)) || body.confirm !== true) fail(400, 'EXPLICIT_CONFIRMATION_REQUIRED');
    drafts.assertRecipientsAllowed(draft);
    const token = await getAccessToken();
    draft = drafts.approve(mailbox.id, id, { actor, digest: body.payload_digest, allowSend, hasSendScope: hasMailSendScope(token) });
    if (drafts.claim(mailbox.id, id)) {
      const client = clientFactory({ accessToken: token, mailboxUser: mailbox.graphUser, recipientAllowlist });
      let outcome;
      try {
        outcome = await client.sendOnce(drafts.get(mailbox.id, id), { allowSend });
      } catch {
        outcome = { uncertain: true, failureCode: 'GRAPH_ACCEPTANCE_UNKNOWN' };
      }
      draft = drafts.recordOutcome(mailbox.id, id, outcome);
    } else draft = drafts.get(mailbox.id, id);
    return { status: draft.status === 'sending' ? 202 : 200, body: { draft: decorate(draft) } };
  };
}
