# Architectural adversarial design review

Adversarial design review is triggered by **architecture**.
Run it only when the change modifies a load-bearing system boundary,
cross-system contract, or durable architecture decision.

Before implementation, ask an independent reviewer to:

1. enumerate at least two credible alternative approaches;
2. argue against the proposed design;
3. identify boundary, migration, determinism, and rollback risks; and
4. recommend accept, revise, or reject.

Resolve the concerns before coding. Record the durable decision in the relevant
ADR or PR discussion. Do not create a review-specific JSON artifact.

Non-architectural changes skip this stage and use the risk-based post-diff
review trigger.
