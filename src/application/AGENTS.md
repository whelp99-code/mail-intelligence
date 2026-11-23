# src/application

**Score:** 14. File count, code ratio, symbol density, exports, and reference centrality. Distinct domain: process services between `server.mjs` and `src/domain`.

## OVERVIEW

Service modules for sync, intake, send drafts, work links, and persistent mail memory. No barrel. `server.mjs` imports factories by path.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Graph sync | `mail-sync.js` | Uses `src/domain/mail-normalizer.js` and `src/resilience.js`. |
| Durable mailbox runtime | `persistent-mail-memory.js` | Store, sync, and backup admin share this runtime. |
| Classification service | `precision-intelligence.js` | Calls domain classifier, LLM merge, and search. |
| Intake identity | `intake-identity.js`, `intake-authorization.js` | Fail-closed reverify. Pinned binding is explicit, not observed. |
| Post-sync ingest | `sync-work-intake.js` | `createProductionIntakeBinding` is the server hook. |
| Reply drafts | `reply-draft-pipeline.js` | Plans and annotates. It does not approve or send. |
| Send API | `mail-send-api.js`, `mail-send-drafts.js` | Graph send stays behind the approval boundary. |
| Work links | `work-links.js`, `work-links-api.js` | Candidate links. Confirm and customer send stay separate. |
| Company-memory donor | `company-memory-donor.js` | Outbox publisher. It does not call `sb remember`. |
| Drive OAuth | `mail-drive-api.js`, `mail-drive-connections.js` | Sealed secrets. Google client lives in adapters. |

## CONVENTIONS

- Public surface is `createX` factories, `*Service` classes, or both. Test-only bags end in `Internals`.
- Imports use explicit `.js` paths into `src/domain`, `src/adapters`, and `src/storage`.
- Attachment bytes go through `mail-attachment-assets.js` limits and a scanner port, not an in-process parser.

## ANTI-PATTERNS

- Do not send, mark read, or publish from a service because the UI showed a draft. Approval stays outside this tree.
- Do not write CRM or Notion state from intake. Adapters emit candidates and read snapshots.
- Do not persist a new operational store here. SQLite ownership is `src/storage`.
- Do not hide an AI failure as an unlabeled rules result. Domain merge labels the failure.

## NOTES

Hot files: `reply-draft-pipeline.js` (594), `persistent-mail-memory.js` (508), `company-memory-donor.js` (503). `npm run check` lists many of these files and omits others; a green `check` is not coverage of every service. Tests run via `scripts/run-tests-isolated.mjs`, and only `test/*.test.js` is the default suite.
