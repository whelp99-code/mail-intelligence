# Attachment migration integration

Date: 2026-09-23

## Decision and scope

Keep attachment migrations 006/007 and principal migration 009 byte-for-byte.
Bridge only pending `009_mail_send_draft_principals.sql` when the exact attachment
006 name and checksum are already recorded. Do not rewrite migration history,
renumber these migrations, disable foreign keys, or repair already-applied 009.

This supersedes the assumption in [M01](M01-copy-classification.md) that ordinary
numeric execution alone can integrate the attachment and Core5 schemas. M01's
checksum-preservation decision remains valid. Removing a file from the manifest
does not itself cause the existing runner to reject its old history row;
renumbering and reapplying its SQL would instead collide with existing objects.
Neither is a substitute for preserving the original migration identities.

The helper is separate from the store to isolate this one historical SQL seam.
The store's existing transaction implementation, including Notion's nested
transaction depth handling, is unchanged.

## Why a bridge is necessary

006 adds `digest_version`, `links_json`, and the child table
`mail_draft_attachments`. 009 rebuilds `mail_send_drafts` without those two
columns. With no bindings, an ordinary rebuild silently loses the metadata;
with bindings, its parent-table drop fails with foreign keys enabled.
A later numbered repair cannot recover lost data or run past that failure.

## Execution contract

1. Read the shipped migration files and validate every matching applied history
   row's name/checksum before executing any pending migration SQL. In particular,
   a mismatch at already-applied 013 must prevent pending 006/007 from writing.
2. Continue numeric, per-migration execution. Already-applied versions are skipped.
3. Inside 009's existing `BEGIN IMMEDIATE` transaction, when exact attachment 006
   is applied:
   - Snapshot every draft's ID, digest version and raw links text in a TEMP table.
   - Snapshot all seven binding columns in another TEMP table.
   - Remove binding rows, leaving their table, constraints and indexes intact.
   - Execute the original 009 source unchanged.
   - Restore the two columns with their exact 006 definitions:
     `digest_version INTEGER NOT NULL DEFAULT 1` and
     `links_json TEXT NOT NULL DEFAULT '[]'`.
   - Restore metadata by draft ID and reinsert all binding columns explicitly.
     JSON is not parsed/reserialized; digests are not recalculated.
   - Assert bidirectional SQL-value equality for both snapshots and an empty
     `PRAGMA foreign_key_check`, then remove the TEMP tables.
4. Insert the ordinary 009 history row with its original name/checksum and commit.

Any bridge, SQL, assertion, or history-insertion error rolls back that entire
migration, including TEMP tables and all original rows/schema. Successful earlier
pending migrations remain committed, as before; this is not a transaction over
all pending versions. Foreign keys stay enabled throughout. A failure is exposed
to the caller; no fallback skips the bridge or guesses missing metadata.

Unchanged SHA-256 values:

| Version | SHA-256 |
| --- | --- |
| 006 | `8b81b2bab51ac5853eb2c37737a9cc1bfd7b2111dd8fe52d4913a892d47cc0df` |
| 007 | `fc30a26dabc761af32f02839b401071d2d67d768da3cb8445c2934fba4b77c4c` |
| 009 | `7995343a55876a27ecb87cb0acda1140e70e527d0c35aaf5daa6dbc1bc5aff18` |

## Supported starting states

| Starting state | Result |
| --- | --- |
| Fresh | 001-008, bridged 009, then 010-013 |
| Existing 005 | Original 006/007, Notion 008, bridged 009, then 010-013 |
| Attachment 007 with populated bindings | Preserve 006/007 history; apply 008, bridged 009, then 010-013 |
| Canonical 013 without 006/007 | Apply original missing 006/007 directly; never rerun 009 or alter existing ownership/reconciliation/outbox rows |

Missing 008 is independently filled by the ordinary runner. Maximum schema
version remains 13; inspect migration membership and actual columns rather than
using `MAX(version)` as evidence that attachments are installed.

Assumptions: the stated starting histories and schemas are authentic, the shipped
manifest contains the integrated migrations, and application writers are stopped
for integration. Unexpected missing attachment columns fail rather than trigger
speculative reconstruction. This does not recover data from a database where 009
was previously applied incorrectly over attachment metadata.

## Focused verification

`test/attachment-migration-bridge.test.js` uses the real store constructor and
migration runner with copied, authentic migration manifests and isolated synthetic
databases. No production databases or external services are accessed.

Coverage includes:

- All four starting states and reopen idempotency.
- Approved/sending/sent drafts from both legacy sources; V1/V2 digest versions;
  raw JSON whitespace/escapes; links-only drafts; payload digests, approvers,
  timestamps, Graph receipt IDs, and event IDs.
- Multiple bindings with noncontiguous ordinals and frozen metadata; byte-exact
  encrypted assets, reservations, Drive connections/grants and original history.
- Existing canonical Jarvis ownership, reconciliation and outbox preservation.
- Deterministic SQL-trigger failures after detachment, before restoration, after
  all bindings are restored, and after 009 history insertion; exact rollback and
  successful retry. A silent binding mutation also trips the preservation check.
- Foreign keys enabled during detachment/restoration, dangling references rejected,
  full SQLite integrity checks, and no leftover TEMP tables.
- Late name/checksum mismatches rejected before pending lower-numbered writes;
  malformed attachment metadata rejected without discarding bindings.

Commands (run from repository root):

```sh
node scripts/run-tests-isolated.mjs test/attachment-migration-bridge.test.js
node --check src/storage/sqlite-store.js
node --check src/storage/attachment-migration-bridge.js
node --check test/attachment-migration-bridge.test.js
./node_modules/.bin/eslint src/storage/sqlite-store.js src/storage/attachment-migration-bridge.js test/attachment-migration-bridge.test.js
```

Full merged-service/send-digest, UI, backup and deployment verification belongs to
the parent integration task. These migration-only tests do not establish live
rollout readiness.
