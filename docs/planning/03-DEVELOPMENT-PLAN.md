# Mail Intelligence — Versioned Development Plan

**Document version:** 1.0
**Status:** READY FOR OWNER REVIEW
**Effective date:** 2026-08-28
**Depends on:** `00-PROJECT-DEFINITION.md`, `01-REQUIREMENTS.md`, `02-DATA-AND-ARCHITECTURE.md`

---

## 1. Plan objective

This plan transforms the existing `1.0.0` prototype into the defined Mail Intelligence product without a big-bang rewrite.

The order is intentionally fixed:

```text
P0  Fix definition and contracts
P1  Stop unsafe/incorrect behavior
P2  Build persistent mail memory and reliable synchronization
P3  Build project/work intelligence
P4  Build temporal knowledge and controlled learning
P5  Build daily/project/search intelligence surfaces
P6  Link external work systems and harden operations
P7  Enable approved execution
```

A later stage must not be implemented by bypassing an earlier release gate.

---

## 2. Current baseline assessment

### 2.1 Useful assets to preserve

- Microsoft Graph OAuth and message-fetching prototype;
- rule-based mail analysis concepts;
- user classification correction UI;
- provider intent for F-AIOS, LM Studio, and Gemini;
- simple local Node.js deployment;
- three-column mail/detail/action UI as a migration surface;
- basic health script and GitHub workflow scaffolding.

### 2.2 Confirmed blockers

| ID | Current issue | Consequence | Required release |
|---|---|---|---|
| BASE-001 | AI enrichment uses unparsed/undefined variables and misreports provider state | real AI analysis may fail and silently fall back | 1.0.1 |
| BASE-002 | send/read mutation paths do not implement the target approval boundary | business-impacting external mutation risk | 1.0.1 disable; 2.0 redesign |
| BASE-003 | displaying/selecting mail can mark Outlook messages read | observation changes source state | 1.0.1 |
| BASE-004 | local API has weak authentication/CSRF boundary and unspecified listener host | unauthorized local/network mutation risk | 1.0.1 |
| BASE-005 | tokens and secrets can be persisted in plaintext application JSON | secret exposure risk | 1.0.1 |
| BASE-006 | synchronization uses a latest-received timestamp and max page rather than delta/pagination | missed updates, deletes, moves, and high-volume changes | 1.1.0 |
| BASE-007 | JSON file is the operational mail/analysis/feedback store | corruption, growth, migration, and query limitations | 1.1.0 |
| BASE-008 | rules force action on reference mail and misclassify mixed-status sentences | low trust and noisy work generation | 1.0.1/1.2.0 |
| BASE-009 | generic logic hard-codes Sangfor reply behavior | core/domain contamination | 1.0.1/1.2.0 |
| BASE-010 | no automated unit/integration/evaluation tests | regressions cannot be proven | 1.0.1 onward |
| BASE-011 | CI and security checks frequently use `|| true` | failing code may appear green | 1.0.1 |
| BASE-012 | CD can attempt production deployment from `main` independently of a proven release gate | unsafe release path | 1.0.1 |
| BASE-013 | duplicate root and `src/` frontend files | unclear source authority | 1.0.1 |
| BASE-014 | one large server module mixes source, storage, AI, API, and actions | difficult testing and unsafe change coupling | incremental refactor from 1.0.1 |

### 2.3 Current maturity

```text
Repository version: 1.0.0
Engineering maturity: legacy prototype
Operational decision: NO-GO for real external mutation
Safe use decision: local syntax/health demonstration only until 1.0.1 gate
```

---

## 3. Delivery principles

1. **Vertical slices, not a full rewrite.** Each release leaves a runnable, testable product.
2. **Compatibility adapters.** Existing UI and source behavior can temporarily call new modules while migration progresses.
3. **Database becomes authoritative only after reconciliation tests pass.** Legacy files remain rollback inputs during the migration window.
4. **Read-only first.** No production mutation adapter is re-enabled before 2.0.0.
5. **Tests are part of the feature.** A PR without requirement IDs and relevant evidence is incomplete.
6. **Migration and rollback are release work.** They are not post-release documentation tasks.
7. **Model independence.** Every intelligence feature must work with a provider adapter and an explicit rules-only degraded mode.
8. **Evidence and failure visibility.** UI work is not complete if it hides provenance or failure state.
9. **No silent scope expansion.** Team, SaaS, Gmail, graph database, or autonomous action work is deferred unless the source-of-truth definition changes.
10. **No calendar promises in this plan.** Progress is gate-based; a release is done when evidence passes, not when a date arrives.

---

## 4. Release map

| Stage | Release | Product capability | Operational maturity |
|---|---|---|---|
| P0 | Planning baseline | definition, requirements, architecture, development, verification contracts | planning only |
| P1 | 1.0.1 | safe and honest read-only prototype | development-safe baseline |
| P2 | 1.1.0 | persistent mail memory and reliable sync | read-only data pilot |
| P3 | 1.2.0 | project/work/entity intelligence and review | intelligence pilot |
| P4 | 1.3.0 | temporal reconciliation and controlled improvement | learning pilot |
| P5 | 1.4.0 | daily/project/work/search surfaces | single-user internal beta |
| P6 | 1.5.0 | external linking and operational hardening | production candidate, still mutation-disabled |
| P7 | 2.0.0 | approved external execution with receipts | controlled internal production |

---

# 5. P0 — Planning baseline

## Objective

Fix product definition and preserve one traceable chain from problem through release gates.

## Deliverables

- root `AGENTS.md`;
- `docs/planning/README.md`;
- `00-PROJECT-DEFINITION.md`;
- `01-REQUIREMENTS.md`;
- `02-DATA-AND-ARCHITECTURE.md`;
- `03-DEVELOPMENT-PLAN.md`;
- `04-TEST-AND-RELEASE-GATES.md`.

## Completion gate

- documents are internally consistent;
- every release has requirement allocation and a release gate;
- current assumptions and unknowns remain visible;
- no application code change is mixed into the planning baseline;
- owner accepts the fixed direction before implementation begins.

---

# 6. v1.0.1 — Safety and Correctness Recovery

## Release objective

> Make the current prototype safe, honest, deterministic enough to develop, and strictly read-only in production behavior.

## In scope

- fix AI response parsing, schema validation, exact provider/model reporting, cache key usage, and undefined variables;
- add explicit AI/rules run state and visible failure/fallback reporting;
- remove automatic read-state mutation on message display;
- disable production mail send, read-state, folder, calendar, task, CRM, and Data Plane mutation paths by default;
- separate Graph read consent from future mutation consent;
- bind to `127.0.0.1` by default;
- introduce configuration validation and safe secret handling boundary;
- add authenticated local session/CSRF protection for state-changing local APIs;
- bound request bodies, timeouts, retries, and provider destinations;
- sanitize source content and enforce prompt-injection/tool boundary;
- fix reference/no-action classification and mixed-status precedence baseline;
- remove forced three-scenario behavior and use one primary proposal plus optional alternatives;
- remove Sangfor behavior from generic core and create a profile seam;
- identify `src/` as frontend authority and remove obsolete duplicates after parity check;
- make ports and documentation consistent;
- add unit, API, and degraded-mode tests;
- make CI blocking;
- disable automatic production CD and replace with manual package verification only.

## Explicitly out of scope

- SQLite operational migration;
- complete mailbox ingestion;
- project/work persistent knowledge;
- semantic search;
- production send or external system mutation.

## PR graph

```text
PR-101 Safety switch and process boundary
   ├── local-only bind
   ├── mutation adapters default-disabled
   ├── least-privilege Graph scope
   └── configuration validation

PR-102 AI analysis contract
   ├── parse and schema validate response
   ├── exact provider/model metadata
   ├── timeout/fallback as separate runs
   └── deterministic fixtures

PR-103 API and content security
   ├── session and CSRF boundary
   ├── request/body validation
   ├── origin/content rendering controls
   └── secret-safe status/logging

PR-104 Classification and UI truthfulness
   ├── no automatic read mutation
   ├── reference/no-action support
   ├── one primary recommendation
   ├── visible confidence/evidence/failure mode
   └── generic/domain profile seam

PR-105 Verification and delivery gate
   ├── unit/API tests
   ├── blocking CI
   ├── security/static checks
   ├── manual release package
   └── disable unsafe CD

PR-106 Legacy cleanup and documentation
   ├── duplicate frontend cleanup
   ├── port/path/runbook correction
   └── current limitations and rollback note
```

`PR-101` and `PR-102` may proceed in parallel if file ownership is isolated. `PR-103` depends on PR-101 contracts. `PR-104` depends on PR-102. `PR-105` is completed after all behavior changes. `PR-106` closes the release.

## Required evidence

- requirements: REQ-MAIL-001/002, REQ-INT-005/006/008/010/011/014, REQ-ACT-001/009, REQ-SEC-001–008, REQ-OPS-008/009;
- targeted tests for the reproduced mixed “completed but urgent rework” case;
- targeted reference/newsletter no-action case;
- model valid JSON, malformed JSON, timeout, fallback, and provider-reporting tests;
- negative tests proving view/select does not mutate Outlook state;
- negative tests proving send/read/Data Plane production mutation is unavailable;
- local listener and cross-origin/CSRF tests;
- fresh install, syntax, lint, unit, API, package, and health checks.

## Release gate

The v1.0.1 gate in `04-TEST-AND-RELEASE-GATES.md` must pass before database or new intelligence feature work begins.

---

# 7. v1.1.0 — Persistent Mail Memory and Reliable Synchronization

## Release objective

> Replace the JSON-cache prototype with a durable, migratable, evidence-ready mail database and reliable source synchronization.

## In scope

- SQLite database foundation and migration framework;
- repository/transaction interfaces;
- mail account, folder, cursor, thread, message, participant, attachment metadata, evidence, analysis-run, observation, correction, audit, job, and outbox foundations;
- legacy `.mail-cache.json` import with feedback preserved as corrections;
- Microsoft Graph baseline pagination and delta synchronization;
- create/update/move/read-state/delete tombstone reconciliation;
- resumable checkpoints and idempotent job keys;
- normalized content checksums and quoted/thread context preparation;
- bounded retries, timeout, dead-letter/review state;
- structured redacted logs and operator status;
- backup, restore, integrity, and migration commands;
- read-only UI/API moved to the database-backed source;
- release manifest and operational runbook.

## Explicitly out of scope

- final project/work intelligence;
- semantic entity resolution beyond source identities;
- automatic policy learning;
- production external actions.

## PR graph

```text
PR-111 Database kernel and migrations
   ├── SQLite connection/transaction policy
   ├── schema versioning
   ├── repository interfaces
   └── integrity checks

PR-112 Legacy import and rollback
   ├── cache/feedback importer
   ├── staging + reconciliation report
   ├── idempotent re-run
   └── rollback preservation

PR-113 Microsoft Graph source adapter
   ├── paginated baseline sync
   ├── delta cursor
   ├── tombstones/moves/source revisions
   └── least-privilege contract tests

PR-114 Mail normalization and evidence foundation
   ├── threads/participants/attachments
   ├── content digests
   ├── evidence locators
   └── quoted-history boundaries

PR-115 Job runner and failure state
   ├── resumable jobs
   ├── retries/backoff/timeouts
   ├── dead-letter/review
   └── idempotency

PR-116 Operations foundation
   ├── health/status
   ├── structured logs
   ├── backup/restore
   ├── release manifest
   └── operator runbook

PR-117 Database-backed read UI/API
   ├── sync progress/stale warnings
   ├── source/evidence links
   └── legacy-cache removal gate
```

Dependency order:

```text
111 -> 112
111 -> 113 -> 114 -> 115
111 -> 116
112 + 114 + 115 -> 117
```

## Required evidence

- requirements: REQ-MAIL-003–010, REQ-INT-004, REQ-KNOW-001/004/005, REQ-UX-008, REQ-SEC-011, REQ-OPS-001–007/010;
- idempotent import and sync replay;
- baseline plus delta fixture tests including update, move, read change, and deletion;
- interruption and resume tests;
- database migration forward/rollback compatibility where supported;
- backup/restore with integrity and record-count reconciliation;
- no secret or raw sensitive fixture in artifacts;
- stale-sync and failure UI state.

## Release gate

The database becomes authoritative only after import, delta, integrity, and restore acceptance evidence passes. Until then, legacy files remain rollback inputs and are not silently deleted.

---

# 8. v1.2.0 — Project and Work Intelligence

## Release objective

> Convert normalized mail history into reviewable projects, work items, entities, decisions, commitments, schedules, issues, risks, and evidence-backed classifications.

## In scope

- generic observation schema and extraction pipeline;
- person, organization, product, document, and project entity candidates;
- alias normalization and confirmed identity relations;
- project candidate generation and multi-project links;
- work-item candidate extraction and deduplication across quoted thread history;
- decision, commitment, schedule, amount, quotation/order/contract, issue, and risk extraction;
- separate processing stage, work status, and signals;
- candidate/accepted/rejected review workflow;
- corrections for project links, aliases, work status, entities, and extracted claims;
- one primary next-action proposal with optional alternatives;
- domain profile contract and initial Sangfor/sales/project profiles;
- message/project/work review UI.

## Explicitly out of scope

- automatic policy activation from corrections;
- full temporal supersession engine;
- natural-language project query;
- production external mutation.

## PR graph

```text
PR-121 Observation and evidence contracts
PR-122 Generic extraction pipeline
PR-123 Entity and alias resolver
PR-124 Project candidate/link engine
PR-125 Work/decision/commitment/schedule engine
PR-126 Review and correction workflow
PR-127 Domain profile framework and initial profiles
PR-128 Project/work/message intelligence UI
```

Dependencies:

```text
121 -> 122
121 -> 123
122 + 123 -> 124
122 + 124 -> 125
123 + 124 + 125 -> 126
122 -> 127
126 + 127 -> 128
```

## Required evidence

- requirements: REQ-INT-001–003/007/013, REQ-PROJ-001–007/010, REQ-KNOW-002/006/007, REQ-UX-004–006/010;
- fixed redacted/synthetic evaluation set covering multiple simultaneous projects, quoted replies, no-action mail, mixed status, schedule changes, amounts, decisions, and missing evidence;
- multi-link and zero-link behavior;
- weak new-project candidates never becoming canonical without policy/review;
- merge/split/reassignment audit trail;
- domain profile cannot weaken core schema/evidence/security behavior;
- user correction immediately changes the accepted local projection while retaining prior observation.

## Release gate

Project/work intelligence may enter a single-user pilot only after precision, evidence, duplicate, and correction gates pass for the fixed evaluation dataset.

---

# 9. v1.3.0 — Continuous Learning and Temporal Knowledge

## Release objective

> Make the system improve from explicit corrections and outcomes while preserving history, conflicts, policy versions, and reproducible evaluation.

## In scope

- stable knowledge claims and temporal revisions;
- effective time versus recorded time;
- authority hierarchy and predicate-specific reconciliation;
- conflict, supersession, unknown, duplicate, and rejected states;
- versioned aliases, classification/routing policies, prompts, schemas, domain profiles, and confidence calibration;
- correction/outcome-to-policy candidate flow;
- replay evaluation and regression reports;
- impact analysis and bounded re-evaluation of affected knowledge;
- confidence calibration by observation type;
- schedule/project/work change history;
- missing/outdated document candidate logic;
- external-model data-sharing/redaction policy and local-only route.

## Explicitly out of scope

- unreviewed self-modifying production prompts/policies;
- autonomous fine-tuning;
- external mutation adapters;
- team collaboration.

## PR graph

```text
PR-131 Temporal knowledge claims and revisions
PR-132 Reconciliation, authority, conflicts, supersession
PR-133 Versioned policy/alias/prompt/profile registry
PR-134 Replay evaluation harness and baseline dataset
PR-135 Impact graph and bounded re-evaluation
PR-136 Confidence calibration and correction recurrence metrics
PR-137 Temporal/change/document intelligence UI
```

Dependencies:

```text
131 -> 132
133 + 134 -> controlled activation
132 + 133 -> 135
134 + 135 -> 136
131 + 132 + 136 -> 137
```

## Required evidence

- requirements: REQ-INT-009/012/015, REQ-PROJ-008/011/012, REQ-KNOW-003/008–012/014, REQ-SEC-009/012;
- confirmed fact cannot be overwritten by a lower-authority observation;
- conflicting schedules remain visible with both evidence paths;
- policy activation is immutable, audited, and reproducible;
- correction replay improves the intended case without exceeding regression thresholds;
- invalidation is bounded to affected records and can be resumed;
- historical “what did we know then?” query works;
- external-provider redaction/local-only policy is testable and visible.

## Release gate

The product may claim “continuously improving” only after replay evidence demonstrates measurable improvement and no hidden policy mutation path exists.

---

# 10. v1.4.0 — Intelligence Surfaces and Retrieval

## Release objective

> Turn the persistent knowledge base into a practical daily work interface and evidence-backed project search experience.

## In scope

- daily change/decision inbox;
- reply-needed, deadline, commitment, waiting, blocker, conflict, review, and reference views;
- project intelligence page;
- work-item view by project/owner/requester/status/due/waiting party;
- project timeline and change-focused summaries;
- structured and FTS5 search;
- optional versioned semantic retrieval for candidate evidence;
- evidence-backed natural-language questions over accepted knowledge;
- data freshness, conflict, unknown, and fallback indicators;
- saved searches/filters;
- draft-only output/export without execution authority;
- usability and accessibility refinement.

## Explicitly out of scope

- production send/calendar/task/CRM mutations;
- automatic customer/project master updates;
- team assignment.

## PR graph

```text
PR-141 Daily intelligence projections
PR-142 Project intelligence projections and timeline
PR-143 Work-item projections
PR-144 Structured/FTS retrieval
PR-145 Evidence-backed query answering
PR-146 Draft-only action surface
PR-147 UX/accessibility/performance hardening
```

## Required evidence

- requirements: REQ-KNOW-013, REQ-UX-001–003/007/009/011, REQ-ACT-010;
- every factual answer cites accepted claims and evidence;
- conflict and unknown state cannot be summarized away;
- stale sync is visible in answers;
- semantic retrieval cannot directly create accepted facts;
- task completion study using the user's representative project/mail scenarios;
- interactive performance measured against the actual pilot dataset.

## Release gate

Single-user internal beta requires successful user acceptance for daily review, project state, recent changes, open commitments, and evidence-backed questions.

---

# 11. v1.5.0 — External Work Linking and Operational Hardening

## Release objective

> Connect Mail Intelligence to external work systems as a safe proposal/linking layer and prove recoverable internal operation before mutation is enabled.

## In scope

- read-only/candidate adapters for CRM, project, task, calendar, document, and Data Plane systems selected by the owner;
- external master-ID mapping and conflict handling;
- customer/project/opportunity/activity/task/calendar link proposals;
- signed/versioned outbox delivery for approved non-mutating publication where policy permits;
- duplicate link/create detection;
- storage growth and retention policy;
- backup scheduling and restore rehearsal;
- audit and operator views;
- stale sync, queue backlog, backup age, evaluation drift, and storage alerts;
- service management, least-privilege filesystem/network policy, reverse-proxy/TLS design only if remote exposure is required;
- production packaging, release manifest, SBOM/dependency evidence, and rollback rehearsal;
- PostgreSQL decision gate based on measured concurrency, not assumption.

## Explicitly out of scope

- sending mail;
- creating/updating calendar/task/CRM/project records without the 2.0 approval contract;
- public multi-tenant service;
- team RBAC unless separately approved.

## PR graph

```text
PR-151 External master/link adapter contracts
PR-152 Candidate mapping and deduplication
PR-153 Signed outbox and delivery reconciliation
PR-154 Retention, backup schedule, restore/rollback operations
PR-155 Audit, alerting, and operator surfaces
PR-156 Production packaging and security validation
PR-157 Internal production-candidate acceptance
```

## Required evidence

- requirements: REQ-PROJ-009, REQ-KNOW-016, REQ-SEC-010, REQ-OPS-011;
- external links do not silently mutate masters;
- outbox retry is idempotent;
- restore rehearsal preserves evidence and policy versions;
- retention policy does not remove evidence still required by accepted claims without an explicit tombstone policy;
- operator can detect and recover stale sync, failed jobs, and aged backups;
- internal production-candidate checklist passes while mutation adapters remain disabled.

## Release gate

v1.5.0 may operate as an internal production **read-only intelligence system**. It still may not perform production external mutations.

---

# 12. v2.0.0 — Approved Execution

## Release objective

> Execute only the external actions whose exact payloads were reviewed and approved, and preserve idempotent execution evidence.

## In scope

- `ActionProposal -> Approval -> Execution -> ExecutionReceipt` domain;
- risk classification and approval policy;
- immutable approved payload digest;
- separate Microsoft Graph mutation consent;
- reply/send/forward adapter;
- explicit read/unread, flag, category, move, and delete action types as individually policy-controlled capabilities;
- calendar/task/CRM/project action adapters selected by the owner;
- idempotency, retries, reconciliation, cancellation, and compensation where possible;
- final recipient/content/attachment/date/amount/commitment review;
- approval and execution audit surfaces;
- adversarial approval-bypass and duplicate-execution tests;
- canary rollout per adapter and action type.

## Explicitly out of scope

- fully autonomous customer communication;
- generic blanket approval;
- inferring approval from message view, correction, or prior accepted recommendation;
- enabling all adapters at once;
- public/team expansion without a separate access-control plan.

## PR graph

```text
PR-201 Proposal, approval, receipt domain
PR-202 Approval UI and approved-payload digest
PR-203 Execution engine and idempotency
PR-204 Microsoft Graph mutation adapter
PR-205 Calendar/task/CRM/project adapters, one at a time
PR-206 Retry/reconciliation/compensation
PR-207 Security, adversarial, and canary controls
PR-208 Controlled production acceptance
```

## Required evidence

- requirements: REQ-KNOW-015, REQ-ACT-002–008;
- no execute path without a valid approval for the exact payload digest;
- replay/retry produces one external effect;
- changed content invalidates prior approval;
- expired/rejected/revoked proposal cannot execute;
- external result is reconciled and receipted;
- canary action types can be individually disabled;
- manual live acceptance uses non-sensitive test recipients/systems before business use.

## Release gate

Only action types whose individual adapter gate passes may be enabled. Passing the mail-send gate does not automatically authorize calendar, delete, CRM, or other mutations.

---

# 13. Cross-release workstreams

## 13.1 Data and migration

Every release involving schema changes includes:

- forward migration;
- idempotent application;
- compatibility window;
- integrity check;
- backup before migration;
- rollback or restore path;
- migration report.

## 13.2 Evaluation dataset

Build and maintain a redacted/synthetic dataset containing:

- reference/no-action messages;
- mixed completed/urgent rework;
- one message linked to multiple projects;
- ambiguous new-project candidates;
- quoted-history duplicates;
- schedule changes and conflicts;
- amounts, quotes, orders, contracts;
- decisions and commitments;
- waiting/approval cases;
- missing/outdated attachments;
- technical incidents and security-sensitive content;
- Korean and English business mail;
- malicious prompt-injection content;
- provider failure/malformed output;
- user corrections and later similar mail.

Dataset changes are reviewed because changing expected outputs can hide regressions.

## 13.3 Domain profiles

Initial profile order:

1. generic business mail;
2. sales/quotation/order/contract;
3. project delivery;
4. Sangfor/infrastructure engineering;
5. accounting/administration;
6. security/incident.

A profile includes vocabulary, schemas, extraction examples, and evaluation cases. It never changes core approval or evidence policy.

## 13.4 Documentation and handover

Maintain:

- installation/run guide;
- configuration and privacy policy;
- migration guide;
- backup/restore runbook;
- troubleshooting and failure guide;
- data dictionary;
- model/policy registry guide;
- release notes and known limitations.

---

# 14. Release evidence package

Each release produces:

```text
release manifest
requirements-to-PR traceability
requirements-to-test traceability
test/evaluation summary
migration and rollback result
security and secret scan summary
backup/restore evidence when applicable
known limitations
operator decision: GO / CONDITIONAL GO / NO-GO
```

The evidence package is stored without real mail content, tokens, or customer-sensitive identifiers.

---

# 15. Stop conditions

Development stops and returns to the relevant earlier stage when:

- a source-of-truth contradiction is found;
- a mutation path bypasses approval policy;
- accepted knowledge loses evidence or revision history;
- migration cannot reconcile source counts/integrity;
- a correction or policy activation causes uncontrolled regressions;
- live mail content can reach an unapproved provider/destination;
- backup restore cannot reproduce a valid state;
- CI/evaluation gates are made non-blocking to force release;
- project/entity resolution corrupts canonical identity without reversible merge/split history;
- the implementation drifts toward an Outlook clone, CRM, autonomous sender, or vector-only memory.

Partial work remains behind feature flags or disabled adapters until the blocker is resolved and reverified.

---

# 16. First implementation batch after plan approval

Implementation begins with **v1.0.1**, in this order:

```text
1. capture baseline tests for current reproduced defects
2. add mutation kill switch and local-only listener
3. repair and schema-validate AI enrichment
4. remove automatic read mutation
5. label rules/model/fallback state in API and UI
6. establish API/session/CSRF/config security boundary
7. correct reference/no-action and recommendation behavior
8. separate generic core from Sangfor profile behavior
9. make CI blocking and disable production CD
10. remove duplicate legacy frontend files after parity verification
11. run adversarial and release-gate verification
```

No SQLite/project/work implementation starts until this batch passes the v1.0.1 gate.

---

# 17. Plan completion definition

The development plan itself is complete when:

- the owner accepts the product definition and release order;
- all required capabilities have stable requirement IDs;
- architecture decisions support those requirements;
- each release has explicit in-scope/out-of-scope boundaries;
- PR dependencies, migration, rollback, and verification are defined;
- no implementation claim is made before evidence exists;
- the next executable batch is unambiguous.
