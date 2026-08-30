# Mail Intelligence — Test, Evaluation, and Release Gates

**Document version:** 1.0
**Status:** RELEASE-GATE BASELINE
**Effective date:** 2026-08-28
**Depends on:** `00-PROJECT-DEFINITION.md`, `01-REQUIREMENTS.md`, `02-DATA-AND-ARCHITECTURE.md`, `03-DEVELOPMENT-PLAN.md`

---

## 1. Verification principle

Mail Intelligence handles private mail, business facts, project memory, and eventually external actions. A successful demo or green syntax check is not sufficient evidence of completion.

The proof chain is:

```text
requirement
-> implementation
-> deterministic test or controlled live evidence
-> adversarial/negative validation
-> migration/recovery validation
-> release decision
```

A release is `GO` only when all mandatory gates pass. A known failure is not converted into success by making a check non-blocking.

---

## 2. Test layers

### 2.1 Static and build verification

Required as applicable:

- Node syntax/type validation;
- lint and formatting policy;
- HTML/CSS validation;
- dependency and license scan;
- secret scan;
- migration/schema validation;
- release package manifest and file allowlist;
- generated artifact contains no runtime database, real mail, token, or secret.

### 2.2 Unit tests

Unit tests cover deterministic domain behavior:

- status/signal classification;
- no-action/reference detection;
- date/amount/identifier normalization;
- evidence span creation;
- entity alias normalization;
- project candidate scoring inputs;
- work-item deduplication keys;
- authority and reconciliation decisions;
- temporal revision selection;
- policy version/digest handling;
- idempotency key generation;
- approved-payload digest validation;
- content sanitization and prompt-injection flags.

### 2.3 Contract tests

Contract tests cover boundaries:

- Microsoft Graph source adapter with recorded/synthetic HTTP fixtures;
- AI provider request/response envelope;
- schema validation of model output;
- domain-profile conformance;
- storage repositories and transaction behavior;
- backup/restore command contract;
- external linking adapter;
- later, action adapter and execution receipt.

External services are not required for the majority of contract tests.

### 2.4 Integration tests

Integration tests run real application modules with a temporary database:

- baseline and delta synchronization;
- message/thread/participant/attachment normalization;
- analysis -> observation -> reconciliation -> projection;
- correction -> policy candidate -> replay -> activation;
- migration and legacy import;
- review queue resolution;
- outbox delivery and retry;
- API authentication, CSRF, validation, and audit events;
- later, proposal -> approval -> execution -> receipt.

### 2.5 Replay evaluation

Replay evaluation uses a fixed, versioned dataset to measure intelligence behavior. It is separate from ordinary unit tests because quality must be measured across cases rather than only exact code branches.

### 2.6 UI and end-to-end tests

Critical user journeys:

- connect/read-only setup;
- baseline sync and progress;
- inspect a message and evidence without changing Outlook source state;
- review project candidate;
- correct project/status/entity/work item;
- inspect project current state and timeline;
- ask an evidence-backed question;
- view sync/model/fallback/conflict failure;
- backup and restore operator flow;
- later, review and execute an exact approved action.

### 2.7 Security tests

- non-local listener denied by default;
- unauthorized API request denied;
- CSRF and cross-origin state change denied;
- secret values absent from status, logs, errors, fixtures, release artifacts, and prompts;
- malicious mail HTML sanitized;
- mail/prompt injection cannot invoke tools or change policy;
- external model and webhook destination allowlist enforced;
- path traversal and unsafe attachment handling denied;
- approval bypass and payload substitution denied;
- expired/rejected approval denied;
- duplicate execution prevented.

### 2.8 Operational tests

- process restart and resume;
- database busy/interrupted transaction behavior;
- source API timeout/throttle/retry;
- model timeout/malformed output/fallback;
- outbox retry and dead-letter;
- backup creation and age reporting;
- clean restore to a separate location;
- migration failure and rollback/restore;
- disk-space warning and graceful failure;
- stale sync detection;
- release package fresh install.

---

## 3. Evaluation dataset

### 3.1 Dataset policy

The canonical dataset uses synthetic or irreversibly redacted business mail. It must not contain real tokens, secrets, unapproved personal data, or confidential customer text.

Dataset versions are immutable after release use. Corrections to expected results create a new dataset version with a documented reason.

### 3.2 Required case families

| Tag | Required behavior |
|---|---|
| `reference` | newsletters, FYI, announcements, and “no reply required” do not create forced work |
| `mixed-status` | “previously completed but urgent rework requested” is not classified as done only |
| `multi-project` | one mail/thread can link to more than one project with different roles |
| `ambiguous-project` | weak competing project matches enter review rather than automatic canonical assignment |
| `new-project-candidate` | multiple corroborating signals create a candidate, not an unreviewed project |
| `quoted-history` | repeated quoted requests do not create duplicate work items |
| `thread-update` | later replies update or complete prior work rather than creating unrelated work |
| `schedule-change` | tentative, confirmed, changed, and cancelled dates create temporal revisions |
| `schedule-conflict` | incompatible dates remain visible with evidence and authority |
| `decision` | stated decisions and later amendments are distinguished from suggestions |
| `commitment` | promises, due dates, and fulfillment evidence are linked |
| `amount` | amounts, currencies, quotes, orders, and contracts retain context and uncertainty |
| `waiting` | approval/reply/data waiting is separated from work owner state |
| `attachment` | missing, outdated, replaced, and related attachment candidates are handled |
| `incident` | technical incident and security-risk signals receive appropriate review priority |
| `alias` | company/project/person aliases resolve only under evidence-backed rules |
| `correction` | explicit correction changes accepted projection and later similar classification |
| `conflicting-correction` | lower-authority model output cannot overwrite a confirmed correction |
| `provider-failure` | timeout, malformed JSON, wrong schema, partial response, and route fallback are visible |
| `prompt-injection` | mail content cannot instruct the system to reveal secrets, call tools, or bypass approval |
| `bilingual` | Korean and English business expressions are handled or marked uncertain |
| `deletion-move` | Graph move/delete/read-state source changes reconcile without duplicate records |
| `idempotency` | repeated sync/import/job/action produces one authoritative result |

### 3.3 Dataset split

- **development set:** visible during implementation;
- **release set:** fixed cases used by CI/release gate;
- **holdout set:** maintained separately for periodic quality checks;
- **live acceptance set:** owner-selected non-sensitive or explicitly approved mail scenarios.

Do not tune expected outputs against the holdout or live acceptance set during the same evaluation cycle.

---

## 4. Intelligence quality metrics

### 4.1 Evidence and factuality

| Metric | Gate |
|---|---:|
| accepted material claims with at least one valid evidence reference | 100% |
| accepted claim whose evidence does not support the normalized value | 0 critical cases |
| unsupported generated factual statement in release-set answers | 0 critical cases |
| conflict/unknown incorrectly presented as confirmed fact | 0 cases |
| source/freshness indicator present for evidence-backed answer | 100% |

### 4.2 Project and entity linking

Initial release thresholds for the fixed release set:

| Metric | v1.2 gate |
|---|---:|
| precision of automatically accepted existing-project links | >= 0.95 |
| recall of project candidates, including review candidates | >= 0.85 |
| weak/ambiguous new-project candidate auto-promoted to canonical project | 0 |
| incorrect entity merge without reversible review state | 0 |
| multi-project case retaining all expected relevant links | >= 0.90 case recall |

An implementation may choose to send more cases to review to protect precision. Review volume is measured separately.

### 4.3 Work and signal extraction

| Metric | v1.2 gate |
|---|---:|
| actionable work-item precision | >= 0.90 |
| actionable work-item recall | >= 0.80 |
| duplicate authoritative work items from quoted/thread repetition | 0 in release set |
| reference/no-action false-positive rate | <= 0.10 |
| critical deadline/commitment miss rate | 0 in critical release cases |
| processing-stage/work-status/signal dimension collapse | 0 schema violations |

### 4.4 Continuous improvement

| Metric | v1.3 gate |
|---|---:|
| corrected-case recurrence reduction on designated similar-case set | >= 50% relative reduction |
| overall critical regression count after policy activation | 0 |
| overall project/work quality decrease | no metric decreases by more than 2 percentage points without owner-approved tradeoff |
| policy/model/prompt/alias version reproducibility | 100% of release runs |
| lower-authority overwrite of confirmed correction | 0 |
| uncontrolled full-corpus re-evaluation when bounded impact is expected | 0 |

These thresholds can change only through an explicit decision with dataset evidence. Lowering a threshold merely to pass a release is not acceptable.

### 4.5 Confidence calibration

Track reliability by confidence bucket. High-confidence accepted behavior must have higher observed correctness than medium/low confidence. Until enough cases exist for a statistically useful calibration, the UI must use conservative qualitative labels and avoid pretending precision.

---

## 5. Performance and capacity gates

Performance targets are measured against the actual pilot dataset after `UNKNOWN-002` is resolved.

Initial single-user targets, excluding external model latency:

| Operation | Provisional target |
|---|---:|
| open daily intelligence projection | p95 <= 1 second |
| open cached project intelligence page | p95 <= 1 second |
| structured/FTS search | p95 <= 2 seconds |
| apply correction and refresh affected projection | p95 <= 2 seconds for ordinary impact scope |
| local API health/status | p95 <= 250 ms |
| resume interrupted sync | no full restart required unless cursor invalidation is reported |

For model-backed analysis, the UI must expose progress/queued/failed state rather than block without feedback. Timeout budgets and throughput are measured per provider and mailbox volume.

Capacity evidence records:

- total messages/threads/attachments;
- average and p95 daily changes;
- database size and growth;
- sync duration and API throttling;
- analysis backlog;
- query latency;
- backup size/duration and restore duration.

If measured capacity invalidates SQLite assumptions, a PostgreSQL decision is made before team expansion; this is not guessed in advance.

---

## 6. CI policy

### 6.1 Required blocking behavior

A required step exits non-zero on failure. The following patterns are forbidden for release-gate checks:

```text
|| true
continue-on-error: true
ignored curl/health failure
manual claim without an artifact or command result
```

Non-blocking informational checks must be labeled informational and cannot satisfy a requirement.

### 6.2 Planned CI stages

```text
static
  - syntax/type/lint/format
  - HTML/CSS validation
  - secret/dependency/license scan

unit
  - domain and policy tests

integration
  - temporary SQLite
  - API/security
  - source/model fixtures

migration
  - fresh database
  - upgrade from previous release fixture
  - legacy import
  - integrity/rollback or restore

replay-evaluation
  - pinned dataset and policies
  - metrics and regression report

package
  - allowlisted files only
  - manifest/checksum
  - fresh extract/install/health

release-gate
  - required evidence present
  - no unresolved critical blocker
```

Live Outlook tests use a separately controlled workflow and credentials; they are not run against production mail on every PR.

---

## 7. v1.0.1 release gate — Safety and Correctness Recovery

### ACCEPT-101 — Read-only mutation boundary

- production send/reply/forward unavailable;
- display/select does not mark mail read;
- read/unread, move, delete, flag, category, calendar, task, CRM, project, and Data Plane mutation paths disabled;
- negative API tests prove bypass attempts fail;
- Graph consent uses read scope only for this stage.

### ACCEPT-102 — AI analysis correctness

- valid provider responses parse and pass schema validation;
- malformed JSON/wrong schema/timeout/connection failure generate visible failed analysis runs;
- fallback is separately labeled with actual provider/model;
- cache key uses exact provider/model/pipeline version;
- undefined-variable regression tests pass;
- no result claims AI enhancement when only rules ran.

### ACCEPT-103 — Classification truthfulness

- mixed completed/urgent rework case does not become done-only;
- reference/no-action cases do not receive forced reply work;
- one primary recommendation is the default;
- Sangfor-specific suggestions appear only through an enabled profile;
- evidence/confidence/failure state appears in the contract and UI.

### ACCEPT-104 — Local/API security

- service binds to `127.0.0.1` by default;
- unauthorized/cross-origin/CSRF state changes fail;
- request sizes and schemas are bounded;
- tokens/secrets absent from API status/logs/errors/test artifacts;
- malicious HTML and prompt-injection fixtures cannot execute or relax policy.

### ACCEPT-105 — Engineering gate

- fresh dependency install succeeds;
- syntax, lint, unit, API, HTML, CSS, security, and health checks pass;
- no required CI step is non-blocking;
- automatic production deployment is disabled;
- release package fresh-extract test passes;
- duplicate frontend cleanup is parity-verified;
- repository remains free of real secrets/mail data.

**Decision:** All ACCEPT-101 through ACCEPT-105 are mandatory. Otherwise `NO-GO` for v1.1 implementation.

---

## 8. v1.1.0 release gate — Persistent Mail Memory

### ACCEPT-111 — Database and migration

- clean database migration succeeds;
- upgrade from the prior supported schema succeeds;
- schema version and migration history are recorded;
- database integrity check passes;
- interrupted transaction tests leave no partial authoritative state.

### ACCEPT-112 — Legacy import

- source message and feedback counts reconcile;
- legacy feedback imports as corrections;
- legacy model analysis imports only as observations;
- duplicate/rejected rows are listed in a migration report;
- re-running import is idempotent;
- no secret appears in report/log.

### ACCEPT-113 — Source synchronization

- baseline pagination ingests the fixture corpus completely;
- delta tests cover create, update, move, read-state change, and deletion;
- cursor/checkpoint resumes after interruption;
- repeated page/delta delivery creates no duplicate source records;
- stale/invalid cursor produces a controlled recovery state;
- live delegated Outlook pilot passes with explicitly approved account/folder scope.

### ACCEPT-114 — Evidence foundation

- accepted/source-derived fields trace to source records;
- source revision/checksum changes create new evidence lineage;
- quoted/thread boundaries are preserved sufficiently for later deduplication;
- attachment metadata is stored without unsafe automatic execution.

### ACCEPT-115 — Operations and recovery

- health endpoint verifies process, database, migration, sync, and job state;
- structured logs are redacted;
- bounded retry/dead-letter behavior passes;
- backup is created with restricted permissions;
- restore into a clean location passes integrity and record reconciliation;
- release manifest includes commit, schema, policy versions, tests, and limitations.

**Decision:** All mandatory acceptance items pass before the database replaces legacy JSON as authoritative storage.

---

## 9. v1.2.0 release gate — Project and Work Intelligence

### ACCEPT-121 — Observation and evidence

- every material observation has evidence or is explicitly marked unsupported/unknown;
- model output is candidate observation, not accepted fact;
- fact/inference/recommendation/correction/outcome types remain distinct.

### ACCEPT-122 — Project/entity quality

- metrics in section 4.2 pass;
- zero, one, and multiple project links work;
- ambiguous cases enter review;
- merge/split/reassignment is reversible and audited;
- alias acceptance/rejection affects later candidates without rewriting source mail.

### ACCEPT-123 — Work intelligence quality

- metrics in section 4.3 pass;
- quoted history creates no duplicate authoritative work;
- requester/owner/due/blocker/completion fields retain uncertainty when absent;
- decision, commitment, schedule, issue, and risk candidates remain source-linked.

### ACCEPT-124 — Review and correction

- user can confirm/reject/reassign/merge/split/reference-only;
- accepted projection updates immediately;
- prior observation and correction reason remain available;
- review actions are authenticated, validated, and audited.

### ACCEPT-125 — Domain isolation

- generic cases pass with all profiles disabled;
- enabling Sangfor/sales/project profiles adds allowed fields/vocabulary only;
- a profile cannot alter source authority, evidence requirement, or mutation policy.

**Decision:** Intelligence pilot is `GO` only if critical unsupported-fact, auto-merge, and weak-project-promotion counts are zero.

---

## 10. v1.3.0 release gate — Temporal Learning

### ACCEPT-131 — Temporal revisions

- current and historical values can be queried;
- effective and recorded timestamps are retained;
- supersession does not delete prior evidence;
- schedule/project/work changes produce understandable timelines.

### ACCEPT-132 — Authority and conflict

- confirmed values resist lower-authority overwrite;
- incompatible claims create visible conflict/review state;
- unknowns remain unknown;
- duplicate observations do not create duplicate accepted revisions.

### ACCEPT-133 — Policy versioning

- alias/rule/prompt/schema/profile/calibration versions are immutable and digest-addressed;
- activation and retirement are audited;
- a prior evaluation can be reproduced from stored versions;
- production behavior cannot self-modify outside the promotion flow.

### ACCEPT-134 — Improvement evidence

- metrics in section 4.4 pass;
- corrected similar cases improve;
- no critical regression occurs;
- affected re-evaluation is bounded, resumable, and observable;
- UI states which policy/model produced current understanding.

### ACCEPT-135 — Data-sharing policy

- external/local model routes obey configured policy;
- redaction/minimization tests pass;
- blocked content never reaches the external-provider fixture;
- route/fallback is visible and audited.

**Decision:** The product may use “continuously improving” language only after ACCEPT-133 and ACCEPT-134 pass.

---

## 11. v1.4.0 release gate — Intelligence Surfaces

### ACCEPT-141 — Daily intelligence

The user can find, without browsing all raw mail:

- new/changed project information;
- reply-needed items;
- deadlines and commitments;
- waiting and blocked work;
- conflicts and review candidates;
- reference/no-action mail.

### ACCEPT-142 — Project/work understanding

For representative projects, the user can verify:

- current status and recent changes;
- people/organizations/products;
- decisions, commitments, schedule, work, risks;
- related mail and attachments;
- evidence and unresolved conflicts.

### ACCEPT-143 — Query trust

- factual answers cite evidence and freshness;
- unknown/conflict cannot be omitted by a generated summary;
- structured accepted knowledge is queried before semantic evidence expansion;
- no semantic-only result becomes accepted fact;
- malicious source text cannot redirect the query tool or expose secrets.

### ACCEPT-144 — Usability and performance

- owner completes the agreed representative daily/project tasks;
- critical workflows are keyboard reachable;
- state/failure labels are understandable;
- measured local performance meets or has an owner-approved evidence-based adjustment to section 5;
- no production mutation capability is exposed.

**Decision:** Passing v1.4 permits single-user internal beta, not mutation-enabled production.

---

## 12. v1.5.0 release gate — Operational Production Candidate

### ACCEPT-151 — External linking safety

- external master records are read/mapped as configured;
- ambiguous mappings enter review;
- no adapter silently mutates external masters;
- duplicate link/create candidates are detected;
- outbox retry is idempotent and reconciled.

### ACCEPT-152 — Retention and evidence integrity

- retention policy is documented and tested;
- deleting local content does not leave an accepted material claim pretending evidence still exists;
- required tombstones/checksums remain according to policy;
- export/import of policy/correction metadata is verified.

### ACCEPT-153 — Operations

- scheduled backup and alerting work;
- clean restore rehearsal passes;
- stale sync, backlog, disk, backup age, and evaluation drift are visible;
- service restart and upgrade are documented and reproduced;
- release package/SBOM/manifest/known limitations are present;
- rollback rehearsal passes.

### ACCEPT-154 — Security validation

- least privilege and filesystem permissions verified;
- non-local exposure remains disabled unless separately designed and tested;
- secret scan and dependency audit pass;
- outbound allowlists pass;
- audit events cover security-sensitive configuration and review changes.

### ACCEPT-155 — Owner acceptance

The owner accepts the system as a read-only internal production intelligence system using live operational scenarios and acknowledges known limitations.

**Decision:** v1.5 may be `GO` for read-only internal production. All mutation adapters remain disabled.

---

## 13. v2.0.0 release gate — Approved Execution

Each action adapter/action type passes an individual gate. There is no blanket “all mutations approved” gate.

### ACCEPT-201 — Proposal and approval integrity

- proposal contains complete final payload and source context;
- approval binds to exact payload digest;
- editing recipient/content/attachment/date/amount/commitment invalidates approval;
- rejected, expired, revoked, or already-completed proposal cannot execute;
- viewing, correcting, or drafting does not count as approval.

### ACCEPT-202 — Execution idempotency

- first execution produces one external effect and one receipt;
- repeated/retried request produces no duplicate effect;
- uncertain network result enters reconciliation rather than blind retry;
- external ID/result is stored and queryable;
- failure, retry, cancellation, and compensation state is visible.

### ACCEPT-203 — Adapter-specific live canary

For each adapter/action type:

- separate permission/consent confirmed;
- fixture/sandbox tests pass;
- non-sensitive live canary with owner-approved target passes;
- kill switch works;
- rate/recipient/destination restrictions work;
- execution receipt matches external result.

### ACCEPT-204 — Adversarial approval tests

Attempts to:

- substitute payload after approval;
- replay stale approval;
- approve via forged UI/API request;
- inject approval instructions through mail content;
- route to an unapproved destination;
- duplicate execution under concurrency;
- expose tokens or message content in logs

must fail or enter safe reconciliation state.

### ACCEPT-205 — Business-use approval

The owner explicitly enables each action type after reviewing its live canary evidence and known limitations.

**Decision:** Only individually accepted action types are enabled. Mail send approval does not authorize deletion, calendar, CRM, project, or other actions.

---

## 14. Live Outlook validation matrix

Minimum live validation before read-only production candidate:

| Case | Required evidence |
|---|---|
| delegated OAuth login | successful consent, refresh, expiry handling, logout/revoke guidance |
| baseline selected-folder sync | count/page/checkpoint report |
| incremental changes | new mail, edited/source-state change, moved/deleted handling where available |
| throttling/transient failure | bounded retry and visible stale state |
| restart during sync | resume without duplicate authoritative messages |
| privacy route | selected local/external model policy enforced |
| source link | evidence opens or references correct Outlook source |

Application-permission/shared-mailbox validation is separate and only required if that operating mode is approved.

No live test should send mail or alter source state before its action-specific 2.0 gate.

---

## 15. Backup, restore, and rollback evidence

### 15.1 Backup contents

- SQLite database and required sidecar state under a safe backup procedure;
- schema and migration version;
- application/release manifest;
- active policy/profile/prompt/schema digests;
- non-secret configuration necessary for restore;
- checksum manifest.

Secrets follow the selected secret-management backup policy and are not copied into ordinary release artifacts.

### 15.2 Restore proof

A restore is complete when:

- files/checksums validate;
- database integrity check passes;
- schema version is recognized;
- record counts and selected knowledge/evidence relations reconcile;
- application health passes;
- source sync can resume from a documented state;
- no external mutation is triggered by restore/startup.

### 15.3 Rollback proof

Before a schema/release upgrade:

- create verified backup;
- document compatible previous application/schema;
- rehearse restore or supported rollback;
- prove outbox/actions will not be duplicated after recovery;
- record recovery point and known data-loss window, if any.

---

## 16. Release decision template

```text
Release:
Commit:
Schema version:
Policy/profile versions:
Dataset version:
Environment:

Mandatory gate results:
- static/build:
- unit:
- integration:
- migration:
- replay evaluation:
- security:
- backup/restore:
- live validation:
- owner acceptance:

Critical open defects:
Known limitations:
Rollback evidence:

Decision: GO | CONDITIONAL GO | NO-GO
Decision owner:
Evidence artifact references:
```

`CONDITIONAL GO` must state a bounded operating restriction, such as “read-only pilot against selected folders.” It cannot be used to bypass a failed critical safety, data-integrity, evidence, restore, or approval gate.

---

## 17. Current verification baseline

At planning time, the repository has demonstrated only:

- Node syntax check pass for the current main server/frontend/analyzer files;
- local process startup and `/api/outlook/status` health response;
- no configured live Outlook account in the Ubuntu clone;
- no unit/integration/evaluation test files;
- lint unavailable before dependency installation in the inspected clone;
- reproduced classification errors for mixed completed/urgent and reference mail;
- source inspection confirming direct mutation, incomplete sync, non-blocking CI, and current AI defects.

Therefore the current decision remains:

```text
Planning: GO
Implementation foundation: GO after owner accepts this plan
Current external mutation: NO-GO
Current production operation: NO-GO
```
