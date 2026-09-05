# Release Blind Label Admissibility: Current Message Evidence v1

**Status:** Owner-approved Release Blind finalization contract
**Contract version:** `current-message-evidence-v1`

## Scope

This contract applies only to labels finalized after its adoption for a new Release Blind benchmark. It does not migrate, reinterpret, or rewrite historical frozen labels. Historical labels remain readable for report-only comparison, but cannot establish this contract retroactively.

## Required draft fields

Every new Release Blind draft must declare:

```json
{ "labelAdmissibilityContractVersion": "current-message-evidence-v1" }
```

Each sample must declare `reviewerDisagreement: false` before finalization. Any unresolved disagreement fails closed.

For `action_required`, `decision_required`, and `waiting`, each sample must also carry a PII-free evidence locator:

```json
{
  "currentEvidence": {
    "source": "current_content",
    "field": "currentContent"
  }
}
```

The only alternative is current metadata:

```json
{
  "currentEvidence": {
    "source": "current_metadata",
    "field": "direction"
  }
}
```

Allowed current metadata fields are `direction`, `lifecycle`, `isDraft`, `isPromotional`, `receivedAt`, `sentAt`, `importance`, and `folderName`. A locator records provenance only; it must not copy mail content, addresses, names, organizations, or hashes.

## Prohibited evidence

Quoted history, forwarded history, signatures or footers, legal disclaimers, and any unresolved reviewer disagreement are inadmissible for actionable expected states. A state based only on such material must be labeled `review_required` or non-actionable unless admissible current evidence independently supports it.

## Finalizer behavior

`scripts/finalize-blind-holdout.mjs` rejects a new draft that omits the version, uses an unsupported evidence source or field, relies on a prohibited source, omits actionable evidence, or leaves reviewer disagreement unresolved. It stores only the source and field locator in the frozen label file.

The finalizer does not alter evaluator thresholds, classifier behavior, existing frozen labels, or historical report-only reads.
