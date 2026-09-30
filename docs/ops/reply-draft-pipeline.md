# Reply draft pipeline (step 1)

After a sync, `runReplyDraftPipeline` selects new inbound mail that needs a reply and stores a `needs_approval` draft. It never approves or sends.

- Pending queue (JSON lines: draftId, from, subject, template, summary, created_at): `data/ops/pending-approvals.jsonl`
- Morning digest markdown: `data/ops/morning-digest-YYYY-MM-DD.md`
- Print digest: `node scripts/morning-digest.mjs [--date YYYY-MM-DD] [--db path]`
- Dry count (no drafts, read-only DB): `node scripts/reply-draft-pipeline.mjs --dry-run [--since ISO-8601] [--db path]`

Classification uses the stored precision work state when present. If it is missing, `classifyMessage` runs and the method is labeled `rules-based`. Newsletters, notifications, and auto-mail are skipped. One draft per message id (`request_id` `reply.m<id>`, source `jarvis`). Slack posting is out of scope; 오모냥 reads the queue file.
