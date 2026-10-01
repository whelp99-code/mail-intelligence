#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { buildReplyDraftPlan } from '../src/application/reply-draft-pipeline.js';

const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : 'data/mail-intelligence.sqlite';
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`
  SELECT d.draft_id, d.status, d.subject AS draft_subject, d.body_text AS before_body, d.to_json,
         m.id, m.subject, m.sender_email, m.sender_name, m.body_text, m.body_preview
  FROM mail_send_drafts d
  JOIN messages m ON m.id = d.message_id
  WHERE d.status IN ('needs_approval', 'needs_clarification')
  ORDER BY d.created_at DESC
  LIMIT 2
`).all();

function snippet(value = '') {
  return String(value || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<email>')
    .replace(/[가-힣]{2,4}(?=\s*(?:님|팀장|과장|차장|부장|이사|대표))/g, '<name>')
    .split('\n')
    .slice(0, 5)
    .join('\n');
}

const report = rows.map((row) => {
  const plan = buildReplyDraftPlan({
    id: row.id,
    subject: row.subject,
    sender_email: row.sender_email,
    from: row.sender_name ? `${row.sender_name} <${row.sender_email}>` : row.sender_email,
    body_text: row.body_text,
    body_preview: row.body_preview,
    well_known_name: 'inbox',
  }, { workState: 'action_required', method: 'stored' }, new Date().toISOString(), { db, ownerInput: '' });
  return {
    draftId: row.draft_id,
    status: row.status,
    companyDomain: String(JSON.parse(row.to_json)[0] || '').split('@')[1] || '',
    before: snippet(row.before_body),
    after: snippet(plan.request?.body_text || plan.reason || ''),
    suggestions: (plan.suggestions || []).map((item) => ({ kind: item.kind, autoAttach: item.autoAttach })),
    wrote: false,
  };
});
process.stdout.write(`${JSON.stringify({ dryRun: true, wrote: false, count: report.length, report }, null, 2)}\n`);
db.close();
