import { createNotionWorkSystem } from '../adapters/notion-work-system.js';
import { workLinkProjectionAgreement } from '../domain/work-link-projection.js';

const MIN_TERM = 2;
const DEFAULT_PAGE_SIZE = 1000;

function normalizeComparable(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return normalizeComparable(value).replace(/\s+/g, '');
}

function senderEmail(message) {
  if (typeof message.from === 'string' && message.from.includes('@')) return message.from.trim().toLowerCase();
  const nested = message.sender?.email
    || message.from?.emailAddress?.address
    || message.sender?.emailAddress?.address
    || '';
  return String(nested || message.senderEmail || '').trim().toLowerCase();
}

function senderName(message) {
  if (message.fromName) return message.fromName;
  return message.sender?.name
    || message.from?.emailAddress?.name
    || message.sender?.emailAddress?.name
    || '';
}

function messageHaystack(message) {
  const email = senderEmail(message);
  const name = senderName(message);
  return {
    subject: normalizeComparable(message.subject),
    body: normalizeComparable(message.body || message.bodyText || message.bodyPreview),
    from: normalizeComparable(`${name} ${email}`),
    email,
    raw: compact([message.subject, message.body || message.bodyText || message.bodyPreview, name, email].join(' ')),
  };
}

function masterTerms(master) {
  const terms = [];
  const push = (raw, field, confidence) => {
    const normalized = normalizeComparable(raw);
    const packed = compact(raw);
    if (!normalized || packed.length < MIN_TERM) return;
    terms.push({ raw: String(raw).trim(), normalized, packed, field, confidence });
  };
  if (master.objectType === 'engagement') {
    push(master.projectKey, 'projectKey', 0.9);
    push(master.name, 'name', 0.82);
    for (const alias of master.aliases || []) push(alias, 'alias', 0.86);
  }
  if (master.objectType === 'account') {
    push(master.name, 'name', 0.72);
    push(master.primaryEmail, 'primaryEmail', 0.88);
    const domain = String(master.primaryEmail || '').split('@')[1] || '';
    if (domain && domain !== 'example.com') push(domain, 'emailDomain', 0.7);
  }
  return terms;
}

function fieldContains(haystack, term) {
  if (term.field === 'primaryEmail') {
    return haystack.email === term.normalized || haystack.from.includes(term.normalized);
  }
  if (haystack.subject.includes(term.normalized) || compact(haystack.subject).includes(term.packed)) {
    return 'subject';
  }
  if (haystack.body.includes(term.normalized) || compact(haystack.body).includes(term.packed)) {
    return 'body';
  }
  if (haystack.from.includes(term.normalized) || haystack.raw.includes(term.packed)) {
    return 'from';
  }
  return '';
}

export function matchMessageToMasters(message, masters = []) {
  const haystack = messageHaystack(message);
  const hits = [];
  for (const master of masters) {
    for (const term of masterTerms(master)) {
      const field = fieldContains(haystack, term);
      if (!field) continue;
      hits.push({
        objectType: master.objectType,
        system: master.system || 'notion',
        externalId: master.externalId,
        name: master.name,
        confidence: field === 'subject' ? Math.min(term.confidence + 0.04, 0.95) : term.confidence,
        evidence: [{ kind: 'term', term: term.raw, field }],
      });
      break;
    }
  }
  if (!hits.length) return [];
  const engagements = hits.filter((item) => item.objectType === 'engagement');
  const chosen = engagements.length ? engagements : hits.filter((item) => item.objectType === 'account');
  chosen.sort((left, right) => right.confidence - left.confidence);
  const best = chosen[0];
  return [{
    ...best,
    status: 'candidate',
    correctedBy: null,
    graphId: message.id,
  }];
}

export class WorkLinkService {
  constructor({ store, workSystem, now = () => new Date().toISOString() }) {
    this.store = store;
    this.workSystem = workSystem;
    this.now = now;
  }

  async refresh(mailboxKey = 'me', {
    snapshot,
    snapshotPath,
    pageSize = DEFAULT_PAGE_SIZE,
    onPage,
  } = {}) {
    const mailbox = this.store.ensureMailbox({ key: mailboxKey, address: '' });
    const system = snapshot || snapshotPath
      ? createNotionWorkSystem({ snapshot, snapshotPath })
      : this.workSystem;
    const writeProbe = system.proposeActivity();
    await Promise.resolve(writeProbe).then(
      () => {
        throw Object.assign(new Error('Notion write probe must fail in Phase 1.'), { code: 'NOTION_WRITE_NOT_BLOCKED' });
      },
      (error) => {
        if (error?.code !== 'NOTION_WRITE_DISABLED') throw error;
      },
    );

    const previous = this.store.getWorkLinkRefreshState(mailbox.id);
    let sourceSnapshot;
    let messagesTotal = 0;
    let masters = [];
    try {
      sourceSnapshot = this.store.getWorkLinkSourceSnapshot(mailbox.id);
      messagesTotal = sourceSnapshot.count;
      masters = await system.listMasters();
    } catch (error) {
      return this.abortRefresh(mailbox, {
        previous,
        masters: 0,
        collected: [],
        pages: 0,
        messagesTotal,
        error,
      });
    }

    const collected = [];
    let offset = 0;
    let pages = 0;
    const boundedPage = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), DEFAULT_PAGE_SIZE);
    try {
      let messages;
      do {
        pages += 1;
        messages = this.store.getMessagePage(mailbox.id, { limit: boundedPage, offset });
        if (typeof onPage === 'function') {
          await onPage({ page: pages, offset, messages, messagesTotal, seen: collected.length });
        }
        if (!messages.length) {
          if (offset === 0) pages = 0;
          else pages -= 1;
          break;
        }
        for (const message of messages) {
          collected.push({
            message,
            matches: matchMessageToMasters(message, masters),
          });
        }
        offset += messages.length;
      } while (messages.length === boundedPage);
    } catch (error) {
      return this.abortRefresh(mailbox, {
        previous,
        masters: masters.length,
        collected,
        pages,
        messagesTotal,
        error,
      });
    }

    const revision = `worklink-refresh:${this.now()}`;
    let committed;
    try {
      committed = this.store.commitWorkLinkRefresh(mailbox.id, collected, {
        revision,
        sourceSnapshot,
        messagesTotal,
        pages,
      });
    } catch (error) {
      return this.abortRefresh(mailbox, {
        previous,
        masters: masters.length,
        collected,
        pages,
        messagesTotal,
        error,
      });
    }
    const links = this.store.listWorkLinks(mailbox.id);
    const stats = this.store.workLinkStats(mailbox.id);
    const classifications = this.store.getPrecisionClassificationMap(mailbox.id);
    const agreement = workLinkProjectionAgreement(
      collected.map((item) => item.message),
      links,
      classifications,
    );
    return {
      refreshedAt: this.now(),
      completeness: 'complete',
      stale: false,
      status: 'complete',
      masters: masters.length,
      messages: collected.length,
      messagesTotal,
      pages,
      created: committed.created.length,
      revision,
      stats,
      links,
      refresh: committed.refresh,
      watermarks: committed.refresh.watermarks,
      agreement,
    };
  }

  abortRefresh(mailbox, { previous, masters, collected, pages, messagesTotal, error }) {
    const refresh = this.store.recordWorkLinkRefreshState(mailbox.id, {
      status: 'partial',
      completeness: 'partial',
      stale: true,
      revision: previous.revision || null,
      messagesSeen: collected.length,
      messagesTotal,
      pages,
      created: previous.watermarks?.analysisComplete?.count || 0,
      refreshedAt: this.now(),
      error: {
        code: error?.code || 'REFRESH_ABORTED',
        message: error?.message || 'WorkLink refresh aborted.',
        page: pages,
      },
      watermarks: {
        source: { at: this.now(), count: collected.length },
        analysisComplete: previous.watermarks?.analysisComplete || { at: null, count: 0 },
      },
    });
    return {
      refreshedAt: this.now(),
      completeness: 'partial',
      stale: true,
      status: 'partial',
      masters,
      messages: collected.length,
      messagesTotal,
      pages,
      created: 0,
      revision: previous.revision || null,
      stats: this.store.workLinkStats(mailbox.id),
      links: this.store.listWorkLinks(mailbox.id),
      refresh,
      watermarks: refresh.watermarks,
      error: refresh.error,
      agreement: {
        ok: error?.code === 'WORKLINK_SOURCE_CHANGED' ? null : true,
        ...(error?.code === 'WORKLINK_SOURCE_CHANGED' ? { checked: false, reason: 'source_changed' } : {}),
        disagreements: [],
        linkedCandidate: refresh.watermarks?.analysisComplete?.count || 0,
      },
    };
  }

  list(mailboxKey = 'me') {
    const mailbox = this.store.ensureMailbox({ key: mailboxKey, address: '' });
    return {
      links: this.store.listWorkLinks(mailbox.id),
      stats: this.store.workLinkStats(mailbox.id),
      refresh: this.store.getWorkLinkRefreshState(mailbox.id),
    };
  }

  stats(mailboxKey = 'me') {
    const mailbox = this.store.ensureMailbox({ key: mailboxKey, address: '' });
    return {
      ...this.store.workLinkStats(mailbox.id),
      refresh: this.store.getWorkLinkRefreshState(mailbox.id),
    };
  }
}
