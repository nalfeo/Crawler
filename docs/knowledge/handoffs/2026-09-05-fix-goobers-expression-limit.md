# Fix Goobers workflow expression limit

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**

## Summary

Fixed the Goobers Run workflow parse failure introduced by the four-slot design.
The 21,000-character `Handle no-work disposition` shell body no longer embeds
GitHub Actions expressions: the uploaded journal artifact ID is exported through
step `env` and referenced as a shell variable in all five diagnostics.

Added a structural regression that scans every oversized workflow `run` block
and fails if it contains `${{ }}` interpolation. The executable cleanup harness
now supplies the new environment value just as Actions does.

## Validation

- Parsed `.github/workflows/goobers-run.yml` with `yaml` and checked the extracted
  disposition body with `bash -n`.
- Confirmed the 21,436-character disposition body contains zero GitHub expressions.
- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts --reporter=dot`
  — 138 passed, 2 platform-gated skips.
- `npm run verify:fast`

## Apples

Actual: **2** — exact estimate; the fix remained confined to the workflow and
its focused structural/executable coverage.
