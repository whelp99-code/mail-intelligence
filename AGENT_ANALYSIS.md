# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-21T13:24:59Z
**Commit:** ce0fd34
**Branch:** main

## OVERVIEW

Standalone ESM process `standalone-mail-intelligence` (node >= 22, package `1.0.0`). Unbundled browser client plus a SQLite-backed sync, classification, and proposal pipeline. Runtime pin is `src/version.js` `APP_VERSION = '1.2.2'`, not package semver.

## STRUCTURE

```
mail-intelligence/
├── server.mjs                 # process entry; 38 ./src imports; zero exports
├── src/                       # browser client and contracts server.mjs imports
├── src/application/           # sync, intake, drafts, work links, mail memory
├── src/domain/                # pure classification, search, templates, guardrails
├── src/adapters/              # Graph, Notion, CWOS, Drive, scanner
├── src/storage/               # node:sqlite, legacy import, backup, attachment crypto
├── src/security/              # tailnet allowlist, recipient policy, static path
├── src/ai/                    # score 4; process circuit, not the live JSON extract
├── src/domain-profiles/       # local sangfor + generic map, not a plugin loader
├── test/                      # 107 *.test.js; default suite is test/*.test.js
├── scripts/                   # 45 CLIs
├── migrations/                # 001-015 STRICT
├── schemas/                   # draft 2020-12
└── docs/                      # planning, qa packs, core5, runbooks
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Process entry | `server.mjs` | `PORT=3010`; 3515 lines; imports `safety.js`, `ai-contract.js`, `version.js` |
| Browser UI | `src/index.html` | Loads `src/app.js` (2259, no exports) and `src/styles.css` (1454). No bundler |
| Sync, intake, memory | `src/application/` | Score 14. No barrel |
| Classification | `src/domain/` | Version strings are the contract. Score 9 |
| External systems | `src/adapters/` | Read or propose. No SQLite. No CRM or Notion writes |
| Store | `src/storage/sqlite-store.js` | `node:sqlite` `DatabaseSync`, 2788 lines |
| Data paths | `storage-paths.js` | `MAIL_INTELLIGENCE_DATA_DIR\|DB_PATH\|LEGACY_CACHE_PATH\|CONFIG_PATH` |
| Live safety | `src/safety.js` | The `server.mjs` import. Loopback, `MutationDisabledError` |
| Break-glass | `src/runtime-safety.js` | `MAIL_INTELLIGENCE_UNSAFE_BREAK_GLASS` plus a capability flag. No production import |
| Policy file | `src/security/safety-policy.js` | `MAIL_INTELLIGENCE_ALLOW_*`. Tests only. Not the live gate |
| Recipient assert | `src/security/mail-send-recipient-policy.js` | Assert. Not signature verification |
| JSON extract | `src/ai-contract.js` | Production. `src/ai/response.js` is test-only |
| Mail-sync retry | `src/resilience.js` | Distinct from `src/ai/resilience.js` (process circuit) |
| Profiles | `src/domain-profiles/index.js` | `sangfor` plus `generic`. Zero external imports |
| Deploy root lock | `scripts/deploy-user-service.sh` | Refuses any root other than this checkout |

## CODE MAP

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| server process | entry | `server.mjs` | 38 `./src` imports, 0 exports | HTTP process |
| `APP_VERSION` | const | `src/version.js` | unmeasured | Pin `1.2.2` |
| `safety.js` | module | `src/safety.js` | server import | Live mutation gate |
| `ai-contract.js` | module | `src/ai-contract.js` | server import | Production JSON extract |
| `sqlite-store.js` | module | `src/storage/` | unmeasured | `DatabaseSync` store |
| `precision-classifier.js` | module | `src/domain/` | unmeasured | 1814-line classifier |
| `app.js` | browser | `src/app.js` | 0 exports | Unbundled client |
| `hasMailSendScope` | preflight | file not in digest | unmeasured | Fail-closed scope check, not a signature check |
| domain-profiles index | map | `src/domain-profiles/index.js` | 0 external imports | Not a plugin loader |

Centrality beyond the named import counts was not in the digest.

## CONVENTIONS

- Three safety stacks are not aliases: live `src/safety.js`, unused-in-prod `src/runtime-safety.js`, test-only `src/security/safety-policy.js`.
- Domain contract strings are `precision-classification-v1.2.2-fix11` and `exact-source-span-v1`. Package semver is not that contract.
- Migrations `001`–`015` are `STRICT`. Do not edit applied `schema_migrations`, rerun `009`, or rewrite ownership, reconciliation, or outbox rows.
- Classification is bilingual regex plus ordered precedence. Evidence quotes are exact source spans. Unfilled slot is `{확인 필요}`. Lanes: `do_now`, `waiting`, `review`, `archive`.
- Schemas use draft 2020-12 and `additionalProperties: false`. Server references `mail-analysis` and `precision-classification`. Nothing outside references `draft-slot-fill.schema.json`.
- Notion collect enablement is the string `'1'`. Collect refuses PATCH, PUT, and DELETE.
- `npm run check` is `node --check`, not a compiler. It omits `attachment-scanner.js`, `cwos-work-system.js`, `google-drive-client.js`, and `microsoft-graph-send.js`.
- Default test glob is `test/*.test.js` only. `test/helpers/` and `test/fixtures/` sit outside that suite.
- ESM. No Makefile. No bundler. CWOS binding is explicit; two GETs are not an atomic snapshot.

## ANTI-PATTERNS

- JSON cache is import-only (`legacy-import.js`). It is not the operational database.
- Do not enable Notion collect on ops port 3010. The collect script must not print tokens.
- Adapters do not write CRM or Notion.
- The reply pipeline plans and annotates. It does not approve or send.
- Do not hard-code Sangfor into `src/domain`.
- Do not merge the legacy `docs/core5` branch or its unsafe send and attachment paths.
- The company-memory publisher never calls `sb remember`. Do not commit the Ed25519 keypair.
- Do not commit mail-derived QA files, labels, logs, backups, or hashes. Fixtures store 12-character hash prefixes, not mail bodies.
- `synthetic-identity-token.mjs` is not the intake identity module.
- `verify-safety-contract.mjs` requires `read-only` / `read-only-v1.2.2` and forbids `Mail.Send` and `Mail.ReadWrite`.

## UNIQUE STYLES

- Subdirectory guidance exists only where the digest score cleared the bar: `src` 11, `application` 14, `domain` 9, `adapters` 9, `storage` 9, `security` 9. `test/` and `scripts/` scored 5 and were skipped.
- `CLAUDE.md` and `GEMINI.md` only point at root `AGENTS.md`.
- `docs/qa/` is human blind packs, not tests. Rubric names: `classification-policy-v1.2.2-o01-o06`, `blind-acceptance-rubric-v2`.

## COMMANDS

```bash
PORT=3010 node server.mjs
npm test
npm run check
npm run lint
npm run validate:html
npm run validate:css
npm run verify:core
npm run verify:v1.2.2
npm run evaluate:precision
npm run memory:status
npm run memory:integrity
npm run memory:backup
npm run verify:backup:isolated
npm run verify:oauth
npm run oauth:status
npm run oauth:instructions
npm run oauth:enable
npm run collect:notion-readonly
npm run verify:notion-crm-p1a
```

`npm test` runs `scripts/run-tests-isolated.mjs` (mode-`0700` temp under `data/tmp`, then `node --test`). Memory scripts are `scripts/mail-memory-admin.mjs`.

## NOTES

- Digest on disk: `.omo/init-deep/digests/mail-w01.md` only. No other digest was present. Line counts and import counts above are that digest's claims, not a fresh symbol pass.
- Hotspots named, not re-documented: `server.mjs` 3515, `sqlite-store.js` 2788, `app.js` 2259, `precision-classifier.js` 1814, `styles.css` 1454, `mail-event-extractor.js` 1097, `notion-readonly-collect.js` 695.
- Root `AGENTS.md` section 5 still calls the tree a prototype with no test suite. SQLite, isolated tests, and domain modules now exist. `server.mjs` is still the process entry.
- Planning precedence and product policy stay in root `AGENTS.md`. This file does not restate them. Planning docs `02`/`03`/`04` are 997/766/756 lines. Largest QA pack is 1156 lines.
