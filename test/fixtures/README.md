# Test fixtures

## `aside-round3-fixed-50.json`

This file contains only the frozen 12-character message hash prefixes and expected labels used by the Aside Round 3 independent QA. It does not contain mail subjects, bodies, sender addresses, credentials, or tokens.

Purpose:

- replay known independent classification regressions without changing labels;
- prevent a future classifier change from reintroducing the Round 3 failures;
- provide a deterministic precondition before an independent holdout evaluation.

It is not, by itself, an independent release approval. The final QA must also score a new blind holdout selected after the code is frozen.

## `aside-qafix5-blind-fixed-50.json`

This fixture contains only the frozen hashes and expected labels produced by the independent qa-fix5 Blind Holdout review. Reviewer notes, mail subjects, bodies, senders, credentials, and tokens are excluded.

The fixture is a known regression benchmark for qa-fix6 and later. It must not be used as the only release approval set. A new blind holdout must exclude both this fixture and `aside-round3-fixed-50.json` before labeling begins.

The `important` label means the message must not be reduced to `priority=low`. Work-state correctness is scored independently; an expected `completed` or `review_required` message may still be important.
