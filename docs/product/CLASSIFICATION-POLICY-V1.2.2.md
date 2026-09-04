# Classification Policy v1.2.2

`classificationPolicyVersion=classification-policy-v1.2.2-o01-o06`

This policy classifies current mail content only. Quoted history, closed context,
signatures, disclaimers, and metadata do not create a current action.

## Operational rules

- **O-01 — Outgoing delivery without a current follow-up request.** An outgoing
  delivery with no current request for confirmation, reply, approval, or action is
  `COMPLETED` / `NONE` / `NORMAL` / `ARCHIVE`.
- **O-02 — Outgoing delivery with a current recipient request.** An outgoing
  delivery with a confirmation, reply, approval, or action request in the same or
  adjacent current clause or sentence is `WAITING` / `EXTERNAL_PARTY` / `NORMAL` /
  `WAITING`.
- **O-03 — Incoming direct current request.** An incoming message containing a
  current direct request is `ACTION_REQUIRED` / `ME`.
- **O-04 — High-priority evidence boundary.** Dates from prior, quoted, closed,
  signature, or disclaimer content must not be used as `HIGH` priority evidence.
- **O-05 — Search abstention.** When the corpus has no direct evidence, `NoResult`
  or `abstained` is a correct result. Do not substitute an unrelated fallback.
- **O-06 — Evaluation modes.** Canonical exact diagnostics report every result.
  Only Operational Safety B is a hard gate.

## Evidence and safety

The classifier must preserve uncertainty as review rather than infer an external
action. Classification remains read-only: it cannot send mail, alter source mail,
create calendar events, or execute external actions.
