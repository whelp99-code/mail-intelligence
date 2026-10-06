import { CwosWorkSystemAdapter } from '../adapters/cwos-work-system.js';
import { PrecisionIntelligenceService } from './precision-intelligence.js';
import { matchMessageToMasters } from './work-links.js';
import { mailSourceDigest } from '../adapters/cwos-mail-command.js';

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function readProvenance(result) {
  const raw = result?.provenance && typeof result.provenance === 'object' ? result.provenance : {};
  return {
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : 'cwos',
    workspaceId: typeof result?.workspaceId === 'string' ? result.workspaceId : '',
    atomicSnapshot: false,
    routes: Array.isArray(raw.routes) ? raw.routes.filter((route) => typeof route === 'string') : [],
    accountsReadAt: typeof raw.accountsReadAt === 'string' ? raw.accountsReadAt : '',
    engagementsReadAt: typeof raw.engagementsReadAt === 'string' ? raw.engagementsReadAt : '',
    ...(raw.contract === 'cwos-v2' ? {
      contract: raw.contract, cwosPrincipalId: raw.principalId, principalKind: raw.principalKind,
      runtimeVersion: raw.runtimeVersion, stateHash: raw.stateHash,
      planId: raw.planId, snapshotId: raw.snapshotId, snapshotHash: raw.snapshotHash,
      planHash: raw.planHash, planVersion: raw.planVersion, sourceObservedAt: raw.sourceObservedAt,
      sourceDigest: raw.sourceDigest,
      authority: raw.authority, recordKind: raw.recordKind, approved: false, nativeWork: false,
    } : {}),
  };
}

function verifiedProviderIdentity(identity) {
  if (!identity) return null;
  const mailboxUser = String(identity.mailboxUser || '').trim();
  const tenantId = String(identity.tenantId || '').trim();
  const principalId = String(identity.principalId || '').trim();
  if (!mailboxUser || !tenantId || !principalId || identity.provider !== 'microsoft-graph') {
    fail(403, 'INTAKE_IDENTITY_UNPROVEN');
  }
  return { mailboxUser, tenantId, principalId };
}

function provenanceEvidence(provenance, master, identity = null) {
  if (!provenance) return [];
  const verified = verifiedProviderIdentity(identity);
  return [
    {
      kind: 'cwos_read',
      provider: provenance.provider,
      workspaceId: provenance.workspaceId,
      atomicSnapshot: false,
      routes: provenance.routes,
      accountsReadAt: provenance.accountsReadAt,
      engagementsReadAt: provenance.engagementsReadAt,
      mailbox: verified?.mailboxUser || '',
      tenantId: verified?.tenantId || '',
      principalId: verified?.principalId || '',
      ...(provenance.contract === 'cwos-v2' ? {
        contract: provenance.contract, cwosPrincipalId: provenance.cwosPrincipalId,
        principalKind: provenance.principalKind, runtimeVersion: provenance.runtimeVersion,
        stateHash: provenance.stateHash, authority: provenance.authority,
        recordKind: provenance.recordKind, approved: false, nativeWork: false,
        planId: provenance.planId, snapshotId: provenance.snapshotId,
        snapshotHash: provenance.snapshotHash, planHash: provenance.planHash,
        planVersion: provenance.planVersion, sourceObservedAt: provenance.sourceObservedAt,
        sourceDigest: provenance.sourceDigest,
      } : {}),
    },
    {
      kind: 'cwos_source',
      route: master?.source?.route || '',
      externalId: master?.externalId || '',
      type: master?.type || '',
      relatedAccountId: master?.relatedAccount?.externalId || master?.source?.relatedAccountId || null,
      accountName: master?.source?.accountName ?? null,
      ...(master?.source?.authority === 'ARCHIVE_PROJECTION_ONLY' ? {
        authority: master.source.authority, recordKind: master.source.recordKind,
        approved: false, nativeWork: false, planId: master.source.planId,
        snapshotId: master.source.snapshotId, snapshotHash: master.source.snapshotHash,
        planHash: master.source.planHash, planVersion: master.source.planVersion,
        sourceObservedAt: master.source.sourceObservedAt, sourceDigest: master.source.sourceDigest,
      } : {}),
    },
  ];
}

// Intake is a projection over the existing mail/intelligence records, not a queue.
export class MailWorkIntakeService {
  constructor({ store, workSystem = new CwosWorkSystemAdapter({ db: store.db }) }) {
    this.store = store;
    this.workSystem = workSystem;
    this.intelligence = new PrecisionIntelligenceService({ store });
  }

  source(mailboxUser, messageId) {
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 2000) {
      fail(400, 'MESSAGE_ID_REQUIRED');
    }
    const mailbox = this.intelligence.ensureMailbox(mailboxUser);
    const message = this.store.getMessage(mailbox.id, messageId);
    if (!message || message.deletedAt) fail(404, 'MESSAGE_NOT_FOUND');
    if (message.isOutgoing || message.isDraft || message.isDraftFolder
      || message.isDeletedFolder || message.isJunkFolder) fail(422, 'RECEIVED_MAIL_REQUIRED');
    return {
      mailbox,
      message,
      source: {
        system: 'microsoft-graph',
        mailboxId: mailbox.id,
        messageId: message.id,
        threadId: message.conversationId || null,
        internetMessageId: message.internetMessageId || null,
        receivedAt: message.receivedAt || null,
        sourceUrl: message.webLink || null,
        revision: message.changeKey || null,
        observedAt: this.store.getMessageRecord(mailbox.id, message.id).last_seen_at,
        attachments: this.store.getAttachmentsForMessage(mailbox.id, message.id).map((attachment) => ({
          attachmentId: attachment.graphAttachmentId || null,
          messageId: message.id,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          isInline: attachment.isInline,
          revision: attachment.lastModifiedAt,
        })),
      },
    };
  }

  get(mailboxUser, messageId) {
    const { mailbox, message, source } = this.source(mailboxUser, messageId);
    const classification = this.store.getPrecisionClassification(mailbox.id, message.id);
    const correction = this.store.getPrecisionCorrection(mailbox.id, message.id);
    const handledElsewhere = this.store.getHandledElsewhere(mailbox.id, message.id);
    const links = this.workSystem.listCandidates({ mailboxId: mailbox.id, messageId: message.databaseId });
    const assignment = (objectType) => {
      const candidates = links.filter((link) => link.object_type === objectType);
      const confirmed = candidates.filter((link) => link.status === 'confirmed' && link.corrected_by);
      return {
        status: confirmed.length === 1 ? 'confirmed' : 'unassigned',
        externalId: confirmed.length === 1 ? confirmed[0].external_id : null,
        candidates,
      };
    };
    let project = assignment('engagement');
    if (Object.hasOwn(correction?.overrides || {}, 'primaryProjectId')) {
      project = {
        ...project,
        status: correction.overrides.primaryProjectId == null ? 'unassigned' : 'confirmed',
        externalId: null,
        localProjectId: correction.overrides.primaryProjectId,
        source: 'user-correction',
      };
    }
    return {
      messageId: message.id,
      source,
      work: {
        status: handledElsewhere ? 'completed' : classification?.workState || 'review_required',
        nextActor: handledElsewhere ? 'none' : classification?.nextActor || 'unknown',
        classification,
      },
      customer: assignment('account'),
      project,
      correction,
      handledElsewhere,
    };
  }

  async receiveInCrm(mailboxUser, messageId, { workspaceId, expectedVersion }) {
    const { source, message } = this.source(mailboxUser, messageId);
    return this.workSystem.receiveMail({
      workspaceId, expectedVersion, source, message, mailboxUser,
      assertCurrent: () => {
        if (mailSourceDigest(this.source(mailboxUser, messageId).source) !== mailSourceDigest(source)) {
          fail(409, 'INTAKE_SOURCE_CHANGED');
        }
      },
    });
  }

  async mapInCrm(mailboxUser, messageId, { workspaceId, expectedVersion, workItemId }) {
    const { source, mailbox } = this.source(mailboxUser, messageId);
    const correction = this.store.getPrecisionCorrection(mailbox.id, messageId);
    if (!correction?.note?.trim()) fail(403, 'MAIL_CORRECTION_REQUIRED');
    return this.workSystem.mapMailWork({
      workspaceId, expectedVersion, source, mailboxUser, workItemId, correctionReason: correction.note,
      assertCurrent: () => {
        if (mailSourceDigest(this.source(mailboxUser, messageId).source) !== mailSourceDigest(source)
          || JSON.stringify(this.store.getPrecisionCorrection(mailbox.id, messageId)) !== JSON.stringify(correction)) {
          fail(409, 'INTAKE_SOURCE_CHANGED');
        }
      },
    });
  }

  async masterRead(workspaceId) {
    let result;
    try {
      result = await this.workSystem.readMasters({ workspaceId });
    } catch (error) {
      if (error && typeof error === 'object' && !error.statusCode) error.statusCode = 502;
      throw error;
    }
    // Partial master sets must never look like complete disambiguation.
    if (result?.nextCursor) fail(409, 'CWOS_MASTERS_INCOMPLETE');
    if (!result || !Array.isArray(result.items)) fail(502, 'CWOS_MASTER_INVALID');
    return { items: result.items, provenance: readProvenance(result) };
  }

  matchesFor(message, items, provenance = null, providerIdentity = null) {
    const matches = [];
    for (const master of items) {
      if (!master || !['account', 'engagement', 'activity', 'commitment'].includes(master.objectType)
        || typeof master.externalId !== 'string' || !master.externalId.trim()) {
        fail(502, 'CWOS_MASTER_INVALID');
      }
      if (!['account', 'engagement'].includes(master.objectType)) continue;
      for (const match of matchMessageToMasters(message, [master])) {
        matches.push({
          ...match,
          evidence: [
            ...match.evidence,
            ...provenanceEvidence(provenance, master, providerIdentity),
          ],
        });
      }
    }
    return matches;
  }

  async ingest(mailboxUser, messageId, { workspaceId = '', masters = null, readResult = null, assertBinding = null, providerIdentity = null } = {}) {
    const { mailbox, message, source } = this.source(mailboxUser, messageId);
    const matches = [];
    if (workspaceId) {
      let items = masters;
      let provenance = null;
      if (readResult) {
        items = readResult.items;
        provenance = readProvenance(readResult);
      } else if (items == null) {
        const read = await this.masterRead(workspaceId);
        items = read.items;
        provenance = read.provenance;
      }
      if (!Array.isArray(items)) fail(502, 'CWOS_MASTER_INVALID');
      if (assertBinding) assertBinding();
      matches.push(...this.matchesFor(message, items, provenance, providerIdentity));
    }
    this.store.transaction(() => {
      if (assertBinding) assertBinding();
      const current = this.source(mailboxUser, messageId);
      if (JSON.stringify(current.message) !== JSON.stringify(message)
        || JSON.stringify(current.source) !== JSON.stringify(source)) fail(409, 'INTAKE_SOURCE_CHANGED');
      this.intelligence.classifyOne(mailboxUser, message.id);
      for (const match of matches) {
        this.workSystem.candidate({
          mailboxId: mailbox.id,
          messageId: message.databaseId,
          graphId: message.id,
          ...match,
          evidence: [
            ...match.evidence,
            { kind: 'mail_source', ...source },
            { kind: 'received_at', value: message.receivedAt || null },
            { kind: 'thread_id', value: message.conversationId || null },
            { kind: 'source_url', value: message.webLink || null },
          ],
        });
      }
    });
    return this.get(mailboxUser, messageId);
  }
}
