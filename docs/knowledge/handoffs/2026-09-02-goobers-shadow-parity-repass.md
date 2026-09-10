# 2026-09-02 Goobers shadow parity repass

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## What changed

- Replaced the synthetic shadow decision with read-only replay of completed CI
  Recovery and Merge Train workflow runs and their associated PR review threads.
- Added deterministic coverage accounting: each requested legacy lane must have
  captured runs, otherwise the daily report fails closed with a divergence.
- Added strict marker parsing that rejects quoted and malformed resolution
  markers; a legacy-resolved thread without a valid marker is reported as a
  marker-parity divergence.
- The workflow now uploads both captured legacy trigger inputs and a
  `daily-report.json` alongside the deterministic decision report.

## Verification

- `npm run test:unit -- tests/unit/goobers-shadow.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`

## Apples

Estimated 3, actual 3 — exact: this required a workflow replay path, parity
semantics, focused regression coverage, and a directly related contract update.
