---
name: implement
description: Implement one claimed Crawler feature as a focused working change.
---

# Implement

Read the claim and producer plan, make a short implementation plan, and follow
the target repository's instructions. Keep the diff scoped to the feature,
write deterministic regression coverage for confirmed bugs, and commit only a
working change. Do not push or open a PR; the workflow owns those stages.

Read upstream context from the `.goobers/context/*` files named in the prompt.
If optional `list_inputs`, `grep_input`, or `read_input` helpers are unavailable,
ignore them and continue; missing Goobers input tools alone is not an escalation
reason.

Return the final completion as raw JSON only, with scalar-only `outputs`.
