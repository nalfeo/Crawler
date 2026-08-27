---
name: run-tests
description: Run focused Crawler verification before the deterministic local gate.
---

# Run Tests

Run targeted checks that cover the changed behavior and fix failures before
handing back to the workflow. Do not weaken explicit requirements or silently
skip failures. The workflow's `local-ci` stage authoritatively runs
`npm run verify:fast`; do not duplicate it unless targeted diagnosis requires
it.
