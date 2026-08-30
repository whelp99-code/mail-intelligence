# Mail Intelligence Planning Baseline

**Status:** APPROVED DIRECTION / IMPLEMENTATION NOT STARTED
**Baseline date:** 2026-08-28
**Owner:** 박재민
**Worker:** `mailintelligence`

## 1. Purpose

This directory is the source of truth for rebuilding the existing Mail Intelligence prototype into an operational, continuously improving mail intelligence system.

The planning chain is intentionally small and continuous:

```text
WHY / PRODUCT DEFINITION
  -> WHAT / REQUIREMENTS
  -> HOW / DATA AND ARCHITECTURE
  -> BUILD / VERSIONED DEVELOPMENT PLAN
  -> VERIFY / TEST AND RELEASE GATES
```

No implementation phase may begin by bypassing this chain.

## 2. Canonical document set

| Order | Document | Purpose | Primary consumers |
|---|---|---|---|
| 00 | `00-PROJECT-DEFINITION.md` | Fixes product identity, users, scope, principles, and success criteria | owner, product, all agents |
| 01 | `01-REQUIREMENTS.md` | Defines stable requirement IDs and release allocation | architecture, implementation, QA |
| 02 | `02-DATA-AND-ARCHITECTURE.md` | Defines the canonical data model, knowledge lifecycle, boundaries, and target architecture | implementation, migration, operations |
| 03 | `03-DEVELOPMENT-PLAN.md` | Defines release sequence, dependencies, deliverables, PR graph, and stop conditions | implementation, project management |
| 04 | `04-TEST-AND-RELEASE-GATES.md` | Defines how correctness, safety, intelligence quality, recovery, and release readiness are proven | QA, security, operations, owner |

Root `AGENTS.md` is the execution guardrail derived from these documents.

## 3. Fixed product statement

> Mail Intelligence continuously ingests the user's complete work-mail history, classifies and links messages by project and work, extracts people, organizations, decisions, commitments, schedules, products, issues, risks, and evidence, stores those facts and relationships in a persistent database, and improves future classification and recommendations using user corrections and observed outcomes.

The persistent knowledge base is the center of the product. Daily triage, search, recommendations, and approved execution are surfaces built on top of it.

## 4. Current release interpretation

The repository currently reports package version `1.0.0`. This version is treated as a **legacy prototype baseline**, not as evidence of production readiness.

The planned release line is:

```text
1.0.1  Safety and correctness recovery
1.1.0  Persistent mail memory and reliable synchronization
1.2.0  Project and work intelligence
1.3.0  Continuous learning and temporal knowledge
1.4.0  Project intelligence and evidence-backed retrieval
1.5.0  External work linking and operational hardening
2.0.0  Approved execution
```

Each release is blocked until its gate in `04-TEST-AND-RELEASE-GATES.md` passes.

## 5. Decision hierarchy

When documents or code disagree, use this order:

```text
00-PROJECT-DEFINITION
> 01-REQUIREMENTS
> 02-DATA-AND-ARCHITECTURE
> 03-DEVELOPMENT-PLAN
> 04-TEST-AND-RELEASE-GATES
> implementation details
```

The test-and-release document does not lower product or security requirements; it proves them.

## 6. Traceability convention

Stable IDs are used throughout the plan:

- `GOAL-###` — measurable product goal
- `REQ-MAIL-###` — mail ingestion and source requirements
- `REQ-INT-###` — intelligence and extraction requirements
- `REQ-KNOW-###` — persistent knowledge and learning requirements
- `REQ-PROJ-###` — project/work classification requirements
- `REQ-UX-###` — user-facing intelligence requirements
- `REQ-ACT-###` — approval and execution requirements
- `REQ-SEC-###` — security and privacy requirements
- `REQ-OPS-###` — operations and recovery requirements
- `NFR-###` — non-functional requirement
- `ACCEPT-###` — acceptance or release evidence
- `ADR-###` — architectural decision
- `RISK-###` — tracked risk

Every implementation PR must list the requirement IDs it satisfies and the acceptance evidence it adds.

## 7. Change policy

A direction change requires all of the following:

1. state the reason and observed evidence;
2. identify affected goal and requirement IDs;
3. update the higher-level source-of-truth document first;
4. update architecture, development, and test implications;
5. record migration and compatibility impact;
6. obtain owner approval before implementation.

Assumptions must remain marked `ASSUMED`; unknown information must remain marked `UNKNOWN`. Neither may be silently presented as a confirmed fact.

## 8. Current decision

The next implementation work is **v1.0.1 Safety and Correctness Recovery**. No new autonomous action, CRM mutation, calendar creation, or automatic Data Plane publication is allowed before that gate passes.
