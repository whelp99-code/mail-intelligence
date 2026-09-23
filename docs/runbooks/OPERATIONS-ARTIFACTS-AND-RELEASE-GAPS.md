# Operations artifacts and current release gaps

`artifacts/`, `data/qa/`, `data/tmp/`, and `backups/` are owner-only operational paths and are Git-ignored. Do not commit mail-derived QA files, labels, logs, backup databases, hashes, or temporary artifacts. `data/tmp/` is created owner-only by the supported scripts and each script removes only its own per-run directory.

## Read-only operations

```sh
npm test
npm run verify:oauth
npm run qa:incident:capacity -- --db /absolute/path/mail-intelligence.sqlite --source-root /absolute/path/mail-intelligence-runtime
npm run backup:retention:inventory -- --dir /absolute/path/backups
node scripts/sync-mail-safely.mjs --source-root /absolute/path/mail-intelligence-runtime
```

The incident command reads the database and prior message-benchmark files under `--source-root` (`test/fixtures` and `data/qa`). It selects filenames containing `label`, `template`, `manifest`, `canonical`, `adjudicat`, `aside`, or `labeler`, rejects malformed selected files and symlink roots, then invokes the existing incident preparer into a private temporary artifact. Search-query and result JSON artifacts are not message benchmarks and are outside this exclusion scan. The command reports aggregate capacity only and removes its artifact. It does not emit mail content, hashes, labels, predictions, or make external calls. An insufficient result is a release gap, not a reason to add synthetic blind cases.

The backup inventory is dry-run only. It neither deletes nor traverses symlinks. It does not verify integrity, so verification is reported as `UNKNOWN`; its policy recommendation is to keep the newest 10 **verified** backups and every verified backup from the last 30 days. Rollback and QA-evidence artifacts require explicit operator review before any separate deletion action.

## One-shot operational Delta sync

`sync-mail-safely.mjs` is a one-shot local operator helper, not a scheduler or deployment tool. It accepts only loopback `http://127.0.0.1` or `http://[::1]` bases (default `127.0.0.1:3010`) and reads the access key from `<source-root>/data/.mail-intelligence-access-key`. Before its only mutation request, it requires healthy read-only safety, disabled external actions, a session with every mutation capability disabled, and disabled external AI. It then sends only `POST /api/outlook/sync` with `{ "top": 50, "forceInitial": false }` and the required session, origin, and CSRF headers.

It fails on offline cache, disconnected Outlook, failed folders, incomplete folder completion, attachment errors, nonempty sync errors, or zero completed folders. A successful aggregate-only output includes its `completedAt` timestamp; do not infer a fresh sync from the database alone. Access keys, cookies, message data, upstream errors, and response payloads are never printed.

## Current v1.2.2 release gaps

The synthetic precision conflict was resolved in the versioned v2 fixture set
(see `docs/product/PRECISION-EVALUATION-V2.md`). Strict evaluation and the CI
diagnostic now require all 77 assertions to pass, with no report-only exceptions.
Final Production GO remains blocked on independently labelled unseen real mail,
search relevance, correction persistence, backup/restore rehearsal, and live
stability evidence described in the v1.2.2 independent QA instructions.

Current corrections persist and override automatic classification when the same message is reclassified. Registered project alias changes can trigger mailbox reclassification. Generalized future-case learning is not implemented or proven: do not claim continuous learning until ACCEPT-133 and ACCEPT-134 pass.
