# Precision fixture revision v2

Date: 2026-09-23
Evaluation: `precision-classification-fixture-v2`
Supersedes: `precision-classification-fixture-v1`
Classifier: `precision-classification-v1.2.2-fix11` (unchanged)

## Decision

The owner requested resolution of the remaining canonical conflict, not another
report-only exception. The old expectation disagreed with the already-established
current-content policy and the classifier regression
`cycle03 priority accepts current tomorrow evidence but rejects importance-only evidence`.

The synthetic `high-importance-reference` message carries `importance: high` but
explicitly says no action is required. Importance metadata alone is not current
urgency evidence. Its expected result is `reference / none / normal`, not high.
The classifier's runtime behavior and classification-policy version are unchanged.

`test/fixtures/precision-evaluation-v2.json` preserves every v1 input and every
assertion except this one corrected priority. The original
`precision-evaluation.json` and `precision-report-only-conflicts-v1.2.2.json`
remain unchanged as historical evidence. Neither is the current evaluator input.
This is a versioned correction to a synthetic development/release fixture, not
relabeling live or holdout mail to match a result.

## Gate

Both `evaluate:precision` and `evaluate:precision:diagnostic` require all 77
assertions across 20 fixtures to pass. The diagnostic no longer accepts a known
failure or reads an exception manifest. Its result reports `strictExitCode: 0`,
`reportOnly: 0`, and the evaluation version.

The regression suite checks the independent strict command, the diagnostic,
an intentionally mismatched fixture in an isolated project, and exact preservation
of all other v1 fixture data. A real mismatch must still exit 1 and identify the
failed fixture/field; no threshold or assertion is removed.

This synthetic gate does not replace independent real-mail acceptance, live
connector checks, or production release approval.
