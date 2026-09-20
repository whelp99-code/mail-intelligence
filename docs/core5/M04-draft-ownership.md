# Core5 M04 — principal-scoped draft ownership

Date: 2026-09-20  
Branch: `core5-m01-m04`  
Depends on: M01 numbering (`006`–`008` reserved for attachments/Drive/work-links)

## Goal

Drafts are owned by a **principal**, not by a single shared `grok-bot` source. JARVIS can create drafts and read **its own** status. Humans still approve/cancel. Existing grok-bot authority is not widened.

## Principals

| Actor | Auth | `source` | `owner_principal` | Allowed |
|---|---|---|---|---|
| Human UI session | cookie + CSRF + origin | `ui` | `human:ui` | create, list, GET, approve, cancel |
| grok-bot | `MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN` | `grok-bot` | `agent:grok-bot` | create + GET own draft only |
| JARVIS | `MAIL_INTELLIGENCE_JARVIS_DRAFT_TOKEN` | `jarvis` | `agent:jarvis` | create + GET own draft only |

Grok token is matched **before** JARVIS. If the two secrets were ever identical, the caller stays `grok-bot` (no auto-expansion into JARVIS). An unset/short JARVIS token disables that principal.

## Kept human gates

Approve/cancel still require a session (not Bearer), CSRF, origin, explicit `confirm`, payload digest, send flag, operator access key, and `Mail.Send` scope. Agents hitting `/approve` or `/cancel` get `HUMAN_APPROVAL_REQUIRED` even if they also send a cookie.

## Rejects

| Case | Result |
|---|---|
| JARVIS GET grok draft (or reverse) | `404 DRAFT_NOT_FOUND` |
| Stolen / unknown Bearer | `401 DRAFT_TOKEN_REQUIRED` |
| Agent + human cookie on approve | `403 HUMAN_APPROVAL_REQUIRED` |
| Agent list | `403 DRAFT_LIST_FORBIDDEN` |
| Unknown source | `400 INVALID_DRAFT_SOURCE` |

## Schema

`migrations/009_mail_send_draft_principals.sql` rebuilds `mail_send_drafts` (child events copied first so FK history is preserved). Existing rows: `ui` → `human:ui`, `grok-bot` → `agent:grok-bot`. Applied `schema_migrations` 001–005 are unchanged; 009 is append-only.

Live DBs at v5 apply 009 on next migrate (`schemaVersion` becomes 9). Versions 6–8 remain unused until copy integration.

## Env

- `MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN` / `_FILE` — unchanged
- `MAIL_INTELLIGENCE_JARVIS_DRAFT_TOKEN` / `_FILE` — optional, ≥32 chars, private file mode

## Tests

- `test/mail-send-drafts.test.js` — distinct principals
- `test/mail-send-api.test.js` — JARVIS draft+status only; other-agent / stolen token / human spoof
- schema assertions updated to v9 where the full migrator runs
