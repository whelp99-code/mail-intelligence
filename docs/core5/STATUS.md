# Core5 status

**Git permission correction:** The earlier `.git/index.lock` EROFS was a sandbox restriction. The owner confirmed host Git writes work and authorized retrying this Core5-only local checkpoint with elevated Git permissions. Planning and handover files are excluded.

**External blockers (top-level):** Second Brain B03 Docling adapter is not present in the inspected checkout, AI-CRM+PM C04 mail/work-system integration contract is not present as a named adapter or contract, and the H04 fixed quality-evaluation gate is not present in this checkout. Mail-side M02/M03/M06 work therefore remains fail-closed and records these upstream items as remaining until their source contracts are supplied.

## M05 — continuous reconciliation and sync checkpoint

- Added forward-only migration `010_mail_send_reconciliation.sql` for durable reconciliation jobs, leases, attempts, and backoff.
- Added `SendReconciliationWorker`; it claims only `sending` drafts and invokes read-only provider reconciliation. It has no send path and never retries `sendMail` after an uncertain acknowledgement.
- The server schedules the worker with a bounded interval and clears it during shutdown; it remains read-only and uses the existing Graph/Sent Items correlation receipt path.
- Existing draft claim/outcome paths enqueue and complete durable jobs when the migration is available; legacy fixtures remain compatible.
- Graph mail retry errors now preserve a bounded numeric `Retry-After` delay for the existing retry helper. Deleted/moved delta items remain handled by the existing normalized removal/folder update path; expired cursors reset through the existing forward-only sync flow.

Named tests passed: `test/send-reconciliation-worker.test.js`, `test/mail-send-drafts.test.js`, `test/mail-send-api.test.js`, `test/microsoft-graph-send.test.js`.

## M02 / M03 / M06 — Mail-side guarded slices

- M02 adds quarantine, scan-state, and authorized-extraction state in `011_mail_attachment_processing.sql`; unavailable, unsupported, infected, and timeout results cannot be exposed.
- M03 adds candidate-only CWOS links in `012_mail_work_links.sql`; the adapter accepts read masters and explicitly rejects writes. Notion remains a read-only projection.
- M06 adds an evidence-backed request→work→draft→review→provider→follow-up projection. Its agent summary separates `accepted_202`, provider outcome, and business resolution with stage evidence. Mail text is treated as evidence and cannot grant external mutation authority; uncertain provider status remains uncertain.

Named tests passed: `test/attachment-pipeline.test.js`, `test/cwos-work-system.test.js`, `test/mail-journey.test.js`.

## Company-memory donor (2026-09-23)

Mail-only `sb-company` donor publisher is in
`src/application/company-memory-donor.js` with focused unit tests. Durable
keys-only outbox is migration `013_mail_company_memory_outbox.sql`.
Acknowledgement is fail-closed (matching receipt required).
`CwosWorkSystemAdapter.createMailProductDonorPort()` and the zero-argument
`createMailProductDonorPort()` remain `MAIL_ADAPTER_NOT_IMPLEMENTED` so CRM
cannot invent a Mail database. No server production bind, live company writes,
personal `sb remember`, or shared signing key. Tests use ephemeral Ed25519
keypairs; operator pairing is documented in `docs/core5/COMPANY-MEMORY-DONOR.md`.

## Local checkpoint verification

Reran successfully: `node --test test/attachment-pipeline.test.js test/cwos-work-system.test.js test/mail-journey.test.js test/send-reconciliation-worker.test.js test/graph-mail-sync.test.js test/sqlite-store.test.js test/mail-send-drafts.test.js test/mail-send-api.test.js test/microsoft-graph-send.test.js test/resilience.test.js` (10 test files passed).

This is an implementation checkpoint, not release acceptance. Attachment scanning/extraction, CWOS integration, and journey quality acceptance remain incomplete. Focused fixture passes do not establish production readiness. Full-suite localhost `listen EPERM` failures are excluded from this requested checkpoint verification.
