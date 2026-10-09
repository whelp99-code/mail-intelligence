# D4 UI QA: resumed synthetic acceptance

Product source exercised: `8d15381f7e708004f8ee96298e201eb0e63b8642`.
Source tree: `bc17432fe8a0f9607ed767c7549aa5564df564d9`.
App blob: `58355e7b9186368f881f3dff038e733f40ce6438`.
Renderer test blob: `92ea8525d780bbcfa79a159162fc72b69bb21fa5`.
The evidence-only commit does not change these behavioral inputs.

All messages, accounts and the dedicated browser are synthetic. This is a
draft PR handoff, not production acceptance, a merge or deployment.
The new product head requires Seo-yun re-review, arranged by OmO.
The previous owner-voice PASS and bounded failure receipt remain intact.

## Cause and scoped fix

The server requery already carries the active SQLite handling marker.
The client card and detail instead used the raw cached model classification.
The shared `precisionFor` rendering view now derives completed/none/archive
from the stored user fact without changing the original classification.

Actual UI inspection also caught an invalid operational code: `reference`
belongs to precision work states; the canonical operational code is `archive`.
Real label functions now participate in the renderer regression.
The same cached insight left a proposed reply active after completion;
the current view now excludes it while retaining the cached insight.

Verified product increments:

- `9a587a9`: shared current-state card and detail rendering.
- `29b9756`: canonical archive operation code.
- `d987bed`: retain canonical operational metadata.
- `8d15381`: completed mail has no current cached reply action.

No server, schema, persisted model history or approval boundary change.

## Three fresh captures

1. [phone.png](phone.png): one native phone POST. Card and detail show
   `보관 · 완료`, phone memo remains after reload, current reply actions are `0`.
2. [kakao.png](kakao.png): one native Kakao POST. The same immediate/requery
   state is visible with the Kakao memo and current reply actions `0`.
3. [cancel.png](cancel.png): one fake Graph GET-only Sent synchronization
   adds an owner reply and automatically cancels one pending draft. Actual
   review list/detail show `취소됨` after reload. The draft and both status
   events remain stored; no draft deletion occurred.

The cancellation history is measured in the stored sync receipt, not
claimed as a visible history panel. No repeated save or manual cancel was
used to manufacture evidence. Natural scrolling only; no UI text was replaced.
Desktop 1440px and phone-width 390px views were inspected, without overflow.

## Sanitized observed HTTP and stored receipts

Both actual native handling requests and actual requery/detail responses
returned `200`, `Cache-Control: no-store` and
`Content-Type: application/json; charset=utf-8`.
No authentication/session response, cookie, CSRF or session-derived actor
value is included.

```json
{
  "phone": {
    "status": 200,
    "channel": "phone",
    "note": "합성 전화 처리 완료",
    "markedAt": "2026-10-09T18:20:56.922Z",
    "replyGap": false,
    "undone": false
  },
  "kakao": {
    "status": 200,
    "channel": "kakao",
    "note": "합성 카톡 처리 완료",
    "markedAt": "2026-10-09T18:40:21.505Z",
    "replyGap": false,
    "undone": false
  },
  "phoneRequery": {
    "status": 200,
    "handledMarkerPresent": true,
    "channel": "phone",
    "rawModelWorkState": "action_required",
    "rawModelOperationalLane": "do_now",
    "renderedWorkState": "completed",
    "renderedOperationalLane": "archive",
    "renderedCurrentReplyActions": 0
  },
  "sentSync": {
    "failedFolders": 0,
    "upserts": 1,
    "cancelled": 1,
    "draftStatus": "cancelled",
    "events": [
      {"status": "needs_clarification", "actor": "jarvis", "reason": ""},
      {"status": "cancelled", "actor": "system:already-replied", "reason": "이미 회신함"}
    ],
    "graphReads": [
      "/v1.0/me/mailFolders",
      "/v1.0/me/mailFolders/d4-inbox/messages/delta",
      "/v1.0/me/mailFolders/d4-sent/messages/delta"
    ],
    "externalWrites": 0
  },
  "cancelRequery": {
    "status": 200,
    "draftStatus": "cancelled",
    "sendEnabled": false,
    "sentAt": null,
    "graphMessageId": null
  }
}
```

## Checks and cleanup

The actual renderer regression failed before the fix. Subsequent real label
and recommendation assertions also caught the invalid enum and stale action
count before passing. Phone/Kakao cases execute the production card, detail,
state and action renderers with cached active classifications. Replaced
fetched objects, outside-index cards, undo and original-model preservation
are covered; undo restores the cached action count to `1`.

`node --test test/ui-async-consistency.test.js`: `5/5` PASS on Node 22.23.2.
The previously run adjacent handling/draft-service checks passed `9/9`;
their backend inputs did not change. Modified-file ESLint, Node syntax and
`git diff --check` passed. No broad suite was repeated.
LSP diagnostics could not initialize because TypeScript is absent; no type
script exists. This is explained, not reported as a clean language-server run.

`node test/fixtures/d4-ui-qa-host.mjs sync-reply`: one actual run, cancelled
one draft, three fake GETs and external writes `0`.
A mistaken `tools/` path invocation never started; it was corrected by
rereading the actual fixture path, not by replaying a successful operation.

Cleanup completed: response subscriptions and owned connection closed;
fixture exited with `D4_QA_HOST_CLEANED`. Owned temporary database, browser
profile, all three parent/child/browser PIDs and both dynamic ports were
independently confirmed absent. No user browser or production file was touched.

Original image SHA-256:

```text
951ef4c084d5aa553c5c301a6fa728c7c83480edda5fe3d669ada0a778cfeea0  phone.png
d3fb3699ff03e821441229de69aada583afbde347bbc5537da5479c2d56428ab  kakao.png
be13ec4378ad4693c234840131722e69d07cd2baa80d51d4b9723308844d428e  cancel.png
```
