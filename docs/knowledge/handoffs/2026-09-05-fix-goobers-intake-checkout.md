# Fix Goobers intake checkout

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **2**

## Summary

Fixed the Goobers Run reservation job's sparse checkout so it includes
`.github/scripts`, making the canonical Goobers intake selector and its
CI-recovery dependencies available before recovery-target resolution and
reservation revalidation.

Added deterministic workflow coverage that discovers every job invoking
`intake-selection.mjs`, requires an earlier checkout step, and verifies that any
sparse checkout covers the selector path. The lease-only release job keeps its
narrow `scripts/agent` checkout.

## Validation

- `npx vitest run tests/unit/goobers-run-workflow.test.ts --reporter=dot`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
