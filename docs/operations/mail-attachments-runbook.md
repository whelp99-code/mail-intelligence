# Mail attachments and Drive runbook

Synthetic implementation only. Do not treat this file as approval to deploy, send mail, or copy operational secrets.

## Flags and secrets

| Variable | Default | Notes |
|---|---|---|
| `MAIL_ATTACHMENTS_ENABLED` | OFF | Keep OFF until the operator enables attachments after scanner and key review. |
| `MAIL_DRIVE_ENABLED` | OFF | Keep OFF until Google OAuth client, redirect URI, and `drive.file` consent are confirmed. |
| `MAIL_ATTACHMENT_KEY` | unset | 32-byte key outside the database. Missing key fail-closes attachments only. |
| `MAIL_ATTACHMENT_SCANNER_COMMAND` | unset | Fixed argv, `shell:false`. Unconfigured scanner blocks attachments, not text drafts. |
| `MAIL_ATTACHMENT_RETENTION_APPLY` | unset | Retention is dry-run unless this is `1` and `--apply` is used. |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` / `GOOGLE_DRIVE_REDIRECT_URI` | unset | Product-managed OAuth client. Do not copy Codex/Aside tokens. Redirect URI must match the registered value exactly. Do not change Outlook `/auth/callback`. |

Do not put tokens, `.env`, or the operational SQLite file into a development worktree.

## Safe enablement order (requires a later operator approval)

1. Confirm HEAD, service unit, and live DB path read-only. Do not guess from this worktree.
2. Snapshot the database and confirm the attachment key can be restored separately. Never print the key.
3. Apply additive migrations 006 and 007 with flags OFF. Check health and text-only send drafts.
4. Configure scanner and attachment key. Enable `MAIL_ATTACHMENTS_ENABLED` only after a synthetic upload PASS.
5. Configure Google OAuth and enable `MAIL_DRIVE_ENABLED` only after a synthetic connect/import PASS.
6. Live send is a separate approval. Show the recipient, filename, size, SHA-256, and body first. Send one approved item. Graph 202 is not sent. Reconcile attachment bytes. Restore flags to their previous values afterward.

## Failure handling

- Scanner missing or timeout: `503 SCANNER_UNAVAILABLE`. Text drafts continue.
- Drive recheck or connection loss: `409 DRIVE_SOURCE_CHANGED` or `503 DRIVE_RECHECK_UNAVAILABLE`. Do not send the stale copy silently.
- Uncertain Graph receipt: remain `sending`. Do not retry `sendMail`.
- Retention: never apply against `needs_approval`, `approved`, or `sending` drafts.
- Rollback: turn attachment/Drive flags OFF first. Additive migrations are readable by older code for unused tables. Database restore can drop later mail and needs its own approval. Sent mail cannot be recalled by rollback.

## Verification already run in development

See `artifacts/attachments-acceptance/README.md` for synthetic commands. Live Outlook, live Google OAuth, browser operator UI, deploy, and real-mail receive remain `NOT_RUN` until explicitly approved.

### Isolated attachment browser gate

Run `npm run verify:attachments:ui` from a disposable development checkout. It uses synthetic mail, a temporary browser profile, loopback-only app/DevTools listeners, and disabled send/actions; it is not a deployment or live-mail check.

Install Fontconfig (`fc-match`) and system **Noto Sans CJK KR** fonts first. The gate scans `/usr/share/fonts` recursively (including Arch's `noto-cjk` and Debian's Noto directories), never user font directories/configuration, and fails before browser startup if the Korean font is unavailable. Browser font errors or a Skia fatal error after the DevTools readiness line are not evidence of a Host/Origin rejection.

`MAIL_INTELLIGENCE_CHROME=/absolute/path/to/browser npm run verify:attachments:ui` selects an explicit executable (including Chromium). Without it, discovery tries executable `google-chrome`, then `google-chrome-stable` on `PATH`, then `/opt/google/chrome/chrome`. An invalid explicit override fails rather than silently selecting another browser. No `remote-allow-origins` override is needed. Successful runs still enforce Korean glyph rendering, file input, scanner errors, download security headers, keyboard navigation, and mobile layout assertions; screenshots are written under `artifacts/attachments-acceptance` in that checkout.
