# D4 UI QA: blocked at the bounded retry limit

This is the preserved historical retry receipt. The separately authorized
continuation is recorded in [resumed.md](resumed.md), with three fresh passing
captures and a new product head. The failure image below remains failure evidence.

Product head exercised: `a2ef78622a0a4f076891026e406b11c0c4585c4b`.
All accounts/messages are synthetic. No production login, real browser/mail,
send, external business write, payment, merge or deployment.

## Captures

- `style.png`: PASS. Actual rapid-reply UI shows the fixed Nexias salutation,
  learned Sent greeting and closing. Unresolved fields remain unsendable.
- `handled-blocked.png`: FAILURE EVIDENCE, not acceptance. The real phone
  marker and memo persisted, but the displayed card/detail still call the
  message an active action.
- Automatic-cancellation screenshot: NOT_RUN. The owner's two-failure limit
  was reached; there is no third placeholder image or acceptance claim.

Actual browser actions:

1. Tab-scoped synthetic Basic/session, select
   `article[data-message-id="d4-style"]`, click
   `[data-assistant-action="rapid_reply"]`; inspect `#composeBody`.
2. Select `article[data-message-id="d4-handled"]`; set detail
   `select[aria-label="회신 경로"]` to `phone`; fill
   `input[aria-label="외부 회신 메모"]` with the synthetic note; click the
   detail handled button once. Inspect `.handled-note` and the rendered
   card/detail classification.

The first failed attempt was a driver mistake before navigation:
`page.cdp.send('Network.enable')` uses the browser-root transport. Correct
`page._sendToTarget(...)` resolves the owned tab session and authenticates.
The second failure was the actual stale classification display after handling.
No further UI attempt or cancellation sync was performed.

## Sanitized HTTP receipts

Captured from the actual browser requests, not separately replayed mutations:

```json
{
  "draft": {
    "status": 200,
    "statusText": "OK",
    "headers": {"Cache-Control":"no-store","Content-Type":"application/json; charset=utf-8"},
    "body": {
      "to":"buyer@nexias.co.kr",
      "subject":"RE: 자료 회신 요청 d4-style",
      "body":"양해광 상무님, 안녕하십니까.\n베를로 박재민입니다.\n\n자료 회신 요청 d4-style 관련하여 회신드립니다.\n- {확인 필요}\n- {확인 필요}\n\n추가로 필요한 사항 있으시면 말씀 부탁드립니다.\n고맙습니다.",
      "needsClarification":true,
      "voiceEvidence":["4","5"],
      "sendAllowed":false,
      "calendarWriteAllowed":false,
      "crmWriteAllowed":false,
      "externalAiUsed":false
    }
  },
  "handled": {
    "status":200,
    "statusText":"OK",
    "headers":{"Cache-Control":"no-store","Content-Type":"application/json; charset=utf-8"},
    "body":{
      "handledElsewhere":{
        "messageId":2,
        "graphId":"d4-handled",
        "channel":"phone",
        "note":"합성 통화로 일정 확인 완료",
        "markedAt":"2026-10-09T17:29:58.629Z"
      },
      "undone":false,
      "replyGap":false,
      "cancelledDrafts":0
    }
  }
}
```

Body excerpt intentionally omits session-derived actor and unrelated fields;
auth headers, cookie values and CSRF are never published.

## Observed defect and next scope

`src/app.js:625-628` renders cached `message.precision` action/lane fields.
The handled helper overrides at `operationalLaneForMessage` and
`precisionStateForMessage` are not used by that card. Summary/detail likewise
show cached classification. The actual task-filter exclusion was not measured;
this evidence proves stale displayed state, not failed persistence.

No product code was changed after exhausting the explicit retry limit.
Next authorized work should make the handled state authoritative for current
card/detail rendering and verify it through the real UI. A product fix needs
an explicit new head and Seo-yun re-review. Three-screen D4 acceptance remains
open; these two captures must not be presented as three PASS screenshots.

Cleanup: owned browser/server stopped; both server PIDs, both ports,
temporary database and owned browser profile confirmed absent. Only these
synthetic evidence artifacts and the relocatable fixture are retained.
