# Phase 0 / 1A — WorkLink contracts (UNKNOWN-005 split)

> Status: Phase 1A fixture **ACCEPTED by Jae 2026-09-11/12 (구두 「진행해」)**. V01/V02 recovery passing. V03 closed-in-fixture. V04 closed-in-fixture (tested scope). Ops-scale perf remains separate — this is **not** 3010 cutover. Phase 1B read-only collect authorized; live pull `BLOCKED_ON_SECRET` until operator supplies token+map (re-checked 2026-09-12). No live Notion write. No tokens or real page IDs in git.
> Canonical CRM plan: `AI-CRM+PM/docs/planning/notion-crm-psa-v1/00-canonical-master-plan-v2-ko.md`
> Superseded citation: `00-master-plan-ko.md` (README: v1 master is superseded).
> Closest architecture note found: `AI-CRM+PM/docs/planning/customer-work-os-v3/06-ARCHITECTURE.md`. `docs/planning/03-ARCHITECTURE-CONTRACTS.md` and `automation/rules/crm-review-routing.v3.json` were not found in local trees.

## 1. Grokbot investigates, Codex contrasts/verifies

The current investigation agent is **Grokbot**. The current verifier is **Codex**. Neither is an LLM chatbot inside Mail Intelligence, and neither is Outlook Copilot.

| Role | Owns | Does not own |
|---|---|---|
| **Grokbot** | Investigation, draft findings, fixture/prototype proposals | Silent ACK, silent send, silent Notion write, single-writer overwrite |
| **Codex** | Contrast, verification, ACK of a Grokbot row | Mail authority, CRM ledger, inventing a second product brain |
| **Mail Intelligence** | Mail memory, rules classification, WorkLink store, approval-bound send. Returns link/change **proposals** only | Chat product, CRM master records, applying Notion rows |
| **CRM operator** | Applies accepted proposals to the existing analysis ledger / Notion projection | MI-owned mail authority |
| **Notion JM Business OS** | Human-editable projection: project, next action, activity | Mail original, auto-confirmed links, analysis ledger of record |
| **jm-business.db / JSONL** | Existing CRM analysis ledger (operator-owned) | Notion page identity |
| **CWOS (later)** | Replaceable `system=cwos` adapter on the same WorkLink contract | A second Notion write path |

ACK fields for a reviewed row (exact-match reuse only):

```text
version
hash
agent
seen_at
accepted_scope
notion_refetch
```

Rules:

- One writer per row. Exact-match approval may be reused; a hash mismatch is a new proposal.
- Do **not** require a human click for every internal allowed job (classify, candidate link, fixture refresh, dashboard).
- Do **not** loosen send / money / contract approval.
- Do **not** add Copilot-style free chat or a second model brain inside MI.

MI’s existing OAuth CLI labeled `openaiCodexModel` is an optional analyzer. It is not this brain and is not used for Phase 1A WorkLinks.

### Phase 1A surfaces (fixture only)

Tests call **read-only / local** surfaces only:

1. Load masters from a Notion **fixture** snapshot (`test/fixtures/notion-jm-business-os.snapshot.json` or `MAIL_INTELLIGENCE_NOTION_SNAPSHOT`).
2. `POST /api/work-links/refresh` to persist **candidate** WorkLinks and project classifications.
3. `GET /api/work-links` and `GET /api/work-links/stats` for linked vs unassigned rates.

Forbidden in Phase 1A (fixture) and still forbidden for writes:

- Live Notion page `POST` / `PATCH` / `DELETE` (Activity create/update)
- Operational port-3010 flag changes (`ALLOW_SEND`, attachments, Drive, Data Plane, CRM write)
- Real mail send
- Auto-confirm (`status` is only `candidate` on create)

Phase 1B (when `MAIL_INTELLIGENCE_NOTION_READONLY=1` + secrets): allow only database retrieve GET and database **query** POST. Still no page writes.

### UNKNOWN-005 split

| Slice | Status | Meaning |
|---|---|---|
| Logical fixture contract | **done** | Synthetic 3-mail map, Activity logical property map, de-identified schema fixture, WorkLink projection rules |
| Operational mapping | **unverified** | Live database_id, real select options, `crm-review-routing.v3.json`, and operator schema pull are not in git and were not re-fetched |

### Learning path

Jae corrects in Notion or via a reviewed proposal. That is **Phase 5**. Phase 5 must separate **re-apply** (replay the same correction) from **generalization** (alias/policy promotion). Holdout and rollback are later gates. Phase 1A only persists `candidate` WorkLinks and never auto-confirms.

## 2. WorkLink

```text
WorkLink {
  mailbox_id,
  message_id,              // MI database message id
  graph_id,                // Outlook message id (evidence)
  object_type,             // account | engagement | activity | commitment
  system,                  // "notion" | "cwos"
  external_id,             // fixture/source id now; CWOS uuid later
  name,
  confidence,              // 0..1 internal. Display transform → 확신도 select 높음/보통/낮음
  evidence_refs[],         // { kind, term, field }
  status,                  // Phase 1A create: candidate only
  corrected_by,            // null | user | policy | codex
}
```

Phase 6 swaps `system` + `external_id` only. MI classification schema stays.

WorkLink-derived `precision_classifications` are one projection:

- create when missing and a candidate exists
- replace when the current row is own-derived (`projectCandidate.source = notion-worklink` or provider/prompt `worklink-projection-v1`)
- clear to `unassigned` when the message is unlinked, deleted, or the snapshot is empty
- protect `user-corrected`, `reviewStatus=confirmed|corrected`, `projectResolution=confirmed`, and other-source non-unassigned rows

Refresh finishes **all pages** then commits an atomic generation swap. Partial failure/abort keeps last-known-good links and reports `completeness=partial`, `stale=true`. Do not supersede the mailbox and then process only the first 1000 messages.

Watermarks are separate:

- `source` = messages seen from the mailbox snapshot
- `analysisComplete` = last successful projection count
- stale snapshot = keep last-known-good + `stale`

## 3. Notion property map (logical names, not live database_id)

Live Notion `database_id` values are operator secrets. They are **not** stored in git. De-identified schema fixture: `test/fixtures/notion-activity-schema.deidentified.json` (schema hash + `capturedAt` + logical names only).

Logical databases:

| Logical DB | CWOS object | Title / key properties |
|---|---|---|
| 고객·파트너 | `cwos_accounts` | `회사/조직명` \| `회사명` \| `Name`; `구분`; `관계상태`; `담당자`; `대표 이메일` \| `이메일`; `대표 연락처`; `최근 연락일`; `다음 연락일` |
| 프로젝트 | `cwos_engagements` | `프로젝트명(Title)` \| `프로젝트명`; `프로젝트ID`; `상태` \| `단계`; `중요도`; `고객·파트너`; `파트너`; `시작일`; `종료일`; `다음 행동`; `제안제품`; `제안금액`; `견적서`/`제안서`/`계약서`/`완료보고서` |
| 활동·히스토리 | `cwos_activities` | `활동명` \| `요약`; `유형`; `활동일`; `결정사항`; `다음 행동`; `다음 연락일`; `프로젝트`; `고객·파트너`; `첨부`; **`출처 ID/경로`**; **`근거등급`**; **`확신도`**; **`검토상태`**; **`자연키`** |
| 재무 | `cwos_financial_items` | `거래명`; `구분`; `금액`/`부가세`/`합계`; `상태`; `프로젝트`; `거래처`; 입금·출금일. Phase 1A does not link finance. |

### Evidence / confidence / review map (Activity already has these)

| MI / proposal field | Notion property | Type | Notes |
|---|---|---|---|
| evidence pointer (graph_id / path) | `출처 ID/경로` | rich_text | not a live URL dump of the body |
| evidence tier | `근거등급` | select | 확인된 사실 / AI 추론 / 사용자 제안 / 가정 / 기각 / 이전 버전 |
| confidence 0–1 | `확신도` | select **높음/보통/낮음** | **not** a 0–1 number property |
| review | `검토상태` | select **검증완료/연결검토/제외** | **not** a boolean |
| identity | `자연키` | rich_text | required before Phase 3 write |

Internal 0–1 score stays on `work_links.confidence` and `precision_classifications.project_candidate_json.confidence`. Display transform: `>=0.8` → 높음, `>=0.5` → 보통, else 낮음.

Fixture validator (`validateActivityProposal`) fail-closes against the **delivered** schema, not a fixed constant alone:

- `확신도` must be `select` and in `schema.options ∩ {높음, 보통, 낮음}`. A schema that omits `높음` rejects a `높음` proposal. Numeric 0–1 and free text are rejected.
- `검토상태` must be `select` and in `schema.options ∩ {검증완료, 연결검토, 제외}`. Checkbox/boolean/number types and values are rejected.
- `근거등급` must be `select` and in `schema.options ∩ {확인된 사실, AI 추론, 사용자 제안, 가정, 기각, 이전 버전}`. Values such as `INVALID-TIER-FIXTURE` or CRM routing `T0`–`T4` are rejected. Do not loosen this set.
- Mapped text fields (`출처 ID/경로`, `자연키`) must be `rich_text`; a select/number where text is expected is rejected.

V03 is **closed-in-fixture** only. Operational Notion mapping remains unverified until a live schema pull. V04 (collection-while-source-changing) is **closed-in-fixture** only; ops-scale perf remains unverified — see `02-PHASE-GATES.md`. **P1A fixture acceptance: ACCEPTED by Jae 2026-09-11 (구두 「진행해」).** Phase 1B harness shipped; live pull waits on secrets.

### Mail → Activity (Phase 3 draft only; Phase 1A does not write)

| Activity field | Source |
|---|---|
| 유형 | `메일 수신` (or `메일 발신` after receipt) |
| 활동일 | `messages.received_at` |
| 요약 | subject + bounded preview (not full body) |
| 고객·파트너 | WorkLink `account` external_id |
| 프로젝트 | WorkLink `engagement` external_id |
| 출처 ID/경로 | MI `graph_id` / webLink pointer |
| 근거등급 | evidence tier, not a free-text dump |
| 확신도 | display transform of WorkLink.confidence |
| 검토상태 | `연결검토` until confirm/reject |
| 자연키 | stable `mail:{graph_id}:activity:{inbound\|outbound}` |

Phase 3 prerequisites (not implemented here): natural key, proposal hash, expected revision, actor/policy, outbox, timeout readback, dedupe, rollback. Notion read-before-write is **not** atomic CAS.

## 4. CWOS table map

| WorkLink object_type | CWOS table | External id later |
|---|---|---|
| account | `cwos_accounts` | uuid |
| engagement | `cwos_engagements` | uuid |
| activity | `cwos_activities` | uuid |
| commitment | `cwos_commitments` / `cwos_v3_action_items` | uuid |

Phase 1A does not call CWOS HTTP.

## 5. Synthetic 3-mail mapping

Fixture snapshot ids are synthetic (`syn-*`). They are not production Notion page IDs.

| Mail graph_id | Subject / from | Expected WorkLink | CWOS later |
|---|---|---|---|
| `syn-mail-quote` | `[선진 HCI] 수정 견적서 요청` from customer | `engagement` → `syn-project-sunjin-hci` (PRJ-2026-001), candidate | `cwos_engagements` |
| `syn-mail-thanks` | `소개 미팅 감사합니다` from `hong@example.com` | `account` → `syn-account-sunjin`, candidate | `cwos_accounts` |
| `syn-mail-newsletter` | `주간 뉴스레터` from `noreply@news.example` | none (unassigned) | — |

Rates after refresh of these three: linked candidates 2 / 3, unassigned 1 / 3. WorkLink query, classification query, and stats must agree for non-protected rows.

## 6. Phase 1A HTTP (local, fixture)

| Method | Path | Effect |
|---|---|---|
| GET | `/api/work-links` | Current candidate links + stats + last refresh watermark |
| GET | `/api/work-links/stats` | `active`, `linkedCandidate`, `unassigned`, `byObjectType`, refresh state |
| POST | `/api/work-links/refresh` | Re-read fixture snapshot, page all messages, atomic swap. CSRF + session. |

`proposeActivity` / any Notion write method throws `NOTION_WRITE_DISABLED`.

Refresh result includes `completeness` (`complete` \| `partial`), `stale`, `pages`, `messagesTotal`, and watermarks `{ source, analysisComplete }`.

## 7. Today briefing contract (Phase 2, not implemented)

Universe = **all in-progress CRM projects**, then add MI mail risk (union). Do not use only `DO NOW ∩ projects with next action`.

Reuse existing scores: deadline, slip, external-dep, stall, importance, plus `mail_risk`. Max 5. Every dropped project has an exclusion reason.

Distinguish:

- `internal_next_action` — 내부 다음 행동
- `external_confirmed_commitment` — 외부 확정 약속
- `external_expected_confirm` — 외부 확정 예정일

## 8. Link decision events (before Phase 4)

Activity post ≠ project-link confirm ≠ customer send.

| Event | Type | Opens send? |
|---|---|---|
| confirm | `WorkLinkConfirmed` | no |
| reject | `WorkLinkRejected` | no |
| correct | `WorkLinkCorrected` | no |
| activity post | `ActivityPosted` | no |
| customer send | `CustomerSendExecuted` | already approved send only |

Existing `mail-send-drafts` `payload_digest` has no WorkLink/Commitment revision. Phase 4 must bind at draft create: `workLinkId`, `workLinkRevision`, `commitmentId`, `commitmentRevision`, `externalId`, `customerExternalId`. Re-check at approve and execute. Do not execute if the link changed to another customer (`customerExternalId` drift). This file does not implement Phase 4 send changes.

## 9. Isolation

Implementation lives in `/home/jm/orca/projects/mail-intelligence-notion-crm-dev` on `feat/notion-crm-worklink-p0-p1`. Operational `/home/jm/orca/projects/mail-intelligence` is not the implementation tree. No `.env`, tokens, or operational SQLite copy. No commit, push, deploy, real send, or Notion POST/PATCH in this review remediation.


## CHECKPOINT — 2026-09-11 Codex V04 fixture remediation

This checkpoint updates the earlier V04-open statements above; their history is retained.
Baseline and HEAD remain `4bd87f15ab6fe0d6f46c949a6d48a26306c92dfb`, with uncommitted DEV changes.

- V01/V02: recovery remains passing in the previously tested failure scope.
- V03: existing three rejection regressions reverified; no schema-validator changes in this slice. Operational schema mapping remains unverified.
- V04: **closed in tested fixture scope**. Capture an ordered mailbox source digest before collection; compare both collected input and current source against it inside the generation-swap `BEGIN IMMEDIATE`, before supersession. ID set, change key, subject/body/sender, conversation, source dates and folder changes are included. Equal counts alone cannot pass.
- On mismatch: `WORKLINK_SOURCE_CHANGED`, no generation swap, previous links/classifications/revision/analysisComplete preserved, `partial/stale=true`; current-source agreement is explicitly unchecked. Retry against stable input is allowed.
- Verify: `TMPDIR=/var/tmp npm run verify:notion-crm-p1a` — **39/39**, exit 0 (re-checked 2026-09-12 resume). Storage/backup/restart isolated regression — 20/20, exit 0 (prior V04 packet).
- Tests include deletion/insertion/equal-count replacement, body/sender/folder change without changeKey bump, changed-then-restored collected input, pre-BEGIN mutation, another mailbox, separate SQLite connection and writer exclusion after validation.
- Source checks stream two additional full mailbox scans and hold the write lock during the final check/swap. Production-scale lock latency and live-source concurrency remain unmeasured. This is local SQLite validation, not Notion CAS or a live collector.
- No new migration or dependency. Rollback only this slice using the completion packet's before hashes and reverse patch after checking later edits; do not discard all uncommitted P1A work.
- **P1A fixture acceptance: ACCEPTED by Jae 2026-09-11/12 (구두 「진행해」).** Ops-scale perf and 3010 cutover remain separate / unauthorized.
- **P1B authorize-to-start (read-only only):** harness + unit tests shipped. Host credential discovery found **no** read-only Notion token/database map → live pull **BLOCKED_ON_SECRET** (re-checked 2026-09-12). No Notion write, send, commit, push, deploy, or 3010 flag change. See `09-P1A-ACCEPTED-P1B-START.md`.
