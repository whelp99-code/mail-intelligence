# Mail Intelligence — Requirements

**Document version:** 1.0
**Status:** BASELINE
**Effective date:** 2026-08-28
**Depends on:** `00-PROJECT-DEFINITION.md`

---

## 1. Requirement convention

Priority:

- **MUST** — required for the allocated release gate;
- **SHOULD** — planned and valuable, but may move only with an explicit decision record;
- **LATER** — intentionally deferred beyond the current operational target.

Status:

- `PLANNED`
- `IMPLEMENTED`
- `VERIFIED`
- `DEFERRED`
- `REJECTED`

No requirement is considered complete until it has both implementation traceability and acceptance evidence.

---

## 2. Product goals

| ID | Goal | Success evidence |
|---|---|---|
| GOAL-001 | Durable work memory | restart, re-analysis, model change, migration, and restore preserve accepted facts, evidence, and revisions |
| GOAL-002 | Faster project understanding | project current state and recent changes can be understood without rereading full threads |
| GOAL-003 | Reduced missed work | reply needs, deadlines, commitments, changes, blockers, and waiting items are surfaced reliably |
| GOAL-004 | Improving classification | confirmed corrections reduce recurring errors in replay evaluation |
| GOAL-005 | Trustworthy answers | material answers identify evidence, confidence, conflicts, and unknowns |
| GOAL-006 | Safe operation | no unapproved external mutation; every execution is idempotent and receipted |
| GOAL-007 | Recoverable operation | backup, restore, integrity verification, and rollback are repeatable |

---

## 3. Mail source and synchronization requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-MAIL-001 | MUST | Connect one Microsoft Outlook mailbox using a documented delegated OAuth flow with the minimum required read scope. | 1.0.1 |
| REQ-MAIL-002 | MUST | Bind the application to a local-only interface by default and require explicit configuration for any non-local exposure. | 1.0.1 |
| REQ-MAIL-003 | MUST | Ingest a complete baseline of selected folders with pagination and resumable checkpoints. | 1.1.0 |
| REQ-MAIL-004 | MUST | Use Microsoft Graph delta/change tracking rather than only a latest-received timestamp for ongoing synchronization. | 1.1.0 |
| REQ-MAIL-005 | MUST | Preserve immutable source identifiers for mailbox, folder, message, conversation/thread, attachment, and change token. | 1.1.0 |
| REQ-MAIL-006 | MUST | Reconcile message creation, update, move, read-state change, and deletion/tombstone without creating duplicates. | 1.1.0 |
| REQ-MAIL-007 | MUST | Store normalized message text and attachment metadata while retaining a reference to the Outlook source. | 1.1.0 |
| REQ-MAIL-008 | MUST | Make synchronization idempotent and safely restartable after interruption. | 1.1.0 |
| REQ-MAIL-009 | MUST | Display sync progress, last successful checkpoint, failures, retry state, and stale-data warnings. | 1.1.0 |
| REQ-MAIL-010 | SHOULD | Support explicit folder inclusion/exclusion policy and retention policy for locally stored content. | 1.1.0 |
| REQ-MAIL-011 | LATER | Support shared mailboxes and multiple mailbox accounts with isolated synchronization state. | Team phase |
| REQ-MAIL-012 | LATER | Add non-Outlook mail providers through a source-adapter contract. | Post-2.0 |

---

## 4. Intelligence extraction requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-INT-001 | MUST | Analyze messages in thread and project context rather than only as independent documents. | 1.2.0 |
| REQ-INT-002 | MUST | Extract requests, reply needs, deadlines, follow-up dates, meetings, amounts, quotations, orders, contracts, approvals, incidents, risks, and schedule changes. | 1.2.0 |
| REQ-INT-003 | MUST | Extract people, organizations, roles, products, project names, document references, decisions, and commitments. | 1.2.0 |
| REQ-INT-004 | MUST | Attach one or more exact evidence references to every material extracted claim. | 1.1.0 |
| REQ-INT-005 | MUST | Record extraction method, rule/model identifier, prompt/schema version, timestamp, and confidence. | 1.0.1 |
| REQ-INT-006 | MUST | Schema-validate all model output before it can affect stored candidate knowledge. | 1.0.1 |
| REQ-INT-007 | MUST | Distinguish `fact`, `inference`, `recommendation`, `correction`, and `execution outcome`. | 1.2.0 |
| REQ-INT-008 | MUST | Distinguish actionable mail from reference/no-action mail and avoid forced reply proposals. | 1.0.1 |
| REQ-INT-009 | MUST | Detect and expose conflicting or superseding claims instead of silently selecting one. | 1.3.0 |
| REQ-INT-010 | MUST | Show model or rule failure explicitly and label any fallback result. | 1.0.1 |
| REQ-INT-011 | MUST | Support deterministic replay of the same fixture with pinned rule/model configuration. | 1.0.1 |
| REQ-INT-012 | SHOULD | Calibrate confidence by extraction type and observed correction outcome rather than using one generic score. | 1.3.0 |
| REQ-INT-013 | SHOULD | Route messages through optional domain profiles without changing the generic core contract. | 1.2.0 |
| REQ-INT-014 | MUST | Treat prompt content, mail content, and attachments as untrusted input and prevent them from instructing tools or bypassing policy. | 1.0.1 |
| REQ-INT-015 | SHOULD | Detect missing or outdated attachment/document candidates using thread and project context. | 1.3.0 |

---

## 5. Project and work classification requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-PROJ-001 | MUST | Link one message or thread to zero, one, or multiple projects with evidence and confidence. | 1.2.0 |
| REQ-PROJ-002 | MUST | Create project candidates from combined signals such as participants, subject aliases, products, documents, schedules, and prior confirmed relations. | 1.2.0 |
| REQ-PROJ-003 | MUST | Require review for weak or ambiguous new-project candidates. | 1.2.0 |
| REQ-PROJ-004 | MUST | Maintain canonical project identity plus approved aliases and merge/split history. | 1.2.0 |
| REQ-PROJ-005 | MUST | Extract work-item candidates with requester, proposed owner, due date, status, blocker, completion condition, project links, and evidence. | 1.2.0 |
| REQ-PROJ-006 | MUST | Separate processing stage, work status, and detected signals. | 1.2.0 |
| REQ-PROJ-007 | MUST | Deduplicate repeated requests across quoted replies and thread history. | 1.2.0 |
| REQ-PROJ-008 | MUST | Record work-item creation, update, completion, cancellation, and supersession as temporal revisions. | 1.3.0 |
| REQ-PROJ-009 | SHOULD | Suggest likely customer, opportunity, project, and document links from external master systems without automatically mutating them. | 1.5.0 |
| REQ-PROJ-010 | MUST | Let the user confirm, reject, reassign, merge, split, or mark a candidate as reference-only. | 1.2.0 |
| REQ-PROJ-011 | SHOULD | Re-evaluate affected messages and knowledge after a project alias, merge, split, or correction. | 1.3.0 |
| REQ-PROJ-012 | SHOULD | Support domain-profile-specific project and work schemas while retaining shared core fields. | 1.3.0 |

---

## 6. Persistent knowledge and learning requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-KNOW-001 | MUST | Use a structured operational database as the source of truth for derived knowledge. | 1.1.0 |
| REQ-KNOW-002 | MUST | Store mail, thread, attachment, person, organization, project, work item, decision, commitment, schedule, product, issue, risk, evidence, classification, and correction records. | 1.2.0 |
| REQ-KNOW-003 | MUST | Preserve current state and historical revisions with effective and recorded timestamps. | 1.3.0 |
| REQ-KNOW-004 | MUST | Maintain provenance from accepted knowledge back to source evidence and extraction/correction events. | 1.1.0 |
| REQ-KNOW-005 | MUST | Store model observations separately from accepted or user-confirmed knowledge. | 1.1.0 |
| REQ-KNOW-006 | MUST | Make explicit user corrections higher authority than model or similarity-only suggestions. | 1.2.0 |
| REQ-KNOW-007 | MUST | Store correction reason, target, previous value, new value, actor, and time. | 1.2.0 |
| REQ-KNOW-008 | MUST | Use approved aliases and corrections in later classification through versioned policies/examples. | 1.3.0 |
| REQ-KNOW-009 | MUST | Record which policy, alias set, prompt, schema, rule, and model version produced each evaluation. | 1.3.0 |
| REQ-KNOW-010 | MUST | Recompute only knowledge affected by changed evidence, aliases, policies, or corrections. | 1.3.0 |
| REQ-KNOW-011 | MUST | Prevent a lower-authority observation from silently replacing a user-confirmed fact. | 1.3.0 |
| REQ-KNOW-012 | MUST | Represent unresolved conflicts and unknowns explicitly. | 1.3.0 |
| REQ-KNOW-013 | SHOULD | Provide full-text and semantic retrieval while keeping structured data authoritative. | 1.4.0 |
| REQ-KNOW-014 | MUST | Measure improvement by replay evaluation, correction recurrence, and calibration rather than claiming unverified learning. | 1.3.0 |
| REQ-KNOW-015 | SHOULD | Observe approved downstream execution outcomes and link them to the originating proposal and knowledge state. | 2.0.0 |
| REQ-KNOW-016 | SHOULD | Support export/import of corrected examples and policy versions for controlled portability. | 1.5.0 |

---

## 7. User experience requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-UX-001 | MUST | Provide a daily intelligence surface for new changes, reply needs, deadlines, commitments, blockers, waiting items, conflicts, and review candidates. | 1.4.0 |
| REQ-UX-002 | MUST | Provide a project intelligence view with current summary, recent changes, people, decisions, schedule, work, risks, mail, attachments, conflicts, and evidence coverage. | 1.4.0 |
| REQ-UX-003 | MUST | Provide a work view grouped by project, owner, requester, status, due date, and waiting party. | 1.4.0 |
| REQ-UX-004 | MUST | Show evidence, confidence, extraction method, and uncertainty for material conclusions. | 1.2.0 |
| REQ-UX-005 | MUST | Let the user inspect the exact source mail/thread/attachment associated with a claim. | 1.2.0 |
| REQ-UX-006 | MUST | Provide correction/review workflows for project links, entities, status, facts, decisions, and work items. | 1.2.0 |
| REQ-UX-007 | MUST | Provide evidence-backed natural-language retrieval over accepted knowledge and source material. | 1.4.0 |
| REQ-UX-008 | MUST | Clearly label stale data, sync failure, model failure, fallback mode, candidate state, accepted state, and conflict state. | 1.1.0 |
| REQ-UX-009 | SHOULD | Provide change-focused summaries such as “what changed since last review.” | 1.4.0 |
| REQ-UX-010 | MUST | Default to one best next-action proposal; alternatives appear only when useful or requested. | 1.2.0 |
| REQ-UX-011 | SHOULD | Allow saved searches and project/work filters. | 1.4.0 |
| REQ-UX-012 | LATER | Provide team assignment, shared review queues, and role-specific dashboards. | Team phase |

---

## 8. Approval and external action requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-ACT-001 | MUST | Default all external mutation adapters to disabled. | 1.0.1 |
| REQ-ACT-002 | MUST | Represent an external action as `ActionProposal -> Approval -> Execution -> ExecutionReceipt`. | 2.0.0 |
| REQ-ACT-003 | MUST | Require final review for recipients, content, attachments, dates, amounts, commitments, and destination system before execution. | 2.0.0 |
| REQ-ACT-004 | MUST | Use idempotency keys to prevent duplicate send/create/update execution. | 2.0.0 |
| REQ-ACT-005 | MUST | Record actor, approved payload digest, adapter, source context, result, external identifier, timestamps, and failure details. | 2.0.0 |
| REQ-ACT-006 | MUST | Never infer approval from a prior correction, view, draft edit, or generic user session. | 2.0.0 |
| REQ-ACT-007 | MUST | Make read/unread, flag, category, move, delete, send, calendar, task, CRM, project, and Data Plane changes explicit mutation types. | 2.0.0 |
| REQ-ACT-008 | SHOULD | Define retry, reconciliation, cancellation, and compensation behavior per adapter. | 2.0.0 |
| REQ-ACT-009 | MUST | Keep production send/reply/forward scope absent until the approved-execution gate is passed. | 1.0.1–1.5.0 |
| REQ-ACT-010 | SHOULD | Support draft-only export before production mutation adapters are enabled. | 1.4.0 |

---

## 9. Security and privacy requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-SEC-001 | MUST | Bind to `127.0.0.1` by default and fail closed for public exposure without explicit configuration. | 1.0.1 |
| REQ-SEC-002 | MUST | Use least-privilege Microsoft Graph scopes and separate read scopes from later mutation scopes. | 1.0.1 |
| REQ-SEC-003 | MUST | Protect local UI/API with an authenticated session when access is possible beyond a single trusted local process. | 1.0.1 |
| REQ-SEC-004 | MUST | Protect state-changing endpoints against CSRF and cross-origin abuse. | 1.0.1 |
| REQ-SEC-005 | MUST | Keep tokens and secrets out of responses, logs, fixtures, source control, model prompts, and telemetry. | 1.0.1 |
| REQ-SEC-006 | MUST | Prefer environment/OS secret storage or encrypted-at-rest secret storage over a plaintext application JSON file. | 1.0.1 |
| REQ-SEC-007 | MUST | Treat mail and attachment content as untrusted and sanitize rendered content. | 1.0.1 |
| REQ-SEC-008 | MUST | Restrict outbound model and integration destinations through explicit configuration and allowlists. | 1.0.1 |
| REQ-SEC-009 | MUST | Redact or minimize mail content sent to external model providers according to a visible policy. | 1.3.0 |
| REQ-SEC-010 | MUST | Record security-sensitive configuration and approval changes in an audit log without secret values. | 1.5.0 |
| REQ-SEC-011 | MUST | Verify backup confidentiality and ensure sensitive local data is excluded from source/release artifacts. | 1.1.0 |
| REQ-SEC-012 | SHOULD | Support local-only model mode for mailboxes where external model processing is prohibited. | 1.3.0 |
| REQ-SEC-013 | LATER | Add RBAC, tenant isolation, and organization-level retention policy for team use. | Team phase |

---

## 10. Operations and recovery requirements

| ID | Priority | Requirement | Initial release |
|---|---|---|---|
| REQ-OPS-001 | MUST | Provide an operator health endpoint that checks process, database, migrations, source sync state, and adapter state without exposing secrets. | 1.1.0 |
| REQ-OPS-002 | MUST | Use versioned database migrations and record schema version. | 1.1.0 |
| REQ-OPS-003 | MUST | Use atomic durable writes and protect against concurrent or interrupted update corruption. | 1.1.0 |
| REQ-OPS-004 | MUST | Provide backup and restore commands with integrity verification. | 1.1.0 |
| REQ-OPS-005 | MUST | Provide a documented restore rehearsal and rollback procedure. | 1.1.0 |
| REQ-OPS-006 | MUST | Provide structured, redacted logs for sync, extraction, reconciliation, review, policy, and execution events. | 1.1.0 |
| REQ-OPS-007 | MUST | Provide bounded retries, backoff, timeout, and dead-letter/review state for failed ingestion and analysis jobs. | 1.1.0 |
| REQ-OPS-008 | MUST | Make CI checks blocking for syntax, lint, tests, migration, security, and release packaging as allocated by release. | 1.0.1 |
| REQ-OPS-009 | MUST | Disable automatic production deployment until the corresponding release gate passes and operator approval exists. | 1.0.1 |
| REQ-OPS-010 | MUST | Produce a release manifest containing version, commit, schema version, policy versions, test evidence, and known limitations. | 1.1.0 |
| REQ-OPS-011 | SHOULD | Provide storage growth, stale-sync, queue backlog, evaluation drift, and backup-age alerts. | 1.5.0 |
| REQ-OPS-012 | LATER | Support high availability and multi-node deployment. | Post-team phase |

---

## 11. Non-functional requirements

| ID | Priority | Requirement | Target |
|---|---|---|---|
| NFR-001 | MUST | Determinism | repeated rule-based replay with identical inputs/config produces identical structured results |
| NFR-002 | MUST | Provenance coverage | 100% of accepted material claims have at least one evidence reference |
| NFR-003 | MUST | Idempotency | repeated synchronization or execution request creates no duplicate authoritative record or external mutation |
| NFR-004 | MUST | Recoverability | supported backup restores to a passing integrity check and the documented schema version |
| NFR-005 | MUST | Observability | every failed stage identifies stage, source record, retry state, and operator action without revealing secrets |
| NFR-006 | MUST | Local-first privacy | default operation does not expose the service publicly and does not send mail content externally without configured policy |
| NFR-007 | MUST | Evolvability | source, model, storage, domain-profile, retrieval, and action adapters have explicit contracts |
| NFR-008 | SHOULD | Daily usability | normal daily review can be completed from change-focused views without browsing all raw mail |
| NFR-009 | SHOULD | Performance | indexed project/work views and structured search remain interactive for the measured single-user mailbox dataset |
| NFR-010 | MUST | Honesty | maturity and fallback mode are accurately represented; prototype behavior is not labeled production-ready |
| NFR-011 | MUST | Portability | the SQLite database and required metadata can be backed up and migrated without depending on process memory |
| NFR-012 | SHOULD | Accessibility | core review, correction, and approval flows are keyboard reachable and expose useful labels/status text |

Exact performance and quality thresholds are specified by the evaluation dataset and release gate rather than guessed before measurement.

---

## 12. Version allocation summary

| Release | Primary requirements |
|---|---|
| 1.0.1 | REQ-MAIL-001/002, REQ-INT-005/006/008/010/011/014, REQ-ACT-001/009, REQ-SEC-001–008, REQ-OPS-008/009 |
| 1.1.0 | REQ-MAIL-003–010, REQ-INT-004, REQ-KNOW-001/004/005, REQ-UX-008, REQ-SEC-011, REQ-OPS-001–007/010 |
| 1.2.0 | REQ-INT-001–003/007/013, REQ-PROJ-001–007/010, REQ-KNOW-002/006/007, REQ-UX-004–006/010 |
| 1.3.0 | REQ-INT-009/012/015, REQ-PROJ-008/011/012, REQ-KNOW-003/008–012/014, REQ-SEC-009/012 |
| 1.4.0 | REQ-KNOW-013, REQ-UX-001–003/007/009/011, REQ-ACT-010 |
| 1.5.0 | REQ-PROJ-009, REQ-KNOW-016, REQ-SEC-010, REQ-OPS-011, external-link adapters and operational hardening |
| 2.0.0 | REQ-KNOW-015, REQ-ACT-002–008, approved mutation adapters |

---

## 13. Assumptions and unknowns

### ASSUMED

- **ASSUMED-001:** The first operational deployment is single-user on the Ubuntu server.
- **ASSUMED-002:** Outlook/Microsoft Graph is the only initial mail source.
- **ASSUMED-003:** SQLite is sufficient for the first operational mailbox and single writer.
- **ASSUMED-004:** The user prefers correctness, traceability, and approval over autonomous execution speed.
- **ASSUMED-005:** Raw mail remains authoritative in Outlook; local retention can be scoped.

### UNKNOWN

- **UNKNOWN-001:** Exact mailbox type, tenant policy, and granted Graph permissions for the live account.
- **UNKNOWN-002:** Total message, thread, attachment, and daily change volume.
- **UNKNOWN-003:** Required historical ingestion horizon and excluded folders.
- **UNKNOWN-004:** Whether mail content may be processed by an external model provider for each mailbox/category.
- **UNKNOWN-005:** Exact target CRM, project, task, calendar, and Data Plane contracts.
- **UNKNOWN-006:** Team-user timing, concurrency, retention, and access-control requirements.
- **UNKNOWN-007:** Attachment content types and malware-scanning requirements.

These unknowns are resolved during the designated discovery or live-pilot gates. They must not be silently converted into implementation facts.

---

## 14. Requirement-change rule

Any requirement change must include:

- affected goal;
- rationale and evidence;
- compatibility and migration impact;
- security and approval impact;
- release allocation change;
- acceptance-gate change;
- owner approval.

Removing a requirement because it is difficult is not a valid direction change. It may be deferred only with an explicit risk and release decision.
