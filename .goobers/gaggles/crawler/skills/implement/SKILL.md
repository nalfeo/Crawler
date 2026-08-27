---
name: implement
description: Implement one claimed Crawler feature as a focused working change.
---

# Implement

Read the claim and producer plan, make a short implementation plan, and follow
the target repository's instructions. Keep the diff scoped to the feature,
write deterministic regression coverage for confirmed bugs, and commit only a
working change. Do not push or open a PR; the workflow owns those stages.

On review or local-gate repasses, consume every attached finding and finish the
fixable work in one pass, including deterministic tests, lab registration, and
real pipeline observation notes when Crawler policy requires them. Do not report
success while known fixable findings remain.

Read upstream context from the `.goobers/context/*` files named in the prompt.
If optional `list_inputs`, `grep_input`, or `read_input` helpers are unavailable,
ignore them and continue; missing Goobers input tools alone is not an escalation
reason.

Your first shell command must list `.goobers/context/` and print the readable
context files there. A missing helper tool is not the same as missing
requirements context; do not report `MISSING_REQUIREMENTS_CONTEXT` unless the
directory was listed and the required files were absent or unreadable.

Return the final completion as raw JSON only, with scalar-only `outputs`.
