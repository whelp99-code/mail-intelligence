# Blind Acceptance Rubric v2

`acceptanceRubricVersion=blind-acceptance-rubric-v2`

## Main operational thresholds

| Metric | Threshold |
| --- | --- |
| SAM | <=2% |
| FA | <=2% |
| High-priority false positives | 0 |
| Uncertain review | 100% |
| IAM | <=3% |
| Archive violation | 0 |
| Evidence exact | 100% |
| External automatic action | 0 |

## Search thresholds

| Metric | Threshold |
| --- | --- |
| Returned direct precision | >=90% |
| Answerable success | >=90% |
| Wrong result | 0 |
| Unanswerable abstention | 100% |
| Junk, promotion, or deleted result | 0 |
| Semantic evidence violation | 0 |

## Blind-set governance

New blind cases are frozen before implementation and evaluated in the declared
order. The implementation author must not modify labels, ground truth, case order,
or exclusions after freeze. Exclusions require a documented corpus or policy
reason and independent reviewer approval. A reviewer who did not author the
implementation evaluates the frozen set; the reviewer records abstentions and
failures rather than replacing them with adjacent candidates.

The blind corpus and labels are immutable acceptance inputs. This rubric does not
embed its own SHA; the release owner fixes the referenced artifact separately.
