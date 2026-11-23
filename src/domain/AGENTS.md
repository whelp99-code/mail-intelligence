# src/domain

**Score:** 9. Code ratio, symbol density, exports, and reference centrality. Distinct domain: pure classification and draft rules, no I/O except two injected file reads.

## OVERVIEW

Pure functions and frozen string enums. Callers import by filename. A module version constant is the contract, not the package semver.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Message classification | `precision-classifier.js` | Precedence, evidence spans, corrections. 1814 lines. |
| Event frame | `mail-event-extractor.js` | Production path is the classifier, not a direct server import. |
| LLM merge | `precision-llm.js` | Schema-checked object merged onto the rule result. JSON extract comes from `src/ai-contract.js`. |
| Operational lanes | `operational-classification.js` | Frozen: `do_now`, `waiting`, `review`, `archive`. |
| Graph normalize | `mail-normalizer.js` | Sync and legacy import share this. |
| Search parse | `intelligent-search.js` | Query parse and match explanation. Rerank is `search-semantic-ranker.js`. |
| Draft templates | `mail-style-templates.js` | Unfilled slot is the literal `{확인 필요}`. |
| Send guardrails | `reply-draft-guardrails.js` | Partner leak, ungrounded numbers, same unfilled token. |
| Owner voice | `owner-voice.js` | Defaults to `data/config/*.json`. Accepts an injected `read`. |
| Learning from corrections | `correction-generalization.js` | Versioned policy match. Not a silent fine-tune. |
| Work-link projection | `work-link-projection.js`, `work-link-events.js` | Confirm, activity post, and customer send stay distinct. |

## CONVENTIONS

- No classes, no barrel, no framework. ESM relative `.js` imports only.
- Evidence quotes are exact source spans (`exact-source-span-v1`).
- Korean and English regex share one ordered precedence list.
- `*Internals` exports are for tests. Do not grow a second public API beside them.

## ANTI-PATTERNS

- Do not assign a project from similarity alone. `resolveProject` stays behind evidence and candidate review.
- Do not drop quoted history into the classified body. `stripQuotedHistory` exists for that split.
- Do not invent a filled slot when the template still has `{확인 필요}`.
- Do not read `data/config` from a new module without the injected-`read` seam used by voice and partner names.

## NOTES

`npm run check` syntax-checks every `src/domain/*.js` file. Behavior gates are `npm run evaluate:precision` and the `verify:v1.2.2` chain, not `check`.
