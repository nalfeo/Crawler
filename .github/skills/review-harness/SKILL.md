---
name: review-harness
description: >-
  Run Crawler's apple-scaled post-diff review process. Use for review planning
  and execution: 1–2 apples use tests/CI only, 3 apples require one independent
  post-diff code review, and 4–5 apples require two. Adversarial design review
  runs only for architectural changes. GitHub PR reviews and threads are the
  only audit trail; no review ledger or independent grading artifact is used.
---

# Review Harness

Apply the canonical policy in
[`docs/agent-os/policies/review-harness-policy.md`](../../../docs/agent-os/policies/review-harness-policy.md).

## Tier matrix

| Apples | Requirement                                      |
| ------ | ------------------------------------------------ |
| 1–2🍎  | Run appropriate deterministic tests and CI only. |
| 3🍎    | Obtain one independent post-diff code review.    |
| 4–5🍎  | Obtain two independent post-diff code reviews.   |

## Procedure

1. Declare apples before implementation.
2. Decide whether the change is architectural. Only architectural changes get
   adversarial design review; see
   [`references/plan-review.md`](references/plan-review.md).
3. Implement and verify the complete diff.
4. Run the required independent review(s) using
   [`references/code-review-loop.md`](references/code-review-loop.md).
5. Fix valid findings and rerun affected deterministic checks.
6. On a PR, keep all review evidence and resolution in native reviews/threads.
   Do not create a parallel JSON or prose review record.

Never weaken an unrelated deterministic gate to satisfy review policy.
