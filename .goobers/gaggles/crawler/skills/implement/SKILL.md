---
name: implement
description: Implement one claimed Crawler feature as a focused working change.
---

# Implement

Read the claim and producer plan, make a short implementation plan, and follow
the target repository's instructions. Keep the diff scoped to the feature,
write deterministic regression coverage for confirmed bugs, and commit only a
working change. Do not push or open a PR; the workflow owns those stages.

Use `list_inputs`, `grep_input`, and `read_input` for upstream context when
available. If those tools are missing, read the `.goobers/context/*` files named
in the prompt directly; missing Goobers input tools alone are not an escalation
reason.

Return the final completion as raw JSON only, with scalar-only `outputs`.
