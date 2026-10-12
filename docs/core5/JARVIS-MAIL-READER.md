# JARVIS summary-only Mail reader

Requirement: TASK-MAIL-JARVIS-READER-20261012 / Issue60.
Scope: REQ-MAIL-002, REQ-INT-008, REQ-KNOW-004 and the existing local
authentication boundary. No schema migration or production activation.

## Contract

Disabled by default. An operator registers one instance-scoped service principal
through startup configuration, with a separate, already-issued key in a regular
file owned by the Mail service user and mode `0600`. Symlinks, relative paths,
unsafe permissions, malformed configuration and reuse of a human or draft token
fail startup. No registration/issuance HTTP endpoint or credential generator exists.

The existing W06 native reader is an **outbound Mail-to-CRM client**. It uses
`x-api-key`, `x-principal-id`, `x-principal-kind: service` and CRM workspace headers.
It does not sign requests. This inbound Mail reader follows its separate
principal/private-key pattern, not CRM's principal database or signing protocol.
There is no request signature, nonce or replay prevention: repeated summary reads
are allowed. Use loopback or the existing authenticated TLS ingress; never send
the key over plaintext outside loopback.

Only this request is admitted:

```http
GET /api/storage/status
Accept: application/json
x-api-key: <operator-issued reader key, not shown>
x-principal-id: jarvis-mail-summary-reader
x-principal-kind: service
```

There are no query parameters. Mail's scope is this instance's aggregate stored
message/thread counts, not a caller-selected mailbox or CRM workspace. Do not
send `x-workspace-id`, `Cookie`, or `Authorization`: mixed authority is denied.
Unknown principals, missing/invalid credentials and disabled bindings return401;
out-of-scope methods/paths and mixed credentials return403.

```json
{"ready":true,"counts":{"messages":2,"threads":1}}
```

No message content, subject, address, backup/job metadata, config, CSRF token,
session cookie or other table counts are returned. Counts represent stored rows,
matching the original endpoint's contract; they are not unread or inbox-only counts.
An empty database returns counts0 without creating a mailbox.

The reader uses the store's read-only status queries. It must not call
`PersistentMailMemoryRuntime.storageStatus`, whose `syncStatus` ensures/upserts a
mailbox. It never classifies, synchronizes, creates drafts or changes source state.
The central gate runs before session issuance, OAuth, static files and all API
dispatch. Adding a cookie or a stronger token does not widen this principal.
Human Basic/session/CSRF behavior stays unchanged when service headers are absent.

## Orca-JARVIS PR77 compatibility

Compared at `5dce93911fb8e28226b7f70f07dff9fff9af1c9d`.
PR77's `src/personal-connector-mail-source.ts` performs
`GET /api/storage/status` with `Cookie: mi_session=...`, and consumes only
`ready`, `counts.messages`, `counts.threads`. Endpoint and consumed response
shape remain compatible.

**The JARVIS side must change** before production connection:

- Replace `JARVIS_MAIL_SESSION_FILE` / `mail.session_file` with
  `JARVIS_MAIL_READER_KEY_FILE` / `mail.reader_key_file`.
- Add `JARVIS_MAIL_READER_PRINCIPAL_ID` / `mail.reader_principal_id`.
- Keep `JARVIS_MAIL_BASE_URL` / `mail.base_url`.
- Read its own private key file, emit the three service headers above, and remove
  the Cookie header entirely. Do not acquire or renew a human session.
- Use manual redirect handling; never forward the key to another origin.
  Keep the existing fail-closed unavailable/no-data projections.

These new JARVIS names are the proposed consumer contract, not an assertion that
PR77 already implements them. This Mail PR does not edit JARVIS.

## 운영 메모

Do not execute these steps until operator approval of the reviewed release.
This task generates no operational key and registers nothing in production.
The operator issues a distinct key outside this workflow; never paste it into
shell arguments, chat, PRs, environment variables or logs.

Recommended Mail file:
`/home/jm/.config/mail-intelligence/jarvis-reader.key`, owned by `jm`, mode0600.
The reader key must differ from Mail's access key, Grok/JARVIS draft tokens and
all other service credentials. Supply JARVIS its own service-owned0600 copy or
appropriate `LoadCredential` provisioning; do not share a human session file.
For a jarvis-svc installation the proposed consumer path is
`/var/lib/jarvis-svc/config/orca-jarvis/mail-reader.key`.

Principal registration is the explicit startup binding, not a CRM registration
command. After securely provisioning the file, the existing operator launch can
register it with:

```sh
env MAIL_INTELLIGENCE_JARVIS_READER_ENABLED=1 \
  MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID=jarvis-mail-summary-reader \
  MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE=/home/jm/.config/mail-intelligence/jarvis-reader.key \
  node server.mjs
```

For the existing user service, persist those same three names through its
operator-managed environment configuration. The registration command is:

```sh
systemctl --user edit mail-intelligence.service
```

Add the following only to the approved operator-owned override, preserving
existing runtime/safety settings:

```ini
[Service]
Environment=MAIL_INTELLIGENCE_JARVIS_READER_ENABLED=1
Environment=MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID=jarvis-mail-summary-reader
Environment=MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE=/home/jm/.config/mail-intelligence/jarvis-reader.key
```

Check effective merged configuration because later EnvironmentFile/drop-in
assignments can override it. File-only inspection, without printing its content:

```sh
stat -c '%a %U' /home/jm/.config/mail-intelligence/jarvis-reader.key
```

Expected `600 jm`. Adopt/restart through the existing separately approved release
procedure; neither restart nor deployment is authorized by this document.
Credentials are loaded once at startup. Rotate by replacing the private file and
restarting both bindings through that procedure. Revoke by setting ENABLED0 and
restarting Mail; deleting/changing the file alone does not revoke a running binding.
Rollback: disable the three reader settings and use the prior release. No data
migration or cleanup is required. Do not fall back to a session cookie.

## Verification

All credentials in the fixture are fixed public synthetic material, not issued
keys. `node scripts/verify-jarvis-mail-reader.mjs` runs the actual product entrypoint
against temporary SQLite and a rejecting loopback provider, captures real HTTP
status/headers/body, and verifies no SQLite delta, provider call or session.
It proves forbidden reads, send/draft/mutation/sync methods, wrong/missing/mixed/
disabled identity, empty data and adjacent human session/CSRF behavior.
Every child server and temporary directory is torn down even after failure.

```sh
node scripts/run-tests-isolated.mjs \
  test/jarvis-mail-reader.test.js test/jarvis-mail-reader-http.test.js
```

Authentication and scope coverage is fail-closed even with external capabilities
enabled in the isolated fixture. No live Mail/JARVIS service, data or key is used.
