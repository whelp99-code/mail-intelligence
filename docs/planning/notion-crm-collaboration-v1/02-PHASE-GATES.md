# Phase gates, verify commands, rollback

> Working copy: DEV worktree. Not operational cutover.
> **P1A fixture acceptance: ACCEPTED by Jae 2026-09-11/12 (구두 「진행해」).**
> Ops-scale perf remains a separate gate. This is not 3010 cutover.
> Resume 2026-09-12: `verify:notion-crm-p1a` 39/39; live collect `BLOCKED_ON_SECRET`.

## P1A vs P1B

| Slice | Meaning | Status |
|---|---|---|
| **Phase 1A** | Fixture pipeline: snapshot → match → atomic WorkLink swap → classification projection | **ACCEPTED (fixture)** by Jae 2026-09-11/12 |
| **Phase 1B** | Live read-only snapshot + incremental collect against the operator workspace | **Authorized to start** — adapter/harness shipped; live pull `BLOCKED_ON_SECRET` until token+map |

Independent review items (fixture only; not production ACK):

| ID | Status | Gate |
|---|---|---|
| V01 BEGIN-fail recovery | closed in tested fixture scope | subsequent refresh keeps last-known-good |
| V02 mid-store / pre-COMMIT fail | closed in tested fixture scope | LKG preserved; attempt recorded partial/stale; retry succeeds |
| V03 schema option / type / 근거등급 | **closed-in-fixture** | delivered schema options + types + evidence-tier enum; see `01-CONTRACTS.md` |
| V04 collection-while-source-changing | **closed-in-fixture** | source digest + in-txn compare; delete/add/same-count swap/body (and related) reject generation swap; LKG preserved |

V04 fixture gate is closed in tested scope (see CHECKPOINT below). Remaining outside P1A fixture acceptance: ops-scale perf/lock timing, live collector with real secrets, and 3010 cutover.

Phase 1B may run (read-only) when:

1. Phase 1A verify commands below are green on the DEV worktree. **(done / accepted)**
2. Read-only Notion secret is separate from any write integration.
3. De-identified schema hash is re-checked against a freshly captured (not committed) operator schema.
4. Source watermark and analysis-complete watermark are reported separately.
5. A stale/partial snapshot keeps last-known-good links and sets `stale=true`.
6. Manual ops ACK for production cutover remains separate (`version`, `hash`, `agent`, `seen_at`, `accepted_scope`, `notion_refetch`).
7. No page POST/PATCH/DELETE against Notion. No send. No 3010 flag change.

## Watermarks

```text
source            = mailbox messages seen while paging
analysisComplete  = last successful WorkLink+classification projection
```

If source moves and analysis does not finish, keep the previous `analysisComplete` value and mark the run `partial/stale`.

## Phase 5 learning (contract only)

- Re-apply: replay an accepted correction onto the same evidence class.
- Generalization: promote an alias/policy only after a separate gate.
- Holdout and rollback are later. Do not treat Activity edits as model training.

## Verify command list

The independent review machine-check had 0 verify commands. Use these.

Phase 1A fixture (required, no live Notion):

```bash
TMPDIR=/var/tmp node scripts/run-tests-isolated.mjs \
  test/work-links.test.js \
  test/work-links-refresh.test.js \
  test/work-links-api.test.js \
  test/work-links-ui.test.js \
  test/notion-schema-contract.test.js \
  test/notion-readonly-collect.test.js \
  test/today-briefing-contract.test.js \
  test/work-link-events.test.js
```

Or:

```bash
TMPDIR=/var/tmp npm run verify:notion-crm-p1a
```

Expected: exit 0. WorkLink A→B / A→unlinked / user-confirmed / 1001-page / abort-resume tests pass. P1B harness tests pass **without** live Notion. No Notion write HTTP.

Phase 1B live collect (optional, secrets required, default OFF):

```bash
MAIL_INTELLIGENCE_NOTION_READONLY=1 \
MAIL_INTELLIGENCE_NOTION_TOKEN_FILE=/absolute/path/mode600.token \
MAIL_INTELLIGENCE_NOTION_DATABASE_MAP=/absolute/path/notion-database-map.local.json \
npm run collect:notion-readonly
```

Without secrets the command exits non-zero with `BLOCKED_ON_SECRET` / `READONLY_DISABLED` and prints discovery **paths/presence only** (never token bytes).

Failure handling:

- Isolated runner (`scripts/run-tests-isolated.mjs`) is mandatory. Bare `node --test` hit disk I/O errors on the reviewer's machine.
- If R1/R2 regressions fail, the review is not satisfied. Do not start Phase 3.
- Partial refresh in product code must return `completeness=partial` and leave good links.
- P1B schema/type failure keeps last-known-good snapshot file and reports `stale=true`.

Rollback:

- DEV worktree only. Discard uncommitted Phase 1A/1B files if the prototype must revert.
- Do not roll back operational `/home/jm/orca/projects/mail-intelligence` — it was not the implementation tree.
- Do not restore or copy operational SQLite / `.env`.
- Disable P1B by leaving `MAIL_INTELLIGENCE_NOTION_READONLY` unset/≠1.

Manual ops gates (every later phase):

1. Named command + expected result (this file).
2. Failure handling (stale flag, no swap, no write).
3. Rollback owner and tree (DEV vs operational).
4. Human ACK for send / money / contract only. Internal allowed jobs do not need a click each time.

## Later phases (not started)

| Phase | Command (to be added when implemented) | Failure | Rollback |
|---|---|---|---|
| 1B live read | `npm run collect:notion-readonly` (flag+secrets); unit: `test/notion-readonly-collect.test.js` | keep last-known-good + stale; `BLOCKED_ON_SECRET` if no token | unset `MAIL_INTELLIGENCE_NOTION_READONLY` |
| 2 briefing | *none yet — do not start Phase 2 today* | empty briefing, no invented prose | disable `/today` flag |
| 3 Activity proposal | *none yet* | outbox stays unsent | reject proposal, no Notion write |
| 4 send digest bind | *none yet* | block execute on customer drift | cancel draft |
| 5 learning | *none yet* | do not generalize from one correction | revert alias/policy version |

## Isolation reminder

No commit, push, deploy, real mail send, or Notion POST/PATCH. DEV path: `/home/jm/orca/projects/mail-intelligence-notion-crm-dev` on `feat/notion-crm-worklink-p0-p1`.


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
- **P1A fixture acceptance: ACCEPTED by Jae 2026-09-11/12 (구두 「진행해」).** Ops-scale perf / 3010 cutover remain unauthorized.
- **P1B:** read-only adapter + recorded-response harness authorized and shipped. Live workspace pull remains **BLOCKED_ON_SECRET** until Jae supplies read-only token path + untracked database map. No Notion write, real mail, commit/push/deploy. See also `09-P1A-ACCEPTED-P1B-START.md`.
