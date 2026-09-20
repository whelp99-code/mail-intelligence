# Core5 M01 — copy classification vs main

Date: 2026-09-20  
Canonical checkout: `/home/jm/orca/projects/mail-intelligence` (`main` @ `4bd87f1`)  
Work branch: `core5-m01-m04`  
This document classifies uncommitted feature copies. It does **not** merge code.

## Copies in scope

| Copy | Path | Git ref | Tip vs main |
|---|---|---|---|
| Canonical | `/home/jm/orca/projects/mail-intelligence` | `main` | `4bd87f1` (005 schema, drafts/send) |
| Attachments / Drive | `/home/jm/orca/projects/mail-intelligence-attachments-dev` | `codex/mail-attachments-drive-v1` | same commit; **dirty working tree** |
| Notion work-links | `/home/jm/orca/projects/mail-intelligence-notion-crm-dev` | `feat/notion-crm-worklink-p0-p1` | same commit; **dirty working tree** |

Both feature branches are worktrees of this repo. They share `4bd87f1` with `main`; all feature work is uncommitted in those trees.

Planning trees also exist untracked on `main`:

- `docs/planning/attachments-drive-v1/`
- `docs/planning/notion-crm-collaboration-v1/`
- `docs/planning/mail-attachments-drive-cursor-plan-20260910.zip`

## Do not merge (junk / personal / cache)

| Item | Why |
|---|---|
| `node_modules` (symlink to canonical in both copies) | dependency cache |
| `data/` in both copies | runtime SQLite, QA leftovers, compile cache |
| `artifacts/` (attachments copy) | local run output |
| `docs/handover/00_INBOX/` (notion copy) | personal/operator inbox |
| `docs/handover/GROK-BOT-MAIL-AGENT-SEND-INSTRUCTIONS-KO.md` (canonical untracked) | out of M01 feature merge |
| `*.log`, `node-compile-cache`, `.chatgpt2codex/` | probe/cache, not product |
| Live tokens / `.outlook-config.json` if present | secrets |

## Feature A — mail attachments (keep, integrate later as 006)

Source: attachments-dev untracked + modified.

**Keep (new files)**

- `migrations/006_mail_attachments.sql`
- `src/storage/mail-attachment-crypto.js`
- `src/adapters/attachment-scanner.js`
- `src/application/attachment-policy.js`
- `src/application/attachment-retention.js`
- `src/application/mail-attachment-api.js`
- `src/application/mail-attachment-assets.js`
- `scripts/mail-attachment-retention.mjs`
- `scripts/verify-attachment-browser-ui.mjs`
- tests: `test/attachment-*.test.js`, `test/mail-attachment-*.test.js`, `test/mail-attachments-e2e.test.js`
- `docs/planning/attachments-drive-v1/`, `docs/operations/` (ops notes for this feature)

**Keep (modified integration points — cherry-pick, do not overwrite main blindly)**

- `server.mjs`, `package.json`
- `src/adapters/microsoft-graph-send.js`
- `src/application/mail-send-api.js`, `src/application/mail-send-drafts.js`
- `src/index.html`, `src/send-review.js`, `src/styles.css`
- `src/storage/backup-restore.js`
- verify scripts + existing tests that bump `schemaVersion` expectations

Schema: draft `digest_version` / `links_json`; tables `mail_attachment_assets`, `mail_draft_attachments`, `mail_attachment_reservations`.

## Feature B — Google Drive connections (keep, integrate later as 007)

Same copy as A.

**Keep**

- `migrations/007_mail_drive_connections.sql`
- `src/adapters/google-drive-client.js`
- `src/application/drive-links.js`
- `src/application/mail-drive-api.js`
- `src/application/mail-drive-connections.js`
- tests: `test/drive-links.test.js`, `test/google-drive-client.test.js`, `test/mail-drive-api.test.js`, `test/mail-drive-oauth.test.js`

Schema: `mail_drive_connections`, `mail_drive_file_grants`.

## Feature C — Notion / work-links (keep, integrate later as 008)

Source: notion-crm-dev.

**Keep (new files)**

- `migrations/006_work_links.sql` → **retarget to `008_work_links.sql`** (see clash)
- `src/adapters/notion-readonly-collect.js`
- `src/adapters/notion-schema-contract.js`
- `src/adapters/notion-work-system.js`
- `src/adapters/work-system-port.js`
- `src/application/work-links-api.js`
- `src/application/work-links.js`
- `src/domain/today-briefing-contract.js`
- `src/domain/work-link-events.js`
- `src/domain/work-link-projection.js`
- `scripts/collect-notion-readonly-snapshot.mjs`
- `scripts/verify-notion-crm-p1a.mjs`
- tests + deidentified fixtures under `test/fixtures/notion-*.json`
- `docs/planning/notion-crm-collaboration-v1/`
- `.env.example` / `.gitignore` deltas for Notion snapshot paths (review; no secrets)

**Keep (modified integration points — cherry-pick)**

- `server.mjs`, `src/app.js`, `src/index.html`, `src/styles.css`
- `src/storage/sqlite-store.js` (store APIs for work_links only)
- tests that assert schema version

## Shared-file collision (later merge, not this commit)

Both copies edit `server.mjs`, `package.json`, UI (`index.html`, `styles.css`), and several generic tests (`runtime-storage-migration`, `sqlite-store`, `backup-restore`, `server-security`, `precision-*`). Integrate feature-by-feature with three-way merge against `4bd87f1`. Do not copy an entire `server.mjs` from either tree.

## 006 migration clash — resolution

### Runner contract (`src/storage/sqlite-store.js` `migrate()`)

- Files sorted by numeric version from the filename.
- `schema_migrations(version PK, name, checksum, applied_at)`.
- If `version` already applied: **name and checksum must match exactly** or the process throws `Migration ${version} checksum or name changed after application.`
- Applied rows are never rewritten. History is append-only.

### Observed apply history

| Database | Max version | Name of 006 |
|---|---|---|
| Canonical live `data/mail-intelligence.sqlite` | **5** (`005_mail_send_drafts.sql`) | unused |
| Canonical backups | 4 or 5 | unused |
| Attachments-dev `data/tmp/test-*/mail-intelligence.sqlite` | **7** | `006_mail_attachments.sql` |
| Notion-crm-dev | **no sqlite** with `schema_migrations` | unused |

Checksums of uncommitted SQL (sha256 prefix 16):

- `006_mail_attachments.sql` `8b81b2bab51ac585`
- `007_mail_drive_connections.sql` `fc30a26dabc761af`
- `006_work_links.sql` `103c19cf1d425140`

### Decision: unused-number retarget (not in-place rewrite)

1. **Keep** attachments `006_mail_attachments.sql` and `007_mail_drive_connections.sql` numbers. They already exist in that copy’s applied test DBs. Renaming them would break those DBs via checksum/name check.
2. **Retarget** Notion `006_work_links.sql` → **`008_work_links.sql`** (same SQL body). Version 8 is unused everywhere surveyed. Notion has no applied `006_work_links` row, so rename is safe; no forward-compat shim required.
3. **Do not** reuse version 6 for work_links. Two different files at version 6 would make any DB that applied attachments-006 fail checksum if pointed at work_links, and vice versa.
4. **Do not** edit applied `schema_migrations` rows. Preserve history.
5. Forward-compat path (not needed now): if a Notion DB later appears with `(6, 006_work_links.sql, <checksum>)`, keep that file at 006 for that isolated DB only, or add a no-op 006 + new 008 with `CREATE TABLE IF NOT EXISTS` — never change checksum of an applied version. Survey found no such DB.

### Target numbering after integration

```text
001_persistent_mail_memory.sql          (main, applied)
002_schema_metadata.sql                 (main, applied)
003_operational_memory_foundations.sql  (main, applied)
004_precision_classification.sql        (main, applied)
005_mail_send_drafts.sql                (main, applied)
006_mail_attachments.sql                (from attachments-dev; unused on main)
007_mail_drive_connections.sql          (from attachments-dev; unused on main)
008_work_links.sql                      (from notion-crm-dev 006, retargeted)
```

Main live DB will apply 006–008 on next migrate because 6–8 are not in its `schema_migrations`. Attachments-dev test DBs already at 7 will skip 006/007 (checksum match) and apply 008 when that file is present. Notion trees that never applied 006 will apply 006, 007, then 008 in order.

## M01 out of scope

- No code merge, no push, no deploy.
- M04 (principal-scoped draft ownership) waits for coordinator C02 commit confirmation.

## Verification (this commit)

- Worktrees listed; git tips equal `4bd87f1`.
- Runner + `schema_migrations` inspected in live and copy DBs.
- Classification file only on `core5-m01-m04`.
