# Mail Intelligence Project Rules

**Worker name:** `mailintelligence`
**Project root:** `/home/jm/orca/projects/mail-intelligence`
**Canonical branch:** `main`
**Planning baseline:** 2026-08-28

## 1. Product identity

Mail Intelligence is not an Outlook replacement, a simple mail summarizer, or an autonomous reply bot.

> Mail Intelligence continuously ingests the user's complete work-mail history, classifies and links messages by project and work, extracts people, organizations, decisions, commitments, schedules, products, issues, risks, and evidence, stores those facts and relationships in a persistent database, and improves its future classification and recommendations using user corrections and observed outcomes.

The product loop is fixed:

```text
INGEST -> NORMALIZE -> LINK -> EXTRACT -> RECONCILE -> STORE
       -> PRESENT -> CORRECT/APPROVE -> LEARN -> RE-EVALUATE
```

The user-facing loop is:

```text
mail -> project/work context -> evidence-backed understanding
     -> next decision/action proposal -> human approval -> execution receipt
```

## 2. Non-negotiable direction

1. The primary product asset is **persistent work memory**, not generated prose.
2. Every important claim must be linked to source evidence from a mail, thread, attachment, or approved correction.
3. New mail must update related project/work knowledge instead of being analyzed in isolation.
4. Facts, interpretations, recommendations, corrections, and execution results must remain distinguishable.
5. Historical values are retained as revisions; current values must not erase prior state silently.
6. Project and work creation begin as candidates unless confidence and policy explicitly allow automatic linking.
7. User corrections are first-class data and must influence later decisions through versioned, testable policies.
8. AI models are replaceable analyzers. They are not the source of truth.
9. External actions are disabled by default and require an approval boundary.
10. Outlook remains authoritative for mail/thread state. Mail Intelligence owns derived intelligence, corrections, approvals, and execution receipts.
11. SQLite is the first operational database. PostgreSQL is introduced only when multi-user concurrency requires it.
12. Structured facts and temporal relations are authoritative; vector retrieval is a supporting search mechanism only.
13. General intelligence core and domain profiles such as Sangfor, sales, accounting, and security must remain separated.
14. Features are added only after the previous release gate passes. Direction stays fixed; capability grows on top of it.

## 3. Forbidden shortcuts

Do not:

- treat a JSON cache as the final operational database;
- generate exactly three reply scenarios for every message;
- classify every non-empty mail as actionable;
- mark a message read merely because it was displayed;
- send, delete, move, flag, categorize, schedule, or publish without explicit approval;
- hide model failure behind an unlabeled rules fallback;
- overwrite a prior project fact without preserving its evidence and revision history;
- create a new project from one weak signal without candidate review;
- use embeddings as the only basis for project assignment or factual answers;
- hard-code Sangfor-specific behavior into the generic core;
- add CRM, project-management, or calendar ownership that belongs to another system;
- enable automatic production deployment while required tests are non-blocking;
- claim production readiness without live Outlook, backup/restore, security, and replay evidence.

## 4. Source-of-truth documents

Read these before implementation:

1. `docs/planning/00-PROJECT-DEFINITION.md`
2. `docs/planning/01-REQUIREMENTS.md`
3. `docs/planning/02-DATA-AND-ARCHITECTURE.md`
4. `docs/planning/03-DEVELOPMENT-PLAN.md`
5. `docs/planning/04-TEST-AND-RELEASE-GATES.md`

The precedence order is:

```text
PROJECT DEFINITION
  > REQUIREMENTS
  > DATA/ARCHITECTURE CONTRACTS
  > DEVELOPMENT PLAN
  > IMPLEMENTATION DETAILS
```

A lower-level document or code change must not silently contradict a higher-level artifact.

## 5. Current baseline

The repository's package version is `1.0.0`, but the current implementation is a legacy prototype, not the new operational baseline.

Known baseline constraints include:

- one large `server.mjs` containing HTTP, OAuth, Graph, storage, AI, and action logic;
- JSON-file cache and configuration persistence;
- no automated unit or integration test suite;
- AI enrichment runtime defects and unlabeled fallback risk;
- direct send and read-state mutation paths without the target approval model;
- incomplete incremental synchronization;
- CI checks that currently ignore failures;
- generic core mixed with Sangfor-specific reply behavior;
- duplicate legacy frontend files at repository root.

Do not build new intelligence features on top of these defects before the recovery gate is complete.

## 6. Required implementation order

```text
P0  Planning baseline
P1  Safety and correctness recovery
P2  Persistent mail memory and reliable sync
P3  Project/work intelligence
P4  Continuous-learning and temporal knowledge
P5  Project intelligence/search surfaces
P6  External work linking and operational hardening
P7  Approved execution
```

See `docs/planning/03-DEVELOPMENT-PLAN.md` for version mapping and PR order.

## 7. Data authority rules

Each derived record must expose, directly or transitively:

- source mailbox/account;
- source message/thread/attachment IDs;
- evidence span or structured evidence reference;
- extraction method and model/rule version;
- confidence;
- creation time and last evaluation time;
- current status;
- superseded revisions;
- user correction or approval, when present.

A factual answer without evidence is incomplete. A recommendation without uncertainty is incomplete. A current state without revision history is incomplete.

## 8. AI and learning rules

AI output must be schema validated before use. Store model observations separately from accepted facts.

The learning hierarchy is:

```text
explicit user correction
> approved project/entity alias
> verified execution outcome
> deterministic policy/rule
> model extraction with evidence
> similarity-only suggestion
```

Learning means updating versioned aliases, policies, examples, confidence calibration, and evaluation results. It does not mean silently fine-tuning or mutating production behavior without traceability.

## 9. Approval boundary

The following are external mutations and require an `ActionProposal -> Approval -> Execution -> ExecutionReceipt` flow:

- send/reply/forward;
- read/unread, flag, category, move, or delete;
- calendar or task creation;
- CRM/project/customer record mutation;
- Data Plane publication;
- promises, dates, prices, or commitments communicated externally.

During the read-only intelligence stages, these capabilities must be disabled or run only against explicit fixtures.

## 10. Definition of done

A feature is not complete because the UI appears to work. Completion requires:

- requirement IDs linked to implementation and tests;
- deterministic or fixture-based test evidence;
- negative and adversarial cases;
- evidence and confidence behavior verified;
- migration and rollback impact documented;
- no new unapproved external mutation path;
- relevant CI gates blocking on failure;
- operator-visible failure states;
- updated source-of-truth documentation when contracts change.

Production readiness additionally requires live Outlook validation, backup/restore rehearsal, security validation, and acceptance evidence listed in `04-TEST-AND-RELEASE-GATES.md`.

## 11. Repository working rules

- Prefer small modules and explicit contracts over another monolith.
- Read the smallest relevant code slice before editing.
- Add tests with each behavior change.
- Preserve a clean migration path from legacy JSON data.
- Never commit real mail, tokens, secrets, or production identifiers.
- Use synthetic fixtures and redacted evidence in tests.
- Do not commit or push unless the user explicitly requests it.
- Report changed files, verification commands, remaining risks, and current release-gate status.
