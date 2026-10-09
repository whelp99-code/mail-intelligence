# Mail company-memory donor

Status: Mail-side publisher and CRM-consumable outbox implemented in-process.
Server tick is env-gated and off by default. No live company-memory writes
unless the four `COMPANY_MEMORY_*` files are set. Inbox ingest still does not
enqueue. A send draft that reaches status `sent` inserts one keys-only
`INBOX_RECEIVED` outbox row keyed by `draft_id` (idempotent).

## FP5 M2 source and intake evidence contract

Message-source resolution requires both the graph `sourceLocator` and the
`sourceEventId` (graph ID or internet message ID) to identify the same
non-deleted message in the bound mailbox. Matching only one key cannot
publish another message's content under a different event identity.

Native Mail intake persists a `mail_source` evidence entry with mailbox,
message, thread, internet message ID, received time, source URL, change
revision, observation time, and attachment IDs/metadata/revisions. When an
automatic candidate's source changes, its prior snapshots are retained as
`mail_source_revision` entries. Identical replay does not duplicate those
entries. Confirmed, rejected, or user-corrected links remain protected by
the existing upsert guard. An attachment-only change during the awaited
master read fails with `INTAKE_SOURCE_CHANGED` before classification or
candidate commit, just as a message change does.

This is additive evidence JSON in the existing `mail_work_links` table;
no migration or credential is required. Existing records acquire current
source evidence on their next eligible intake; missing historical source
snapshots are not fabricated. Rollback leaves the added evidence readable
as JSON; older code may overwrite it on later automatic refresh, so retain
the database backup before a later operational rollback. This local change
does not provision a donor binding, write CRM state, or enable publication.
Inbox intake still does not enqueue company-memory rows.

## FP5 MS-local installed-CLI boundary

The receive envelope is keys-only: `candidate_id`, `source_system`,
`source_locator`, `source_event_id`, `content_digest`, `parser_version`,
and `locator`. It contains no source `content`. The digest is SHA-256 of
the resolved source text's original UTF-8 bytes; `sb-company` resolves
those bytes from its operator-configured source profile and verifies the
exact system/event/parser/digest binding before storage.

Received-message source parser `mail:company-memory:2` preserves stored
text bytes instead of trimming or NFC-rewriting them. Its locator kind
is consistently `mail_message` across inbox/work outbox events so the
same source cannot collide with its own immutable candidate. Existing
sent-draft parser semantics are unchanged. A v2 profile is explicit;
old profile/candidate revisions are not rewritten or silently migrated.
Live cutover still requires registered operator authority and approved
versioned source snapshots/profile.

The production bind registers each resolved original before receive with
`sb-company register-source --config CONFIG`. Registration stdin is the
same signed receive `{authority, arguments}` plus top-level `content`;
the original UTF-8 text is not trimmed or rewritten. Only exit 0 with
`registration.state=registered` and the matching source locator/digest
admits the subsequent keys-only receive. Registration failure or mismatch
leaves PENDING with `COMPANY_SOURCE_REGISTRATION_FAILED` or
`COMPANY_SOURCE_REGISTRATION_MISMATCH`; the next tick registers again.
Only the matching receive receipt may mark EMITTED. No signing-key rotation
or fact confirmation is part of registration.

SB owns atomic original/config publication. Its CLI requires write access
to the company source directory and config directory for rename/locking;
an approved live activation must admit those paths in the owned unit.
This increment adds no env, database migration, unit, or live activation.
Rollback to the prior sender keeps registered originals/profile bindings
on the SB side; it does not delete source evidence or rewrite keys.

The bound CLI subprocess has a 10-second kill deadline and clears it on
exit; a nonzero exit or unmatched receipt never acknowledges the outbox.
An emitted receive receipt means a company-memory **candidate**, not a
fact approval or execution permission.

The source-bound local QA command is:

```text
node scripts/verify-company-memory-installed-cli.mjs /absolute/admitted/sb/.venv/bin/sb-company /absolute/admitted/sb
```

This FP5 harness pins the admitted S1 resolver/test hashes and requires
the CLI to belong to that checkout. It uses owned temporary Mail/company
stores, source files and explicitly authorized fixture signing material.
It verifies real receive/read/replay, original/corrected retention,
workspace/signature/source denials without ack, the bound tick, and
cleanup. It is separate from portable Mail unit tests because an
installed admitted SB CLI is a required integration dependency; assertions
are not skipped when that dependency is missing.

Requirement coverage: REQ-MAIL-005/007/008, REQ-INT-004/011 and
REQ-KNOW-004/006/011. Local regressions are in
`test/mail-work-intake-provenance.test.js` and
`test/company-memory-donor-bind.test.js`. Live workspace/grant/signature
acceptance remains a separate gate.

This repository publishes toward the Second Brain `sb-company` contract
(`second-brain-app/docs/core5/COMPANY-MEMORY-DONOR-CONTRACT.md`). The donor
builds one canonical `{authority, arguments}` receive envelope, signs it with
operator-injected Ed25519 material, and marks a Mail outbox row `EMITTED`
only after `sb-company` exit 0 and a matching workspace, request digest,
operation, candidate ID, and resulting state (`candidate` for receive).

Timeout, non-zero exit, malformed stdout, or receipt mismatch leave the row
`PENDING`. Replay of an already-emitted row is a no-op.

## Mail-only outbox interface

Committed received intake retains source mail, classification and local link
evidence, but does not automatically enqueue MS or POST CRM candidates for
`reference` classifications whose work-state evidence rule is
`promotional-no-explicit-user-action`, `marketing-reference`,
`automatic-notification-reference`, `automated-notification-reference`, or
`low-value-automated-reference`. These cover both clause and event-frame
classifications. The intake summary reports these separately
as `candidateSkipped` with `NON_BUSINESS_REFERENCE`; the completed audit
records `candidatesSkipped`. They remain accepted mail, not intake failures.
Explicit corrections and confirmed customer/project assignments outrank this
automatic gate. Ordinary reference knowledge and actionable automated
business mail retain the existing candidate flow.
Current-body concrete business requests take precedence over these reference
rules even for no-reply/alert senders or marketing wording. The gate reuses
the classifier's direct-request and business-object checks after splitting
quoted history; quoted requests, negations and conditional contact footers
do not grant that exception.

Coverage: REQ-MAIL-007/008 and REQ-INT-004/011 in
`test/sync-crm-candidates.test.js`. No migration, env or approval boundary is
added. Rollback restores the previous automatic candidate selection only;
retained source evidence and existing SB/CRM candidates are not deleted.

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
