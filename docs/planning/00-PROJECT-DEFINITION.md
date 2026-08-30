# Mail Intelligence — Project Definition

**Document version:** 1.0
**Status:** FIXED BASELINE
**Effective date:** 2026-08-28
**Product owner:** 박재민
**Implementation worker:** `mailintelligence`

---

## 1. Executive definition

> **Mail Intelligence is a mail-based work intelligence and persistent memory system. It continuously collects the user's complete work-mail history, organizes it by project and work, extracts facts, relationships, decisions, commitments, schedules, documents, risks, and evidence, stores them in a database, and becomes more accurate over time through user corrections and actual work outcomes.**

Korean product statement:

> **Mail Intelligence는 전체 업무 메일을 지속적으로 수집·분석하여 프로젝트·업무·고객·사람·의사결정·일정·자료별로 연결하고, 그 결과를 데이터베이스에 누적해 시간이 지날수록 더 정확한 업무 지식과 판단을 제공하는 메일 기반 업무 인텔리전스 시스템이다.**

Simple user promise:

> **메일함 속에 흩어진 회사와 개인의 업무 기억을 자동으로 정리하고, 새 메일과 사용자 보정을 반영해 계속 똑똑해지는 업무 두뇌.**

---

## 2. Why this project exists

Work mail is not merely communication. It contains the operational history of the business:

- customer requests and promises;
- project status and schedule changes;
- quotations, orders, contracts, and amounts;
- technical issues, incidents, and resolutions;
- people, organizations, roles, and relationships;
- decisions and their evidence;
- attachments, versions, and missing documents;
- work assigned, completed, blocked, or waiting;
- commitments that may not exist in any other system.

The current problem is that this knowledge remains fragmented across messages and threads. A user must repeatedly search, reread, remember, and manually transfer information to other tools. Ordinary summarizers process one message at a time and forget the result. Folder-based mail organization assigns one message to one place even though one message may affect several projects, people, and work items.

Mail Intelligence exists to convert this fragmented stream into a persistent, evidence-backed, continuously revised work memory.

---

## 3. Product thesis

The defensible product asset is not a better reply draft. It is the accumulated, traceable understanding of the user's work.

```text
raw mail volume
  + reliable source synchronization
  + structured facts and relationships
  + temporal revisions
  + user corrections
  + observed outcomes
  = continuously improving work intelligence
```

The more the system is used correctly, the more it should understand:

- which project a new message belongs to;
- which aliases refer to the same company, project, product, or person;
- what the current state of a project is and how it changed;
- which requests create real work and which are reference-only;
- what the user usually considers urgent, waiting, completed, or irrelevant;
- which promises remain open;
- which recommendation patterns lead to accepted or rejected outcomes;
- what evidence supports every answer.

“Getting smarter” means measurable improvement in classification, entity resolution, temporal reconciliation, retrieval, and recommendation quality. It does not mean silently changing behavior or treating model output as truth.

---

## 4. Primary user and operating context

### 4.1 Initial user

The first production user is **박재민**, operating a single-user internal system on the Ubuntu environment.

Primary mail domains include:

- customer requests;
- sales, quotations, purchase orders, and contracts;
- Sangfor and infrastructure engineering;
- project delivery and schedules;
- partner and vendor coordination;
- technical support and incidents;
- accounting, tax, and administration;
- approvals and follow-up waiting;
- documents and attachments.

### 4.2 Expansion order

```text
single-user operational intelligence
-> trusted internal company use
-> shared mailboxes and multiple roles
-> team intelligence when concurrency justifies it
```

The project does not begin as a public multi-tenant SaaS.

---

## 5. Jobs to be done

The user should be able to rely on Mail Intelligence to answer:

1. **What is this mail about, and which project or work does it affect?**
2. **What changed compared with what we previously knew?**
3. **What requests, deadlines, decisions, commitments, risks, and documents exist?**
4. **What is the current state of each project and open work item?**
5. **Which mails require a decision, reply, follow-up, or no action?**
6. **What evidence supports the system's conclusion?**
7. **What did I previously correct, approve, reject, or execute?**
8. **What is the safest and most useful next action?**
9. **Can I find the answer without rereading dozens of messages?**
10. **Can the system improve its future decisions from my corrections and real results?**

---

## 6. Canonical product loop

### 6.1 Intelligence loop

```text
1. Collect complete and incremental mail changes
2. Normalize messages, threads, participants, and attachments
3. Resolve known identities, aliases, projects, and work relations
4. Extract facts, requests, dates, amounts, products, decisions, risks, and evidence
5. Compare extracted information with current knowledge
6. Distinguish new, repeated, conflicting, and superseding information
7. Create or update candidate links and temporal revisions
8. Present current understanding with evidence and confidence
9. Capture user correction, confirmation, rejection, or approval
10. Observe downstream outcome where available
11. Update versioned policies, aliases, calibration, and examples
12. Re-evaluate affected knowledge and future messages
```

### 6.2 User action loop

```text
understand
-> inspect evidence
-> correct or accept
-> choose a proposed action
-> approve
-> execute through an adapter
-> store an execution receipt
```

The intelligence loop is the product core. The action loop is a controlled surface added later.

---

## 7. Product pillars

### PILLAR-1 — Complete mail memory

The system maintains a durable representation of messages, threads, attachments, participants, and source changes without replacing Outlook as the source authority.

### PILLAR-2 — Project and work intelligence

A message can belong to multiple projects or work items. Assignment is evidence-based, confidence-scored, and reviewable.

### PILLAR-3 — Structured persistent knowledge

Projects, people, organizations, decisions, commitments, schedules, products, issues, risks, and evidence are stored as structured, queryable, temporal data.

### PILLAR-4 — Continuous improvement

Corrections and outcomes update versioned knowledge, aliases, policies, examples, and confidence calibration. Improvement must be measurable through replay evaluation.

### PILLAR-5 — Evidence and uncertainty

Every material conclusion exposes supporting evidence, source, confidence, extraction method, and unresolved conflict.

### PILLAR-6 — Human-controlled action

AI proposes; the user controls external commitments and mutations. Approved actions produce auditable receipts.

### PILLAR-7 — Interoperability without ownership confusion

Mail Intelligence may suggest links or mutations to CRM, project, calendar, task, or data-plane systems, but does not silently become those systems.

---

## 8. Core information produced from mail

### 8.1 Project intelligence

For each project, the system should maintain:

- canonical name and aliases;
- customer and participating organizations;
- related people and roles;
- products and solution scope;
- current phase and status;
- current and historical schedules;
- decisions and commitments;
- active, waiting, completed, and dismissed work;
- issues, blockers, and risks;
- related mail threads and attachments;
- recent changes;
- unresolved conflicts;
- evidence coverage and confidence.

### 8.2 Work intelligence

For each work item:

- requested action;
- requester and intended owner;
- project relations;
- status and processing stage;
- due date or follow-up date;
- completion condition;
- blockers and dependencies;
- source evidence;
- related replies and execution outcomes.

### 8.3 People and organization intelligence

- identity and aliases;
- organization and role;
- related projects;
- recent interaction history;
- open requests and commitments;
- communication and classification patterns;
- relationship evidence, not speculative personal profiling.

### 8.4 Decision and commitment intelligence

- decision or promise;
- maker and participants;
- date and effective period;
- alternatives or conditions when stated;
- source evidence;
- later amendment or supersession;
- current validity.

### 8.5 Schedule and document intelligence

- meetings, deadlines, delivery dates, renewal dates, and promised follow-ups;
- attachments and referenced documents;
- document version, sender, date, and project linkage;
- missing, outdated, or conflicting document candidates.

---

## 9. Information-state model

The system must not collapse all meaning into one status field.

### 9.1 Processing stage

```text
new
analyzed
review_required
confirmed
approval_pending
approved
executed
dismissed
superseded
failed
```

### 9.2 Work status

```text
urgent
active
waiting
done
reference
cancelled
unknown
```

### 9.3 Detected signals

Examples:

```text
reply_needed
deadline
meeting
amount
quotation
purchase_order
contract
approval_waiting
attachment_missing
incident
security_risk
renewal
schedule_change
commitment
project_candidate
conflict
```

A message can be `urgent + approval_pending + schedule_change`. These dimensions must remain separate.

---

## 10. Scope

### 10.1 Required product scope

- Outlook account/mailbox connection;
- complete baseline ingestion plus reliable incremental synchronization;
- message, thread, participant, and attachment metadata storage;
- project and work candidate classification;
- people, organization, product, schedule, amount, decision, commitment, issue, risk, and evidence extraction;
- temporal current-state and revision history;
- user correction and confirmation workflow;
- project/work intelligence views;
- evidence-backed search and question answering;
- daily decision and follow-up surface;
- backup, restore, migration, and operational diagnostics;
- model/rule version tracking and replay evaluation;
- later, approval-based external action.

### 10.2 Deferred scope

- multiple users and role-based access;
- shared mailbox collaboration;
- automatic CRM, calendar, task, or project mutations;
- production mail send/reply/forward;
- mobile push and team notifications;
- public API and broad connector marketplace;
- PostgreSQL migration for concurrent use.

### 10.3 Explicit non-goals

- replacing Outlook as a mail client or source of truth;
- universal support for every mail provider in the initial product;
- bulk marketing email;
- autonomous sales or customer communication;
- permanent compliance-grade raw mail archiving;
- building a general-purpose CRM or project-management product;
- using a vector database as the sole factual memory;
- automatically accepting model-generated facts without evidence;
- auto-creating projects from a single weak message;
- hard-coding one vendor domain into the generic engine.

---

## 11. System ownership boundaries

| Information or action | Authoritative owner | Mail Intelligence role |
|---|---|---|
| Raw mail, folders, thread/source state | Outlook / Microsoft Graph | synchronize and reference |
| Derived classification and evidence | Mail Intelligence | authoritative for derived analysis |
| Project/work memory derived from mail | Mail Intelligence until exported/confirmed elsewhere | maintain temporal knowledge |
| Customer master data | CRM or Business OS when available | resolve and propose links |
| Project master data | project system when available | resolve and propose links |
| Calendar events | calendar system | propose; later create after approval |
| Tasks | task/project system | propose; later create after approval |
| User corrections | Mail Intelligence | authoritative learning input |
| Approval and execution receipts | Mail Intelligence | authoritative audit trail |
| AI observations | Mail Intelligence model-run log | non-authoritative until reconciled |

---

## 12. General core and domain profiles

The product is divided into:

```text
Mail Intelligence Core
├── ingestion and source sync
├── thread and identity normalization
├── generic entity/signal extraction
├── project/work linking
├── temporal knowledge and evidence
├── correction and evaluation
└── approval and execution contracts

Domain Profiles
├── Sangfor / infrastructure engineering
├── sales / quotation / order / contract
├── project delivery
├── accounting / administration
└── security / incident response
```

Domain profiles add vocabulary, extraction schemas, document suggestions, and evaluation cases. They must not change core source authority or approval policies.

---

## 13. Fixed operating principles

1. **Database first, generation second.** Generated summaries are views over stored knowledge.
2. **Evidence before confidence.** High confidence without traceable evidence is not accepted.
3. **Revision, not overwrite.** New facts supersede prior state through recorded revisions.
4. **Candidate before creation.** Weakly supported project/work links remain review candidates.
5. **Read-only before action.** Intelligence must prove value and safety before mutation capabilities.
6. **User correction over model preference.** Explicit correction has higher authority.
7. **Failure must be visible.** Model, sync, parsing, storage, and integration failures are surfaced.
8. **Replay before release.** Changed intelligence behavior is evaluated against a fixed dataset.
9. **One core, optional profiles.** Vendor-specific knowledge is modular.
10. **Operational simplicity first.** Single-user SQLite is preferred before distributed infrastructure.
11. **No silent external commitment.** A human approves communication, schedule, price, promise, or record mutation.
12. **Direction is fixed.** New functionality extends this definition rather than replacing it.

---

## 14. Success goals

### GOAL-001 — Durable work memory

Mail-derived project and work knowledge survives restart, re-analysis, model change, and source resynchronization without losing evidence or revision history.

### GOAL-002 — Faster understanding

The user can understand the current state and recent change of an active project without manually rereading the full mail history.

### GOAL-003 — Reduced missed work

The system reliably surfaces reply needs, commitments, deadlines, schedule changes, blockers, and waiting items.

### GOAL-004 — Improving classification

Confirmed corrections reduce repeated project-assignment and work-status errors on later similar messages, proven by replay evaluation.

### GOAL-005 — Trustworthy answers

Material answers cite source evidence and distinguish fact, inference, conflict, and unknown state.

### GOAL-006 — Safe operation

No external mutation occurs without the configured approval contract, and every executed action has an idempotent receipt.

### GOAL-007 — Recoverable operation

The operational database, configuration, and knowledge revisions can be backed up, restored, and validated.

Quantitative thresholds and release evidence are defined in `04-TEST-AND-RELEASE-GATES.md`.

---

## 15. Product success indicators

The following indicators are tracked after the necessary instrumentation exists:

- project-link precision and review acceptance rate;
- work-item extraction precision/recall;
- evidence coverage for material claims;
- unsupported-fact rate;
- duplicate message, project, and work-item rate;
- correction recurrence rate;
- time required to understand a project or daily inbox;
- open commitment and deadline miss rate;
- model/rule fallback visibility;
- restore success and knowledge-integrity checks;
- approval bypass count;
- execution duplicate count.

No single model benchmark is considered a complete product success measure.

---

## 16. Current-state statement

The existing repository is useful as a prototype and migration source. It already demonstrates Outlook connection, rule-based extraction, AI-provider intent, classification feedback, and a three-column user interface.

It is not yet the defined product because it lacks:

- a persistent structured knowledge database;
- project/work temporal memory;
- reliable complete synchronization;
- tested continuous-learning contracts;
- evidence-backed retrieval over accepted knowledge;
- separation of observation, fact, correction, and action;
- blocking quality and security gates;
- the required approval boundary.

The development plan therefore preserves useful behavior while replacing the prototype's storage, intelligence, action, and verification foundations in sequence.

---

## 17. Definition of product completion

Mail Intelligence reaches its intended product state when it can:

1. ingest and reconcile the user's work-mail history reliably;
2. maintain evidence-backed current and historical project/work knowledge;
3. improve classification and linking from explicit corrections without hidden policy mutation;
4. answer project/work questions with sources and uncertainty;
5. surface daily changes, commitments, risks, and next decisions;
6. recover from backup with integrity preserved;
7. execute only approved actions with receipts;
8. pass the release, adversarial, and operational gates defined by this planning baseline.

Until these conditions are evidenced, the system must describe its maturity honestly as prototype, read-only pilot, internal beta, or production candidate according to the passed gate.
