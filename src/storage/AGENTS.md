# src/storage

**Score:** 9. Code ratio, symbol density, exports, and reference centrality. Distinct domain: SQLite operational store, legacy import, and backup.

## OVERVIEW

`node:sqlite` `DatabaseSync` persistence. Paths resolve from env against `server.mjs`. There is no query framework and no `better-sqlite3`.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Store | `sqlite-store.js` | `SQLiteMailStore`. 2788 lines. Applies SQL under `migrations/`. |
| Paths | `storage-paths.js` | `MAIL_INTELLIGENCE_DATA_DIR`, `DB_PATH`, `LEGACY_CACHE_PATH`, `CONFIG_PATH`. |
| Legacy JSON | `legacy-import.js` | One-way import from `.mail-cache.json`. Not a second live store. |
| Backup | `backup-restore.js` | Verified backup, SHA-256, restore, attachment check. |
| Attachment crypto | `mail-attachment-crypto.js` | `parseAttachmentKey` is what `server.mjs` imports. |
| Draft principal bridge | `attachment-migration-bridge.js` | Called from the store. Do not rerun migration 009 by hand. |

## CONVENTIONS

- Operational database is SQLite. PostgreSQL is out of scope until multi-user concurrency is required.
- Migrations are numbered `001`–`015` `.sql`, `CREATE TABLE ... STRICT`, text timestamps. Applied rows are append-only.
- Checksums and prior facts stay as history. A current row must not erase the prior revision.
- Admin entry is `scripts/mail-memory-admin.mjs` (`memory:status`, `memory:integrity`, `memory:backup`), not a method on the HTTP server.

## ANTI-PATTERNS

- Do not treat a JSON cache as the operational database. Import it, then stop writing it.
- Do not edit applied `schema_migrations` rows or reuse a version number.
- Do not rewrite ownership, reconciliation, or outbox rows to "fix" a migration.
- Do not open a second database connection module. Callers use `SQLiteMailStore`.

## NOTES

Restore of a live file needs a stopped process (`restore ... --confirm-stopped` on the admin script). `npm run verify:backup:isolated` exercises `backup-restore.js` off the live file. Isolated tests must keep using the temp dir from `scripts/run-tests-isolated.mjs`.
