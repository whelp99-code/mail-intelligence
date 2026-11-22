# src (package-root modules)

**Score:** 11. Subdir count, code ratio, symbol density, exports, and reference centrality. Distinct from the subpackages: these files are the unbundled browser client and the contracts `server.mjs` imports by path.

## OVERVIEW

Browser UI plus listen, mutation, AI, and version contracts that sit beside `server.mjs`, not inside a subpackage.

## STRUCTURE

```text
src/
├── app.js, index.html, styles.css   # browser client, no bundler
├── safety.js, runtime-safety.js     # listen/mutation vs break-glass flags
├── ai-contract.js, analyzer.js      # schema-checked analysis, not src/ai/
├── resilience.js                    # retry/circuit, not src/ai/resilience.js
└── adapters|ai|application|domain|domain-profiles|security|storage
```

Subpackage rules live in those directories. This file covers only the files directly in `src/`.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Browser client | `app.js`, `index.html`, `styles.css` | `app.js` exports nothing. |
| Korean labels | `ui-labels.js` | Display copy, including the safety banner. |
| Send-review UI | `send-review.js` | `initializeSendReview` is what `app.js` loads. |
| Live listen/mutation gate | `safety.js` | Imported by `server.mjs`. Loopback only. |
| Break-glass flags | `runtime-safety.js` | Needs `MAIL_INTELLIGENCE_UNSAFE_BREAK_GLASS` plus a per-capability flag. No production import found. |
| AI payload contract | `ai-contract.js` | `precision-llm.js` imports `extractJsonObject` from here. |
| Version pins | `version.js` | `APP_VERSION` is `1.2.2`. Package version is not this pin. |

## CONVENTIONS

- ESM, explicit `.js` specifiers, no barrel and no bundler.
- Default bind is `127.0.0.1`. `UnsafeListenHostError` and `MutationDisabledError` are the live error types.
- `getSafetyPolicy` here is not `src/security/safety-policy.js`.

## ANTI-PATTERNS

- Do not add another mutation gate and treat it as live. `server.mjs` uses `safety.js`.
- Do not route analysis through `src/ai/response.js`. Production parsing goes through `ai-contract.js`.
- Do not treat `analyzer.js` demo text as stored work memory.
- Do not inline Korean UI copy in `app.js` when `ui-labels.js` already owns the label.

## NOTES

`npm run validate:html` and `validate:css` cover `index.html` and `styles.css` only. `npm run check` syntax-checks the `.js` files here. `app.js` is 2259 lines and `styles.css` is 1454; change the label module instead of growing the client.
