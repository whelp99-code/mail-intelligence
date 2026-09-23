# Mail company-memory donor

Status: Mail-side publisher and CRM-consumable outbox implemented in-process.
Not deployed. No live company-memory writes. No production bind. Server ingest
and send paths are unchanged.

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
- `publishCompanyMemoryDonor` — one tick over pending Mail outbox rows
- `createMailProductDonorPort({ db, resolveSource })` — adapter CRM can call once it has a Mail database
- `createMailProductDonorPort()` — fail-closed `MAIL_ADAPTER_NOT_IMPLEMENTED`
- `CwosWorkSystemAdapter.createMailProductDonorPort()` — fail-closed `MAIL_ADAPTER_NOT_IMPLEMENTED`

The publisher never calls `sb remember`, `/api/remember`, `sb_remember`,
personal search, or a personal vault. Transport is an injected
`CompanyMemoryCliTransport` (`sb-company` stdin/stdout shape only).
`server.mjs` does not invoke this tick.

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
5. Leave `server.mjs` unbound until that pairing exists.

Ephemeral test keys are not that pairing.
