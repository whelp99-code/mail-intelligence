# Mail Intelligence — Data and Architecture

**Document version:** 1.0
**Status:** TARGET ARCHITECTURE BASELINE
**Effective date:** 2026-08-28
**Depends on:** `00-PROJECT-DEFINITION.md`, `01-REQUIREMENTS.md`

---

## 1. Architecture objective

The architecture must turn a stream of untrusted mail content into a durable, evidence-backed, temporal work memory without allowing AI output or external actions to bypass source authority, review, or approval.

The target is a **local-first modular monolith** for a single user. It is intentionally not a distributed microservice system and does not require a graph database in the first operational releases.

```text
Microsoft Graph
      |
      v
Source Sync -> Normalization -> Extraction -> Entity Resolution
      |                                  |
      v                                  v
Raw/normalized mail store          Model/rule observations
      |                                  |
      +----------> Reconciliation <-------+
                         |
                         v
          Temporal Knowledge + Evidence
                         |
             +-----------+-----------+
             |                       |
             v                       v
    Intelligence projections     Review/corrections
             |                       |
             +-----------+-----------+
                         v
             Search / project / daily UI
                         |
              Action proposal boundary
                         |
                  Human approval
                         |
                 External adapters
```

---

## 2. Architectural decisions

### ADR-001 — SQLite is the first operational database

**Decision:** Use SQLite with versioned migrations as the initial authoritative store for normalized mail and derived knowledge.

**Rationale:**

- first deployment is single-user;
- simple backup and restore;
- no separate database service;
- transactional integrity;
- FTS5 support for local full-text retrieval;
- straightforward later migration to PostgreSQL.

**Constraints:**

- one application writer owns migrations and durable writes;
- use transactions and busy timeouts;
- enable WAL only on a supported local filesystem and verify backup behavior;
- never place the live database on an unsafe network filesystem without validation;
- large attachment binaries may remain referenced outside the database with checksum and metadata.

### ADR-002 — Relational temporal graph before a graph database

**Decision:** Represent entities and relationships using typed relational tables plus temporal edge/revision records.

**Rationale:** The required graph is moderate, highly structured, and needs transactions, migrations, provenance, and operational simplicity more than specialized graph traversal.

A graph database may be evaluated later only if measured query requirements justify it.

### ADR-003 — Outlook remains source authority

**Decision:** Outlook/Microsoft Graph remains authoritative for messages, threads, folders, and source mutation state. Local records are synchronized representations with source IDs and change cursors.

**Implication:** Local analysis may be rebuilt. Accepted user corrections, knowledge revisions, approval records, and execution receipts are authoritative in Mail Intelligence.

### ADR-004 — Observation is separate from accepted knowledge

**Decision:** Store rule/model extraction as observations. Reconciliation promotes, rejects, conflicts, or supersedes observations into knowledge revisions.

**Rationale:** A model response is not a fact merely because it is structured JSON.

### ADR-005 — Evidence is mandatory and addressable

**Decision:** Material claims reference exact evidence records tied to source message text, thread context, attachment metadata/content, or an explicit user correction.

**Rationale:** Trust, replay, correction, and temporal reconciliation require stable provenance.

### ADR-006 — Modular monolith with explicit ports

**Decision:** Split the current monolith into domain/application/adapters/infrastructure/API/UI modules while keeping one deployable service.

**Rationale:** It avoids premature distribution while enabling testability and later adapter replacement.

### ADR-007 — Read-only intelligence precedes external mutation

**Decision:** Mail synchronization and intelligence operate before production send/calendar/task/CRM mutation adapters are enabled.

**Rationale:** The primary product value and risk can be validated without external side effects.

### ADR-008 — Integration uses an outbox

**Decision:** Accepted events and later approved actions are persisted before delivery through external adapters. Delivery is idempotent and retryable.

**Rationale:** Network failure must not lose, duplicate, or falsely report external work.

### ADR-009 — Core and domain profiles are separate

**Decision:** Generic extraction and knowledge contracts remain independent from Sangfor, sales, accounting, project, or security profiles.

**Rationale:** Domain knowledge enriches behavior but must not distort generic mail handling or source authority.

### ADR-010 — Structured retrieval is authoritative; FTS/vector are aids

**Decision:** Use structured queries and temporal projections for factual project/work state. Use SQLite FTS5 and optional embeddings to locate candidate evidence and similar material.

**Rationale:** Similarity search cannot by itself establish identity, current validity, or factual truth.

---

## 3. Target module structure

The exact filenames may evolve, but responsibilities must remain separated.

```text
src/
├── domain/
│   ├── mail/
│   ├── identity/
│   ├── project/
│   ├── work/
│   ├── knowledge/
│   ├── evidence/
│   ├── review/
│   └── action/
├── application/
│   ├── sync-mail/
│   ├── analyze-mail/
│   ├── resolve-entities/
│   ├── reconcile-knowledge/
│   ├── project-intelligence/
│   ├── review-corrections/
│   ├── query-intelligence/
│   └── execute-approved-action/
├── adapters/
│   ├── microsoft-graph/
│   ├── ai/
│   ├── domain-profiles/
│   ├── crm/
│   ├── project-system/
│   ├── calendar/
│   └── data-plane/
├── infrastructure/
│   ├── db/
│   ├── migrations/
│   ├── jobs/
│   ├── outbox/
│   ├── secrets/
│   ├── logging/
│   ├── backup/
│   └── config/
├── api/
│   ├── read/
│   ├── review/
│   ├── admin/
│   └── actions/
└── ui/
    ├── daily/
    ├── projects/
    ├── work/
    ├── search/
    ├── review/
    └── operations/
```

The existing static UI can be migrated incrementally. A framework rewrite is not required for the data and domain redesign.

---

## 4. Canonical data model

### 4.1 Source and synchronization

#### `mail_accounts`

- `id` — local stable UUID;
- `provider` — initially `microsoft_graph`;
- `provider_account_id`;
- `display_name`;
- `primary_address`;
- `status`;
- `created_at`, `updated_at`.

Secrets and refresh tokens are not stored as ordinary columns in this table.

#### `mail_folders`

- source folder ID;
- account ID;
- parent folder ID;
- display name;
- include/exclude policy;
- last observed timestamps.

#### `sync_cursors`

- account/folder scope;
- delta link or provider cursor;
- checkpoint state;
- last success/failure;
- retry and stale state;
- schema/version metadata.

#### `mail_threads`

- local thread ID;
- provider conversation ID;
- normalized subject;
- first/last message timestamps;
- participant projection;
- latest source revision.

#### `mail_messages`

- local ID and source message ID;
- account, folder, thread;
- immutable internet/source IDs when available;
- subject, sender, timestamps, importance;
- normalized text and content checksum;
- current source state (`is_read`, deleted/moved tombstone, change key);
- ingestion and normalization versions;
- created/updated/source-observed timestamps.

#### `message_participants`

- message ID;
- role (`from`, `sender`, `to`, `cc`, `bcc`, `reply_to`);
- address and display name;
- resolved person/organization candidate.

#### `attachments`

- source attachment ID;
- message ID;
- name, MIME type, size;
- inline/reference flags;
- checksum when content is retained;
- local content reference and scan/extraction state;
- document/entity links.

### 4.2 Identity and canonical entities

#### `entities`

A shared identity envelope:

- `id`;
- `entity_type` (`person`, `organization`, `project`, `product`, `document`, etc.);
- `canonical_name`;
- `lifecycle_status`;
- `created_at`, `updated_at`.

Subtype tables may hold specialized fields.

#### `entity_aliases`

- entity ID;
- normalized alias;
- alias type (`name`, `email`, `domain`, `project_code`, `subject_token`, `user_defined`);
- source/evidence;
- status (`candidate`, `confirmed`, `rejected`, `superseded`);
- confidence;
- policy version;
- effective period.

#### `people`

- entity ID;
- known email addresses;
- organization relations;
- stated role/title with evidence;
- communication metadata limited to business use.

#### `organizations`

- entity ID;
- domains and aliases;
- parent/partner/customer relations;
- externally confirmed master IDs when linked.

#### `projects`

- entity ID;
- canonical project name/code;
- customer/organizations;
- phase/status projection;
- owner and participants;
- current summary projection;
- start/end candidates;
- external system link status.

#### `products`

- entity ID;
- vendor, family, model/version aliases;
- domain-profile ownership.

### 4.3 Evidence, observations, claims, and revisions

#### `evidence_items`

- `id`;
- source type and source record ID;
- source revision/checksum;
- text span offsets or structured field path;
- normalized excerpt suitable for UI;
- attachment/page/section locator when available;
- created time;
- redaction policy.

Evidence records are immutable. A changed source creates a new evidence record.

#### `analysis_runs`

- input set and digests;
- pipeline version;
- rule/model/provider identifiers;
- prompt/schema/domain-profile versions;
- start/end, token/cost/latency where applicable;
- success, partial, or failure state;
- redacted error information.

#### `observations`

- observation type and normalized value;
- subject entity/source;
- confidence;
- analysis run;
- evidence links;
- candidate status;
- validation errors or warnings.

#### `knowledge_claims`

A stable logical claim, such as “Project X delivery date” or “Work item Y owner.”

- claim ID;
- subject entity;
- predicate/type;
- current accepted revision ID;
- lifecycle/conflict state.

#### `knowledge_revisions`

- claim ID;
- normalized value and value type;
- authority (`user_confirmed`, `external_master`, `verified_outcome`, `rule`, `model`, `similarity`);
- status (`candidate`, `accepted`, `rejected`, `superseded`, `conflicted`);
- confidence/calibration version;
- valid/effective time range;
- recorded time;
- supersedes/superseded-by relation;
- actor or analysis run;
- evidence links.

This bitemporal-style separation enables “what did we know then?” and “what is effective now?” queries without requiring a full event-sourcing framework.

### 4.4 Projects, work, decisions, commitments, schedules, and risks

#### `message_project_links`

- message/thread ID;
- project ID or candidate project ID;
- role (`primary`, `related`, `evidence_only`);
- status and confidence;
- signals and evidence;
- confirmation/correction history.

#### `work_items`

- stable work ID;
- title/normalized intent;
- project relations;
- requester and owner candidates;
- processing stage;
- work status;
- current due/follow-up projection;
- completion condition;
- source and current revision.

#### `work_item_revisions`

- changed fields and value revisions;
- effective/recorded times;
- evidence and authority;
- blocker/dependency relations;
- completion/cancellation/supersession reason.

#### `decisions`

- subject/project;
- decision statement;
- decision maker and participants;
- conditions and alternatives when stated;
- status and validity;
- evidence and revisions.

#### `commitments`

- promisor and beneficiary;
- promised action/result;
- due date;
- status;
- related work/project;
- fulfillment or breach evidence.

#### `schedules`

- event/deadline type;
- start/end/due values;
- timezone and precision;
- status (`candidate`, `confirmed`, `changed`, `cancelled`);
- project/work links;
- revision history.

#### `issues` and `risks`

- category, severity, status;
- project/work relations;
- owner;
- mitigation/action candidates;
- evidence and revisions.

### 4.5 Classification, correction, policy, and evaluation

#### `classifications`

- target record;
- processing stage, work status, and detected signals;
- method, confidence, evidence;
- active policy/model versions;
- accepted/rejected state.

#### `corrections`

- target type and ID;
- previous and corrected value;
- correction reason;
- actor and time;
- affected policy/alias candidates;
- replay inclusion state.

#### `policy_versions`

- policy type (`alias`, `classification`, `routing`, `confidence`, `domain_profile`, `prompt`);
- immutable version and digest;
- status (`draft`, `evaluated`, `active`, `retired`);
- author/approver;
- evaluation report reference.

#### `evaluation_cases` and `evaluation_runs`

- redacted/synthetic input fixture;
- expected structured outcome;
- case tags and risk class;
- policy/model configuration;
- metrics, regressions, and artifacts.

### 4.6 Review and action boundary

#### `review_items`

- review type (`project_link`, `entity_merge`, `claim_conflict`, `work_candidate`, etc.);
- target IDs;
- reason and priority;
- evidence summary;
- status and resolution.

#### `action_proposals`

- action type;
- source project/work/mail context;
- proposed payload;
- payload digest;
- risk classification;
- expiry and status.

#### `approvals`

- proposal ID;
- approver;
- decision;
- approved digest;
- time and optional conditions.

#### `execution_receipts`

- proposal/approval;
- adapter;
- idempotency key;
- requested and actual payload digests;
- external ID;
- status, timestamps, response summary, retry/compensation state.

#### `outbox_events`

- persisted event/payload;
- destination adapter;
- idempotency key;
- delivery attempts, next attempt, dead-letter state.

#### `audit_events`

- actor/system;
- event type;
- target;
- redacted metadata;
- timestamp and correlation ID.

---

## 5. Authority and reconciliation model

### 5.1 Authority order

Default authority from highest to lowest:

```text
explicit user confirmation/correction
> confirmed external master-system value
> verified execution outcome
> deterministic source field or approved rule
> model extraction with direct evidence
> similarity-only suggestion
```

Authority is predicate-specific. For example, Outlook is authoritative for source read state, while a user correction is authoritative for the local project link.

### 5.2 Reconciliation result

Every observation becomes one of:

- `candidate` — plausible, not accepted;
- `accepted` — current knowledge;
- `rejected` — explicitly invalid;
- `duplicate` — same semantic value and evidence lineage;
- `superseding` — newer effective information replaces current state;
- `conflicting` — incompatible information without sufficient authority to select;
- `unknown` — insufficient evidence.

### 5.3 Conflict example

```text
Current accepted schedule: 2026-09-10, confirmed by user
New mail observation: “tentatively 2026-09-12”, model confidence 0.84

Result:
- retain 2026-09-10 as current accepted value;
- create candidate revision for 2026-09-12;
- mark schedule conflict/review required;
- show both evidence items and authority difference.
```

No lower-authority observation silently overwrites a confirmed value.

---

## 6. Project classification pipeline

### 6.1 Candidate generation

Generate candidate projects using independent signals:

- confirmed participant/project history;
- organization/customer relation;
- canonical project name or approved alias;
- subject/thread tokens;
- product and document references;
- project code, quotation/order number, contract identifier;
- schedule and participant overlap;
- prior confirmed message/thread links;
- semantic similarity as a recall aid.

### 6.2 Candidate scoring

The scoring contract is versioned. It must retain contributing signals rather than only a final number.

Illustrative components:

```text
confirmed alias match                    high weight
confirmed participant + organization     high weight
thread already linked                    high weight
project/document identifier              high weight
multiple corroborating weak signals      medium weight
semantic similarity only                 low weight
contradictory organization/schedule       negative weight
```

Thresholds are calibrated from evaluation data. They are not permanently hard-coded from guesswork.

### 6.3 Decision outcomes

- high-confidence link to an existing confirmed project may be automatically proposed or linked according to active policy;
- ambiguous multi-project matches enter review;
- weak new-project signals create a project candidate, not a canonical project;
- zero-action/reference mail may remain unlinked except as contextual evidence;
- one message/thread may have multiple links with different roles.

### 6.4 Corrections

A user can:

- confirm/reject a link;
- select another project;
- create/merge/split a project;
- approve an alias;
- mark a message unrelated/reference-only;
- trigger affected-knowledge re-evaluation.

The correction does not directly mutate a hidden model. It creates versioned learning input and policy candidates.

---

## 7. Work-item extraction and lifecycle

### 7.1 Candidate creation

A work-item candidate requires:

- actionable intent or explicit request/commitment;
- source evidence;
- project/thread context;
- requester or origin;
- status and due/precision when available;
- deduplication key derived from normalized intent, project, participants, and source lineage.

### 7.2 Avoiding quoted-history duplicates

Before creating a new work candidate:

1. identify quoted/repeated thread content;
2. compare semantic intent and source lineage;
3. check an existing open/completed/superseded work item;
4. create a revision or relation rather than a duplicate when appropriate.

### 7.3 Lifecycle

```text
candidate
-> reviewed/confirmed
-> active or waiting
-> completed, cancelled, dismissed, or superseded
```

Processing stage and work status remain separate. A completed work item may still have a later review stage if contradictory mail arrives.

---

## 8. Continuous-improvement architecture

### 8.1 What is learned

- aliases and canonical identities;
- project-link feature weights/thresholds;
- status/signal classification examples;
- sender/organization-specific business patterns;
- confidence calibration;
- domain-profile vocabulary and extraction cases;
- accepted recommendation and execution outcomes.

### 8.2 What is not learned automatically

- unrestricted prompts;
- external action permissions;
- secret destinations;
- facts lacking evidence;
- approval policy;
- arbitrary model-generated rules;
- hidden personal profiling.

### 8.3 Promotion flow

```text
correction/outcome captured
-> candidate alias/policy/example created
-> affected replay set selected
-> evaluation run
-> regression and safety checks
-> user/operator approval where required
-> immutable policy version activated
-> affected knowledge queued for bounded re-evaluation
```

### 8.4 Improvement metrics

Track by case type and domain profile:

- correction recurrence;
- project-link precision/acceptance;
- work extraction precision/recall;
- entity merge/split error;
- evidence coverage;
- unsupported claim rate;
- confidence calibration error;
- regression count;
- accepted/rejected recommendation outcomes.

A new model is not “better” until it improves the controlled evaluation without violating safety or evidence gates.

---

## 9. Retrieval architecture

### 9.1 Query order

For project/work questions:

1. resolve canonical entity/project/work IDs;
2. query accepted current knowledge and temporal revisions;
3. identify conflicts and unknowns;
4. retrieve linked evidence and source excerpts;
5. retrieve additional source material using FTS and, optionally, semantic search;
6. generate a bounded answer from the selected records;
7. return citations, confidence, and data freshness.

### 9.2 Full-text search

Use FTS5 for:

- normalized message text;
- attachment extracted text where permitted;
- project/work summaries;
- names, aliases, identifiers, and document references.

### 9.3 Semantic retrieval

Embeddings may assist:

- candidate project discovery;
- related thread/document discovery;
- correction-example retrieval;
- evidence expansion.

Embeddings must include model/version and content digest. A vector match alone cannot become accepted knowledge.

### 9.4 Answer contract

An answer contains:

- concise answer/current state;
- relevant recent changes;
- evidence references;
- conflict/unknown section;
- freshness/sync state;
- optional next-action proposal;
- no unsupported commitment or external execution.

---

## 10. AI provider contract

The AI adapter accepts a bounded analysis request and returns a schema-validated observation envelope.

Required request metadata:

- input message/thread IDs and content digests;
- allowed task/schema;
- domain profile;
- data-sharing/redaction policy;
- model route and timeout budget;
- prompt/schema versions.

Required response metadata:

- provider/model exact identifier;
- structured observations;
- evidence locators;
- confidence by observation;
- warnings/uncertainty;
- token/cost/latency when available;
- raw response reference retained only according to policy;
- validation result.

Provider failure produces a visible failed/partial analysis run. A rule fallback is a separate labeled run, not a hidden continuation.

---

## 11. Job and transaction model

### 11.1 Job types

- baseline sync page;
- delta sync;
- normalization;
- attachment metadata/content extraction;
- rule/model analysis;
- entity resolution;
- reconciliation;
- projection refresh;
- re-evaluation after correction/policy change;
- outbox delivery;
- backup/integrity verification;
- evaluation replay.

### 11.2 Idempotency

Each job has a deterministic key based on job type, source ID/revision, and pipeline/policy version. Completed results are reused unless explicitly invalidated.

### 11.3 Transaction boundary

A transaction should atomically record:

- source revision/checkpoint as appropriate;
- normalized record changes;
- created observations or knowledge revisions;
- affected projection invalidation;
- audit/outbox event.

External network calls are not held inside a long database transaction. Results are reconciled after the call.

### 11.4 Failure states

Failures are persisted with:

- stage;
- source/job ID;
- redacted reason;
- attempt count;
- retry time;
- terminal/dead-letter/review state;
- operator guidance.

---

## 12. API boundary

### 12.1 Read APIs

Examples:

```text
GET /api/v1/sync/status
GET /api/v1/daily
GET /api/v1/projects
GET /api/v1/projects/:id
GET /api/v1/projects/:id/timeline
GET /api/v1/work-items
GET /api/v1/messages/:id/intelligence
GET /api/v1/evidence/:id
POST /api/v1/query
```

### 12.2 Review/correction APIs

```text
GET  /api/v1/review
POST /api/v1/review/:id/confirm
POST /api/v1/review/:id/reject
POST /api/v1/messages/:id/project-links
POST /api/v1/entities/:id/aliases
POST /api/v1/claims/:id/corrections
POST /api/v1/projects/merge
POST /api/v1/projects/split
```

All changes require authenticated local session, CSRF protection, validation, and audit events.

### 12.3 Action APIs — disabled until 2.0 gate

```text
POST /api/v1/action-proposals
POST /api/v1/action-proposals/:id/approve
POST /api/v1/action-proposals/:id/reject
POST /api/v1/action-proposals/:id/execute
GET  /api/v1/execution-receipts/:id
```

The execute endpoint verifies the approved payload digest and idempotency key. It cannot accept arbitrary content that differs from the approval.

---

## 13. Security boundaries

1. Default listener is `127.0.0.1`.
2. OAuth read and later mutation scopes are separated.
3. Tokens are kept in an approved secret mechanism, not returned by status/config APIs.
4. State-changing APIs require authenticated session and CSRF protection.
5. Mail HTML is never rendered unsanitized.
6. Message and attachment content are untrusted; they cannot issue tool commands.
7. External model use follows explicit mailbox/domain data-sharing policy.
8. Outbound destinations are configured and allowlisted.
9. Logs, evaluation fixtures, and release artifacts are redacted.
10. Backups are permission-restricted and excluded from source control.
11. Domain-profile instructions cannot relax core security or approval policy.
12. Action adapters remain unavailable until the release gate enables them.

---

## 14. Legacy migration plan

### 14.1 Inputs

Potential legacy inputs:

- `.mail-cache.json` messages, analysis results, and feedback;
- `.outlook-config.json` non-secret and secret configuration;
- current rule classifications;
- existing frontend behavior and user terminology.

### 14.2 Migration flow

```text
1. Snapshot and hash legacy files
2. Create empty versioned SQLite database
3. Import messages into staging tables
4. Normalize source IDs and mailbox scope
5. Import feedback as explicit corrections
6. Import old analysis only as legacy observations, never accepted facts
7. Deduplicate and validate counts/checksums
8. Build initial projections
9. Produce migration report
10. Keep legacy files read-only for rollback until acceptance
11. Remove/secure obsolete secret file after operator approval
```

### 14.3 Migration acceptance

- source message count reconciled;
- duplicate and rejected records listed;
- all imported feedback traceable;
- no secret appears in report/log;
- database integrity check passes;
- re-running import is idempotent;
- rollback to legacy prototype remains documented during the migration window.

---

## 15. PostgreSQL transition boundary

PostgreSQL is considered when measured requirements include:

- multiple concurrent users/writers;
- shared review queues and RBAC;
- remote service deployment;
- operational scale beyond validated SQLite behavior;
- external reporting or integration concurrency.

The transition requires:

- repository interface compatibility;
- migration/reconciliation plan;
- backup/restore and rollback rehearsal;
- transaction/isolation validation;
- no change to canonical entity, evidence, authority, or approval semantics.

---

## 16. Architecture risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| RISK-ARCH-001 | Mail volume or attachments exceed initial assumptions | slow sync/storage growth | measurement gate, pagination, retention, metadata-first attachment policy |
| RISK-ARCH-002 | Entity/project resolution merges unrelated work | corrupt project memory | candidate state, evidence, confidence, merge/split history, replay evaluation |
| RISK-ARCH-003 | Model output fabricates or misattributes facts | loss of trust | schema validation, evidence requirement, observation/knowledge separation |
| RISK-ARCH-004 | Temporal updates overwrite history | incorrect current state and no audit | revision model, authority order, conflict state |
| RISK-ARCH-005 | Correction causes broad regression | repeated misclassification | versioned policies, bounded impact graph, replay before activation |
| RISK-ARCH-006 | SQLite misuse causes lock/corruption | data loss | single writer, transactions, supported filesystem, backup/restore drills |
| RISK-ARCH-007 | External model leaks sensitive mail | privacy breach | explicit policy, redaction, local-only route, audit |
| RISK-ARCH-008 | Integration retries duplicate actions | external business incident | persisted proposal/approval, outbox, idempotency, receipt reconciliation |
| RISK-ARCH-009 | Domain profile contaminates core | poor generalization | adapter boundary and core conformance tests |
| RISK-ARCH-010 | Monolith refactor becomes rewrite stall | no operational value delivered | vertical slices, compatibility adapters, release gates, preserve usable UI |

---

## 17. Architecture completion criteria

The target architecture is considered implemented only when:

- authoritative records reside in the migrated database;
- source synchronization is resumable and idempotent;
- observations and accepted knowledge are separated;
- evidence and temporal revisions are queryable;
- project/work classification is reviewable and correction-aware;
- policy/model versions are replayable;
- daily/project/search views use the canonical projections;
- backup/restore and migration tests pass;
- external mutation remains behind the approval contract;
- release-gate evidence confirms behavior under failure and adversarial cases.
