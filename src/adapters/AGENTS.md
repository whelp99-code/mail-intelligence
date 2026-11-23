# src/adapters

**Score:** 9. Code ratio, symbol density, exports, and reference centrality. Distinct domain: ports to Graph, Notion, CWOS, Drive, and the attachment scanner.

## OVERVIEW

One module per external system. No barrel. Callers import the file. This tree reads or proposes; it does not own SQLite or the approval record.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Mail sync client | `microsoft-graph-mail.js` | `GraphMailClient`, `GraphMailError`. |
| Mail send client | `microsoft-graph-send.js` | `hasMailSendScope` is a fail-closed preflight, not signature verification. |
| Notion snapshot | `notion-work-system.js`, `notion-readonly-collect.js` | Collect refuses PATCH, PUT, and DELETE. |
| Notion schema | `notion-schema-contract.js` | Frozen Korean property names. |
| CWOS masters | `cwos-master-reader.js` | Two GETs are not an atomic snapshot. Binding is explicit. |
| CWOS candidates | `cwos-work-system.js` | Emits candidate links. Never writes CRM or Notion. |
| Drive | `google-drive-client.js` | Pinned Google origins and `drive.file` plus openid/email. |
| Attachment scan | `attachment-scanner.js` | Command scanner port used by `server.mjs`. |
| Port contract | `work-system-port.js` | Frozen work-object and link-status enums. |

## CONVENTIONS

- Public errors are `Object.assign(new Error(code), { code, statusCode })`. Only `GraphMailError` is a subclass.
- Notion readonly enablement is the string `'1'`, not a generic truthy check.
- Workspace export MIME types are a frozen table, not a free-form converter.
- `npm run check` syntax-checks some of these files and skips `attachment-scanner.js`, `cwos-work-system.js`, `google-drive-client.js`, and `microsoft-graph-send.js`.

## ANTI-PATTERNS

- Do not add a write method to the Notion collect client. Readonly is the contract.
- Do not take workspace, base URL, or credential from anywhere but the explicit binding.
- Do not treat a Drive or Graph client as the operational database.
- Do not enable Notion collect on the ops `3010` process. The env example leaves it off.

## NOTES

Largest file is `notion-readonly-collect.js` (695). Snapshot collect is `npm run collect:notion-readonly`. Token values stay out of logs; metrics are counts and hashes.
