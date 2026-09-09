# Approved mail-send implementation contract

Status: implementation authorized by owner; pilot completion NOT PROVEN.

## Scope and baseline

The full owner contract is the 2026-09-09 pasted implementation instruction, including live self-address send verification. Scope is Mail Intelligence and only `integrations/grok-bot-action-hub` in jmai-os-pack. Jarvis, Second Brain, Browser Operations, Action Hub core, unrelated dirty files, automatic replies, bulk/scheduled mail, Gmail and other mail mutations are forbidden.

CONFIRMED: MI baseline `374c2b4`, active service, `TMPDIR=<private directory> npm run verify:v1.2.2` exit 0; evidence `/home/jm/mi-send-baseline.XtMaOm/verify.log`. Gateway baseline `b4fd7f4`, 10 unittest tests pass. Its repository has unrelated Action Hub core changes; preserve them. Work from isolated MI clone `mail-send-implementation`; do not copy live credentials/data into it.

## Fixed safety contracts

- Drafts are immutable. `(mailbox, source, request_id)` plus canonical payload digest controls idempotency; conflicting payload returns 409. A corrected draft uses a new request ID.
- States: needs_clarification / needs_approval / approved / sending / sent / failed / cancelled. No automatic retry of a send. A sending/ambiguous result can only reconcile by read; repeated approval cannot send again.
- Approval requires a human browser session, exact payload digest, strict CSRF and same-origin validation, explicit send flag, and verified Mail.Send scope. Service tokens cannot approve or cancel, even when accompanied by a browser cookie.
- Grok-facing token can create and read Grok-origin drafts only. The gateway never gets MI session/admin credentials; it has a separate restricted MI token. Gateway has no approve/send/cancel route.
- Unspecified recipient, subject or body creates needs_clarification. No inferred email address. HTML input is not supported in this first contract (optional owner field); plain text is the review and send authority.
- Replies retain the source message association and original link. Cross-mailbox source references are rejected.
- Default `MAIL_INTELLIGENCE_ALLOW_SEND` is OFF; no break-glass flags or unrelated write scopes are enabled. Existing copy-only draft path remains intact.
- A Graph 202 is acceptance, not completion and has no message ID. Use an `x-mi-draft-id` header and save to Sent Items; read Sent Items to obtain the unique Graph message ID before recording sent. Never fabricate an ID or resend after uncertain acceptance.

Primary reference: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0

## Cards and acceptance traceability

| Card | TASK / DELIVERABLE / allowed files | VERIFY / acceptance |
|---|---|---|
| S1 | SQLite and immutable draft state machine: CREATE migrations/005_mail_send_drafts.sql, src/application/mail-send-drafts.js, test/mail-send-drafts.test.js | node --test test/mail-send-drafts.test.js exits 0; valid draft persists; incomplete draft cannot approve; replay same request returns same ID; conflicting request 409; wrong mailbox 404; duplicate/concurrent approval claims once; cancel and receipt invariants hold |
| S2 | Graph adapter: CREATE src/adapters/microsoft-graph-send.js, test/microsoft-graph-send.test.js | node --test test/microsoft-graph-send.test.js exits 0; no scope = zero HTTP sends; approved call sends once; 202 without Sent Items evidence stays pending; receipt requires unique correlated message; timeout never resends; no redirects/token leakage |
| S3 | API integration and policy: MODIFY server.mjs, src/safety.js; CREATE test/mail-send-api.test.js; update test/repository-policy.test.js, test/server-security.test.js and safety verifiers only to test approved send boundary while retaining default OFF assertions | npm test plus default and flag-ON HTTP tests; token rejects approve/cancel; strict session CSRF; disabled approval403; legacy copy-only tests unchanged; scope missing produces safe error without send |
| S4 | Review UI: MODIFY src/app.js, src/index.html, src/styles.css; add focused UI tests | actual browser review displays to/cc/subject/body/source link/source type; approve requires review confirmation; cancel/result visible; no immediate/bulk send; HTML injection rendered as text |
| S5 | Gateway and client, only integration subtree: MODIFY server/gateway.py, grok-skill/scripts/action_hub.py, tests/test_gateway.py, README.md, grok-skill/SKILL.md, KARINA-SETUP-PROMPT-KO.md, grok-skill/references/REQUEST-ROUTING-KO.md and deployment installer if restricted token wiring requires it | python3 -m unittest discover -s tests -v exits0; draft/status only via /grok-action-hub/mail/drafts; direct approve/send/cancel404/405; existing Action Hub routes pass; no secrets in output |
| S6 | Deployment documentation, release notes, verified pilot and commit evidence: MODIFY MI README.md, docs/runbooks/UBUNTU-DEPLOYMENT.md; CREATE release/verification report | both full suites pass; backup/migration verification; service defaultOFF; self-address test only after exact human approval and Mail.Send reconsent; before0/after1 Sent Items and receiving Inbox; duplicate approve remains1; report required owner fields |

Cards execute sequentially in the owner's prescribed order. New files are introduced by their card before its verification command. No delegation is required. Each card produces a scoped diff, command exit code, residual risks and evidence ledger entry.

## API contract

POST /api/mail/send-drafts: session+CSRF or restricted token; input request_id, to[], cc[], subject, body_text, optional message_id and original text; source forced from auth. Returns201 draft or200 replay;400 malformed/unknown fields;409 payload conflict. Missing content remains needs_clarification, not an address guess.

GET /api/mail/send-drafts/:id: session owner or restricted token for its Grok-origin record only;404 for other mailbox/source.

POST /api/mail/send-drafts/:id/approve: session only; input payload_digest and explicit confirmation.403 for flagOFF, invalid CSRF or any restricted token.409 for changed/incomplete/cancelled/failed state. Successful response is actual persisted state, not an inferred sent result.

POST /api/mail/send-drafts/:id/cancel: session+strictCSRF only; terminal sent/sending cannot cancel. List route for session-owned review screen; no service-token list of private UI drafts. Status retrieval may reconcile an already sending record using Graph GET only.

Grok client `mail-draft --request-id ... --text ...` accepts explicit structured recipient/subject/body flags or unambiguous labelled text; incomplete natural language remains needs_clarification. `mail-draft-status --id ...` reads state. Karina never claims sent without a sent receipt.

## Risk and recovery

| Risk | P/I/D | Protection | Recovery |
|---|---|---|---|
| Duplicate send after timeout/crash | 3/5/5=75 R3 | durable claim before network; no send retry | read-only correlation reconciliation; unknown stays sending |
| Bot self-approval/session confusion | 3/5/4=60 R3 | disjoint token/session roles, reject token on approval even with cookie | disable send flag; retain audit |
| Migration loss | 2/5/3=30 R2 | additive migration, isolated restore check and backup | keep flagOFF; restore offline only if independently necessary |
| Fabricated recipient/content | 3/5/4=60 R3 | explicit fields, needs_clarification, human payload review | cancel draft; create corrected immutable draft |
| 202 incorrectly reported sent | 4/5/4=80 R4 | receipt from unique correlated Sent Items record | remain pending and report unknown, never auto-resend |

This is high-risk work; the existing owner specification replaces a large speculative document set. The missing dev-plan master and unavailable brainstorming/verification helper skills are handled by direct contract review and actual tests. No scope or gate is omitted.

## Autonomy and unresolved operator boundary

AUTONOMOUS: implementation, fixtures, migration verification, gateway wiring, review UI, test evidence, scoped deployment preparation. MANUAL: operator send flag and Graph Mail.Send reconsent if absent. Actual recipient must be a verified owner-controlled alternate address; UNKNOWN until safely verified. The agent cannot impersonate human approval. An explicit user approval of the exact test draft is required before pilot send; all other work continues independently.

ASSUMED: existing single-user session is the human review identity; strengthen approval CSRF without changing unrelated auth paths. If actual signatures differ, inspect code and adapt without broad refactoring; record adjustments.

## Review log

Resolved design findings: no graph ID in 202; no safe exactly-once retry after ambiguous timeout; restricted token must not become a session credential. Adoption proof remains tests and live pilot, not this plan. Completion requires every S1–S6 acceptance including actual self-address delivery.

Progress 2026-09-09: S1-S5 implemented. Full verify:v1.2.2 rerun exits0 (407 tests + OAuth9; artifacts/verify-send-final-20260909.log). S4 real browser synthetic checks passed; S5 gateway16 tests and explicit real isolated MI/Gateway integration passed: two SQLite drafts, stable replay, conflict409, incomplete needs_clarification, gateway mutations404, MI bot approval403. Separate-token configuration and redirect/error redaction checks pass. Graph success tests remain synthetic, not live delivery. S6 production backup/migration rehearsal, deployment, exact human-approved self-address delivery and receipt remain incomplete. No production deployment, actual send or scope enablement has occurred.
