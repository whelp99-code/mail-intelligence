# Branch integration checkpoint - 2026-09-23

## Scope and authorization

The owner requested completion of verification, commits, pushes, main integration,
and disposition of the two existing pull requests. This supersedes the earlier
local-checkpoint-only Git restrictions in planning documents. It does not
authorize deployment, enabling live connectors, or business-system mutations.

The integration uses a separate worktree. Original untracked planning copies,
the planning ZIP, the operator handover inbox, and `work/ai-file-sorter/` are not
part of the product commit. Dependency symlinks and runtime databases are excluded.

## Integrated source branches

- Core5: `5be3d7c`, including the five previously unpushed commits and the
  verification repair. The CLI backup test now checks the actual migration
  version; SQL string formatting satisfies the existing lint gate.
- Notion WorkLinks: `c16124d`. Migration 006 was retargeted to 008 with unchanged
  SQL after the development tree was checked for applied databases.
- Attachment/Drive drafts: `cf786f6`. Migrations 006 and 007 retain their original
  names and checksums. The ownership migration interaction is documented in
  `ATTACHMENT-MIGRATION-INTEGRATION.md`.

Principal ownership, recipient policy, reconciliation, company-memory outbox,
and attachment digest/buffer checks must all survive the three-way merge.
Public storage status retains the existing v9 contract; backup manifests report
the actual applied migration version. Historical migration rows are immutable.

## Existing PR disposition

### PR 1: feature/design-upgrade

Do not merge this legacy branch. Its JSON-cache-backed portal implementation
predates the SQLite baseline. In its source, `src/destructiveApi.mjs:19-36`
allows mutation by default unless an environment flag requires approval, and
`server.mjs:2046-2072` contains direct send/read mutation endpoints. These do not
meet the current approval boundary.

Kanban presentation, keyboard navigation, saved-search UI, browser reminders,
and call-recording transcription are not all duplicated by main. Preserve the
remote branch as an archive rather than claiming those capabilities were merged.
They would require separate, bounded work against the current product contracts.
Close PR 1 without merging or deleting its branch.

### PR 2: cursor/grok-bot-service-apis-815c

Do not merge its parallel draft implementation. The canonical service now has
principal ownership, exact-payload idempotency, and uncertain-send reconciliation.
The PR's service-token draft listing lacks that principal isolation; its
`src/application/send-drafts.js:111-113` reuses an idempotency key without payload
comparison, and its submission receipt is not proof of a reconciled sent message.
The attachment download route also lacks the canonical scan/quarantine boundary.

Dedicated read-only service-token search/message access is a unique requirement,
not a delivered feature of this integration. Preserve the remote branch for
reference; do not import its unsafe parallel send or attachment paths.
Close PR 2 without merging or deleting its branch.

## Evidence and limits

Core5: 446 tests passed; lint, HTML/CSS, safety, isolated server health, and the
high-severity dependency audit gate passed. GitHub CI run `35864947878` succeeded.

Notion plus Core5: 486 tests and 9 OAuth tests passed, with static checks,
operational safety, and isolated startup passing. Real HTTP checks proved
unauthenticated rejection and candidate-only refresh. Chrome renders at 1280,
768, and 390 CSS pixels had no horizontal overflow or JavaScript page errors;
the candidate counts remained visible.

Combined tree before gate-review remediation: `npm run verify:v1.2.2` exited 0 with 563 tests,
9 OAuth tests, syntax, lint, HTML/CSS, precision diagnostics, isolated health,
safety, operational-safety, browser acceptance, and the high-severity audit gate.
The 13 migration-bridge tests are included in the 563 tests. Backup/restore is
exercised against a synthetic classified database, not operational mail.

Browser acceptance exercised file selection, oversize rejection, a controlled
scanner handshake, immutable draft creation, safe download headers, keyboard
access, CJK labels, and disabled send controls. Desktop width was explicitly
1280; mobile width was 390, with separate captures for the lower review controls.
Screenshots remain local under `artifacts/attachments-acceptance/`; no runtime
database or image artifact is included in the commit. The independent WorkLink
Chrome check was repeated on the combined tree at 1280/768/390 widths.

Gate review found an R04 defect: human review could see a Grok-created draft but
could not download its ready attachment. Content reads now require a human actor
and current-mailbox ownership, independent of the upload source. Bearer content
access, foreign-mailbox access, non-ready content, and cross-source discard remain
denied. The corrected API regression failed first with `ASSET_NOT_FOUND`; the
full release verifier then passed 564 tests, including an actual HTTP
bot-upload -> bot-draft -> human-download regression. Chrome also verified
downloaded bytes from the bot draft with send disabled.

That populated-browser check also exposed intrinsic grid overflow after mail
content loaded. The main column and responsive top bar now use a zero-minimum
grid track rather than growing beyond their available width. No visual design
or feature was changed. The browser check waits for a real message card, verifies
the downloaded bytes, and asserts both document width and element bounds at
1280/768/390 pixels. All three widths and CSS validation passed after the fix.

Known pre-existing limits:

- The precision conflict present at integration was resolved in the subsequent
  versioned synthetic evaluation v2; see `docs/product/PRECISION-EVALUATION-V2.md`.
  Both strict evaluation and the diagnostic now pass 77/77 with zero exceptions.
- The moderate `colord` advisory present at integration was resolved by locking
  2.9.4 (GHSA-2wm5-q62r-hmrv). A clean install and unrestricted `npm audit --json`
  report zero vulnerabilities; the existing high-severity gate was not relaxed.
- The workstation's global npm configuration can cause `EALLOWSCRIPTS`.
  The audit was rerun with separate empty user/global config paths, without
  changing project policy or the workstation configuration.
- LSP could not initialize because TypeScript is not installed in the workspace;
  syntax checks and ESLint are the available static evidence.
- No live Outlook/Drive/Notion action or production migration was performed.
  This is code integration, not production release acceptance.
