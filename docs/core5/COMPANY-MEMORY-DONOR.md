# Mail company-memory donor

Status: Mail-side publisher and CRM-consumable outbox implemented in-process.
Server tick is env-gated and off by default. No live company-memory writes
unless the four `COMPANY_MEMORY_*` files are set. Inbox ingest still does not
enqueue. A send draft that reaches status `sent` inserts one keys-only
`INBOX_RECEIVED` outbox row keyed by `draft_id` (idempotent).

This repository publishes toward the Second Brain `sb-company` contract
(`second-brain-app/docs/core5/COMPANY-MEMORY-DONOR-CONTRACT.md`). The donor
builds one canonical `{authority, arguments}` receive envelope, signs it with
operator-injected Ed25519 material, and marks a Mail outbox row `EMITTED`
only after `sb-company` exit 0 and a matching workspace, request digest,
operation, candidate ID, and resulting state (`candidate` for receive).

Timeout, non-zero exit, malformed stdout, or receipt mismatch leave the row
`PENDING`. Replay of an already-emitted row is a no-op.

## Mail-only outbox interface

Source events are keys-only rows in migration `013_mail_company_memory_outbox`
(`INBOX_RECEIVED`, `WORK_LINKED`, `WORK_LINK_CORRECTED`). The publisher derives
workspace, provider, mailbox, source locator, and source event from an
authenticated Mail source record supplied by the caller. Company names are not
identity. Outbox payloads stay keys-only; content is not copied from the
outbox row. Mail text is evidence, not mutation authority.

Entry points:

- `enqueueMailCompanyMemoryOutbox` — durable Mail-side emission into the CRM-consumable outbox
- `enqueueSentDraftCompanyMemoryOutbox` — fail-closed send-receipt enqueue keyed by `draft_id`
- `publishCompanyMemoryDonor` — one tick over pending Mail outbox rows
- `createMailProductDonorPort({ db, resolveSource })` — adapter CRM can call once it has a Mail database
- `createMailProductDonorPort()` — fail-closed `MAIL_ADAPTER_NOT_IMPLEMENTED`
- `CwosWorkSystemAdapter.createMailProductDonorPort()` — fail-closed `MAIL_ADAPTER_NOT_IMPLEMENTED`

The publisher never calls `sb remember`, `/api/remember`, `sb_remember`,
personal search, or a personal vault. Transport is an injected
`CompanyMemoryCliTransport` (`sb-company` stdin/stdout shape only).

Server bind (`src/application/company-memory-donor-bind.js`) is explicit-env
only: `COMPANY_MEMORY_SB_COMPANY`, `COMPANY_MEMORY_SB_COMPANY_CONFIG`,
`COMPANY_MEMORY_SIGNING_KEY_FILE`, `COMPANY_MEMORY_AUTHORITY_FILE`. Absent =
skipped. Incomplete, unknown, or missing files fail closed at server boot.
The command must be an absolute `sb-company` path; personal `sb` is rejected.
When a Mail sqlite db is bound, the tick reads pending rows from
`mail_company_memory_outbox` and fails closed if that schema is unavailable.
Empty outbox is used only when no db is passed. Tests may still inject a
synthetic outbox. Spawned `sb-company` gets `SB_CONFIG` pointed at a
non-existent sibling of the company config so the live launcher cannot fall
back to personal `~/.config/second-brain/config.toml`.

This is Mail → `sb-company`, not a CRM ingest adapter. Mail does not insert
into CRM `cwos_v2_mail_outbox`. CRM still consumes Mail by calling the Mail
port against Mail's outbox once it has a Mail database.

CRM `4df9f80` still documents `createMailProductDonorPort()` as unimplemented
in the CRM repository. That stub must not be replaced by this Mail publisher.
CRM consumes Mail by calling the Mail port against Mail's outbox, not by
copying Mail rows into CRM schema.

## Authority / key ownership

Mail does not ship or invent a shared signing key with Second Brain or CRM.

- Mail signs with an operator-injected signer (key id + Ed25519 signature over
  the company-memory authority domain).
- Second Brain verifies with operator-configured `trusted_keys` on the
  `sb-company` config.
- Matching those two sides is an operator/JARVIS provisioning decision, not a
  value this package may mint.

Tests generate ephemeral keypairs. No production key, secret, or company
database path is read by this increment.

### Operator pairing (required before any live tick)

1. Generate an Ed25519 keypair in the operator secret store. Do not commit it.
2. Put the key id and unpadded base64url raw public key into Second Brain
   `trusted_keys`.
3. Inject the matching private signer into Mail at process composition time.
4. Inject the current trusted context (canonical workspace UUID, provider,
   principal/agent/session, projects, policy revision, deletion high-water).
5. Set the four `COMPANY_MEMORY_*` env vars to the absolute `sb-company`
   command, company-memory config, signing key PEM, and authority JSON.

Ephemeral test keys are not that pairing. Absent env keeps the tick skipped.
