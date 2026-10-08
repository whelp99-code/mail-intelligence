# FP5 isolated Mail native consumers

MR and MT are explicitly injected local consumers. They do not configure a
live account, register authority, activate a server binding, or replace a
native human approval UI. Generic CWOS writes remain disabled.

## W06 native-v2 archive reader

`CwosMasterReader` uses only GET `/api/cwos/v2/state` and GET
`/api/cwos/v2/normalized-projections/:planId`, with trusted `x-api-key`,
`x-workspace-id`, `x-principal-id` and machine `x-principal-kind` headers.
The old v1 list routes are not a fallback. Configuration additionally requires
`MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID`, `MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND`
(`ai` or `service`) and `MAIL_INTELLIGENCE_CWOS_PLAN_ID`. Their live values must
come from the existing scoped CRM binding and persisted applied plan, not a
mailbox/Graph identity or a fixture. Partial configuration fails closed.

The response requires an ACTIVE native managed workspace, matching active
principal/membership, workspace at
envelope/state/projection/row levels, exact plan identity and archive authority.
Matching native archive references must retain `approved=false` and bind the
projection's semantic source digest/revision. Older references remain history.
Accounts and engagements are unconfirmed Mail link candidates, never native
work; persisted evidence retains archive authority, source plan/snapshot/hash/
version and reader principal separately from Graph identity. The two reads
remain explicitly non-atomic. Finance values are not imported as a new ledger.

### Explicit account-master GET

`MAIL_INTELLIGENCE_CWOS_ACCOUNT_MASTER_GET=1` selects the account-only contract
admitted by CRM PR56. It requires `service` identity and the existing private
key reference. After the same native workspace/principal/membership checks,
the reader uses GET `/api/cwos/accounts` with matching scope headers and no
step-up header. CRM must independently enable
`CWOS_V2_MAIL_READER_ACCOUNT_MASTER_GET=1`; this client does not change that
policy or activate a service.

Account rows are scoped by the authenticated server query, not a fabricated
row workspace field. Any returned explicit scope must still match. Count
mismatch, duplicate IDs, provider denial and redirects fail closed. No
engagement, finance or mutation route is called. Candidates retain
`ACCOUNT_MASTER_READ_ONLY` authority, semantic source digest and reader
identity, with `approved=false`, `nativeWork=false` and non-atomic read times.
This explicit mode does not use an archive plan or fall back on denial.
With the flag absent/zero, the archive reader and its required plan remain
unchanged. No schema migration or operational activation is included.

`verify-cwos-v2-master-reader.mjs` reuses the admitted CRM R1/RS scratch-template,
native HTTP commands and actual PG reader, with no network listener. Synthetic
archive rows are explicit owned-fixture initialization; service reads cannot
reconcile or mutate native state. It verifies replay, persisted Mail re-read,
quarantine/scope/actor denials, unchanged native state/audit/money and cleanup.
The subsequent read-only binding hardening has separately pinned app/auth/
real-PG-test bytes; it is not falsely covered by the historical R1 eight-pin
admission. A changed producer pin refuses before owned fixture creation.

## MR: source and correction to maintained CRM v2

`CwosMailCommandClient` uses the maintained state/command HTTP routes and
explicit server-bound workspace/principal/kind/API key. No actor comes from
mail content. `MailWorkIntakeService.receiveInCrm` exports an original
received date and stored-body digest. Source occurrence IDs include company
workspace, mailbox and a fingerprint of message/thread/internet ID/source
revision/attachment metadata; observation time is not a new occurrence.

`mapInCrm` requires a persisted explicit correction. Mapping is a separate
native human handoff, not machine step-up or archive approval. The client
checks scope before HTTP and requires a matching source/target receipt.
Stable command keys let the native PG manager handle replay, CAS and audit.
An ambiguous/lost transport result is retried with the same operation key,
not a new effect. Source/correction snapshots are rechecked before dispatch.

Archive references remain ARCHIVE_PROJECTION_ONLY/approved=false.
`business.reconcileNormalized` remains the producer's human-only command;
the Mail client does not expose an archive-to-approval bypass.

## MT: scoped original attachment to native Price upload

`PriceAttachmentUploader.proposal` captures a currently exposed, clean and
extraction-authorized Mail attachment. Existing quarantine policy applies;
missing scan/extraction authorization cannot become clean.

An approval claim is the exact proposal plus approvedBy/nonce/expiresAt,
signed with Ed25519 under
`mail-intelligence/price-upload-approval/v1` followed by a zero byte and
canonical JSON. The proposal binds purpose/company/mailbox/message/source
revision/source fingerprint/attachment ID/revision/name/size/byte digest.
The trusted key and Price session are injected out of band. The QA key is
fixture-only; no production issuer, grant registration or revocation
service is supplied by this local implementation.

The exporter measures approved bytes and rechecks metadata after the
asynchronous byte read, before creating a manifest. It rechecks approval
and source before every subsequent request. Price performs native
manifest/chunk/complete and source-hash readback. The returned receipt
couples Mail provenance and Price batch/document/blob/hash. An identical
occurrence reuses its operation; different source occurrences with duplicate
bytes retain separate provenance batches but the native backend creates one
document/blob/job. Received bytes are not a financial conclusion.

Current finance reports, worker grants, bank completeness, tax readiness and
institution format acceptance are outside this upload/source-reader boundary.
Real scanner and real-account/source authority remain separate live gates.

## Reproducible integration checks

Run through the existing heavy-suite runner with limit2:

```text
NODE_ENV=test /admitted/crm/node_modules/.bin/tsx scripts/verify-mail-crm-native.mjs /admitted/crm
node scripts/verify-mail-price-native.mjs /admitted/price
```

MR checks the entire current CRM-R1-local-v2 source manifest and uses actual
maintained Fastify/PG with explicit fixture identities. MT pins the admitted
Price source_tables/casework/upload_routes bytes, drives actual native login
and FastAPI HTTP, downloads original bytes and reads source rows. Neither
uses a mocked domain port or writes counterpart business tables directly.
Counterpart initialization is fixture lifecycle through its existing APIs.

All subprocesses, API instances, DB pools and owned fixture roots close before
cleanup receipts are emitted. No fixed test sleeps or skipped integration
assertions. Missing installed producer/runtime dependencies are errors.

Coverage: REQ-MAIL-005/007/008, REQ-INT-004/011 and
REQ-KNOW-004/006/011. No schema migration or operational cutover is included.
Rollback removes the explicitly injected consumer binding; historical Mail
source/corrections and counterpart native receipts are not rewritten.
