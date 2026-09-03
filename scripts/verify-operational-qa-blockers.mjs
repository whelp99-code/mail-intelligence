#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  EVIDENCE_NORMALIZATION_VERSION,
  PRECISION_CLASSIFICATION_VERSION,
  classifyMessage,
  splitMessageHistory,
  validateClassificationEvidence,
} from '../src/domain/precision-classifier.js';

const databasePath = resolve(process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
if (!existsSync(databasePath)) {
  console.log(JSON.stringify({ operationalQa: 'SKIPPED', reason: 'database_not_found' }, null, 2));
  process.exit(0);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT
      m.graph_id AS id,
      m.subject,
      m.body_text AS body,
      m.body_preview AS bodyPreview,
      m.sender_email AS "from",
      m.sender_name AS fromName,
      m.received_at AS receivedAt,
      m.importance,
      m.is_draft AS isDraft,
      m.has_attachments AS hasAttachments,
      m.is_promotional AS isPromotional,
      f.display_name AS folderName,
      f.well_known_name AS folderWellKnownName,
      pc.work_state AS workState,
      pc.next_actor AS nextActor,
      pc.priority,
      pc.due_at AS dueAt,
      pc.evidence_json AS evidenceJson
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    JOIN precision_classifications pc ON pc.message_id = m.id
    WHERE m.deleted_at IS NULL
    ORDER BY m.id
  `).all();

  let evidenceFields = 0;
  let evidenceFailures = 0;
  let placeholderEvidence = 0;
  let forwardedRegressions = 0;
  let promotionalFalseActions = 0;
  let koreanReplyBoundaryFailures = 0;
  let outgoingActionViolations = 0;
  let outgoingActorViolations = 0;
  let lifecycleFolderActionViolations = 0;
  let automaticInvoiceFalseActions = 0;
  let automaticDocumentFalseActions = 0;
  let informationalUpdateActionViolations = 0;
  let automaticCompletionStateViolations = 0;
  let nonActionPriorityViolations = 0;
  let inlineResponseUpdateMisses = 0;
  let queuedDraftViolations = 0;
  let automatedCompletionPriorityViolations = 0;
  let outgoingPureDeliveryViolations = 0;
  const failureSamples = [];
  const sentFolderPattern = /^(?:sent|sentitems|sent items|sent mail|보낸 편지함|보낸메일함|보낸 메일함)$/i;
  const senderAliases = new Set(rows
    .filter((row) => sentFolderPattern.test(row.folderWellKnownName || row.folderName || '') || Boolean(row.isDraft))
    .map((row) => String(row.from || '').trim().toLowerCase())
    .filter(Boolean));

  for (const row of rows) {
    const message = {
      id: row.id,
      subject: row.subject || '',
      body: row.body || '',
      bodyPreview: row.bodyPreview || '',
      from: row.from || '',
      fromName: row.fromName || '',
      receivedAt: row.receivedAt || '',
      importance: row.importance || 'normal',
      isDraft: Boolean(row.isDraft),
      hasAttachments: Boolean(row.hasAttachments),
      isPromotional: Boolean(row.isPromotional),
      folderName: row.folderName || '',
      folderWellKnownName: row.folderWellKnownName || '',
      isOutgoing: /^(?:sent|sentitems|sent items|sent mail|보낸 편지함|보낸메일함|보낸 메일함)$/i.test(row.folderWellKnownName || row.folderName || ''),
      isDeletedFolder: /^(?:deleteditems|deleted items|trash|지운 편지함|삭제된 항목|휴지통)$/i.test(row.folderWellKnownName || row.folderName || ''),
      isJunkFolder: /^(?:junkemail|junk email|junk|spam|정크 메일|스팸)$/i.test(row.folderWellKnownName || row.folderName || ''),
    };
    const effectiveOutgoing = !message.isDraft
      && (message.isOutgoing || senderAliases.has(String(message.from || '').trim().toLowerCase()));
    const evidence = JSON.parse(row.evidenceJson || '{}');
    evidenceFields += Object.values(evidence).filter(Boolean).length;
    placeholderEvidence += Object.values(evidence).filter((item) => item?.text === '(제목 없음)' || item?.exactText === '(제목 없음)').length;
    const validation = validateClassificationEvidence({ evidence }, message);
    if (!validation.ok) {
      evidenceFailures += validation.failures.length;
      if (failureSamples.length < 10) failureSamples.push({ messageId: createHash('sha256').update(row.id).digest('hex').slice(0, 12), failures: validation.failures });
    }

    const history = splitMessageHistory(message.body || message.bodyPreview);
    const isForwarded = /^(?:(?:\[(?:fw|fwd)\])\s*)*(?:fw|fwd|전달)\s*:/i.test(message.subject)
      || history.boundaryType !== 'none';
    if (/님이\s*작성\s*:/i.test(message.body || message.bodyPreview) && history.boundaryType === 'none') {
      koreanReplyBoundaryFailures += 1;
    }
    if (isForwarded && ['action_required', 'decision_required'].includes(row.workState)) {
      const recomputed = classifyMessage({ ...message, isOutgoing: effectiveOutgoing }, {
        mailboxAddresses: [...senderAliases],
      });
      if (!['action_required', 'decision_required'].includes(recomputed.workState)) forwardedRegressions += 1;
    }
    if (message.isPromotional && ['action_required', 'decision_required'].includes(row.workState)) promotionalFalseActions += 1;
    if (effectiveOutgoing && ['action_required', 'decision_required'].includes(row.workState)) outgoingActionViolations += 1;
    if (effectiveOutgoing && row.workState === 'waiting' && row.nextActor !== 'external_party') outgoingActorViolations += 1;
    if ((message.isDeletedFolder || message.isJunkFolder) && ['action_required', 'decision_required', 'waiting'].includes(row.workState)) {
      lifecycleFolderActionViolations += 1;
    }
    if (/(?:세금계산서).{0,40}(?:발행되었습니다|도착했습니다|확인했습니다)/i.test(`${message.subject}\n${history.currentContent}`)
        && !/(?:발행|제출|회신|송부|전달|보내|작성).{0,24}(?:부탁|요청|바랍니다|해주세요)/i.test(history.currentContent)
        && ['action_required', 'decision_required'].includes(row.workState)) {
      automaticInvoiceFalseActions += 1;
    }
    if (/수신문서보기|이카운트에서\s*보낸\s*메일|efficient\s*change|(?:loginaa|resourcev3)\.ecount\.com/i.test(history.currentContent)
        && ['action_required', 'decision_required', 'waiting'].includes(row.workState)) {
      automaticDocumentFalseActions += 1;
    }
    const inlineResponseUpdate = /(?:내용\s*)?혼선\s*방지.{0,80}(?:본문|메일).{0,48}(?:수정\s*(?:게시|반영)|업데이트|정리).{0,32}(?:\(\s*아래|아래\s*[,，:]|파란색|붉은색|색상)/i.test(history.currentContent);
    if (/(?:내용\s*)?혼선\s*방지.{0,48}(?:수정\s*(?:게시|반영)|업데이트|정리)/i.test(history.currentContent)
        && !inlineResponseUpdate
        && ['action_required', 'decision_required', 'waiting'].includes(row.workState)) {
      informationalUpdateActionViolations += 1;
    }
    if (/문서(?:가|는)?\s*(?:최종\s*)?완료되었습니다/i.test(history.currentContent)
        && row.workState !== 'completed') {
      automaticCompletionStateViolations += 1;
    }
    if (inlineResponseUpdate && (row.workState !== 'action_required' || row.nextActor !== 'me')) {
      inlineResponseUpdateMisses += 1;
    }
    if (/문서(?:가|는)?\s*(?:최종\s*)?완료되었습니다/i.test(history.currentContent)
        && /eformsign|완료\s*문서\s*보기|powered\s+by\s+eformsign/i.test(`${message.subject}\n${history.currentContent}`)
        && row.priority !== 'low') {
      automatedCompletionPriorityViolations += 1;
    }
    const substantiveDraftRequest = message.isDraft
      && !message.isDeletedFolder
      && !message.isJunkFolder
      && /(?:발주|견적|라이선스|라이센스|자료|서류|회신|답변|확인|제출|발행|검토).{0,160}(?:부탁|요청|바랍니다|해주세요)/i.test(history.currentContent);
    if (substantiveDraftRequest && (row.workState !== 'waiting' || row.nextActor !== 'external_party')) {
      queuedDraftViolations += 1;
    }
    const outgoingPureDelivery = effectiveOutgoing
      && /(?:(?:제안서|연락처|답변|장비\s*정보|정보).{0,48}(?:정리|전달|송부|첨부|회신|보내)\s*(?:했습니다|드립니다|드렸습니다)|(?:정리|전달|송부|첨부|회신|보내)\s*(?:했습니다|드립니다|드렸습니다).{0,48}(?:제안서|연락처|답변|정보))/i.test(history.currentContent)
      && !/(?:확인|검토|협의|회신|답변|연락).{0,24}(?:부탁|요청|바랍니다|해주세요|해\s*주시면|후.{0,16}(?:회신|알려|답변))/i.test(history.currentContent)
      && !/(?:견적|발주|수정|변경|제출|발행).{0,24}(?:부탁|요청|바랍니다|해주세요)/i.test(history.currentContent);
    if (outgoingPureDelivery && (row.workState !== 'completed' || row.nextActor !== 'none')) {
      outgoingPureDeliveryViolations += 1;
    }
    const lowValueNonAction = message.isPromotional
      || message.isDeletedFolder
      || message.isJunkFolder
      || /(?:email\s*)?verification\s*code|인증\s*(?:번호|코드)|세금계산서(?:가|를)?\s*(?:발행|도착|수신)|수신문서보기|이카운트에서\s*보낸\s*메일/i.test(`${message.subject}\n${history.currentContent}`);
    if (['reference', 'completed'].includes(row.workState)
        && (row.priority === 'critical' || (row.priority === 'high' && lowValueNonAction))) {
      nonActionPriorityViolations += 1;
    }
  }

  const latestProviderEvents = db.prepare(`
    SELECT event_type, entity_id, payload_json, created_at
    FROM audit_events a
    WHERE entity_type = 'oauth_provider'
      AND id = (
        SELECT id FROM audit_events b
        WHERE b.event_type = a.event_type
          AND b.entity_type = a.entity_type
          AND b.entity_id = a.entity_id
        ORDER BY b.created_at DESC, b.id DESC LIMIT 1
      )
    ORDER BY entity_id, event_type
  `).all().map((row) => ({
    eventType: row.event_type,
    provider: row.entity_id,
    state: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at,
  }));

  const result = {
    operationalQa: 'PASS',
    classificationVersion: PRECISION_CLASSIFICATION_VERSION,
    evidenceNormalizationVersion: EVIDENCE_NORMALIZATION_VERSION,
    messages: rows.length,
    evidenceFields,
    exactEvidence: evidenceFields - evidenceFailures,
    evidenceFailures,
    exactEvidenceRate: evidenceFields ? (evidenceFields - evidenceFailures) / evidenceFields : 1,
    placeholderEvidence,
    forwardedRegressions,
    promotionalFalseActions,
    koreanReplyBoundaryFailures,
    outgoingActionViolations,
    outgoingActorViolations,
    lifecycleFolderActionViolations,
    automaticInvoiceFalseActions,
    automaticDocumentFalseActions,
    informationalUpdateActionViolations,
    automaticCompletionStateViolations,
    nonActionPriorityViolations,
    inlineResponseUpdateMisses,
    queuedDraftViolations,
    automatedCompletionPriorityViolations,
    outgoingPureDeliveryViolations,
    walSizeBytes: existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0,
    senderAliases: senderAliases.size,
    latestProviderEvents,
    failureSamples,
  };

  assert.equal(evidenceFailures, 0, `Evidence validation failures: ${JSON.stringify(failureSamples)}`);
  assert.equal(placeholderEvidence, 0, 'Placeholder evidence must be zero.');
  assert.equal(forwardedRegressions, 0, 'Forwarded-history false actions remain.');
  assert.equal(promotionalFalseActions, 0, 'Promotional messages remain actionable.');
  assert.equal(koreanReplyBoundaryFailures, 0, 'Korean Outlook reply boundaries remain unparsed.');
  assert.equal(outgoingActionViolations, 0, 'Sent-folder messages remain assigned to me as actions.');
  assert.equal(outgoingActorViolations, 0, 'Sent-folder waiting messages must point to external_party.');
  assert.equal(lifecycleFolderActionViolations, 0, 'Deleted/junk folder messages remain actionable.');
  assert.equal(automaticInvoiceFalseActions, 0, 'Automatic invoice notices remain actionable.');
  assert.equal(automaticDocumentFalseActions, 0, 'Automated document-delivery notices remain actionable.');
  assert.equal(informationalUpdateActionViolations, 0, 'Informational thread updates remain actionable.');
  assert.equal(automaticCompletionStateViolations, 0, 'Final document-completion notices are not completed.');
  assert.equal(nonActionPriorityViolations, 0, 'Low-value non-actions remain high or critical priority.');
  assert.equal(inlineResponseUpdateMisses, 0, 'Color-coded inline thread responses are not actionable for the mailbox owner.');
  assert.equal(queuedDraftViolations, 0, 'Substantive outbound drafts are not represented as queued external work.');
  assert.equal(automatedCompletionPriorityViolations, 0, 'Automated final-completion notices are not low priority.');
  assert.equal(outgoingPureDeliveryViolations, 0, 'Outgoing pure deliveries remain waiting instead of completed.');
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
