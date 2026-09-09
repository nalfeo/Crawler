# Goobers PR status reporting

## Systems touched

ci-policy

## Apples

Estimated 3, actual 3 — 🎯 Exact. The workflow-only reporter change required
one implementation path and deterministic contract coverage, matching the
planned tooling-only medium scope.

## Outcome

The Goobers terminal reporter now mirrors each validated open
`goobers/crawler/*` pull request's delivery result to an idempotent,
destination-specific PR comment. The PR status includes the canonical PR and
source issue links, outcome, Actions conclusion, failure code, terminal stage,
elapsed time, and journal artifact. Issue-only runs remain unchanged.

Issue and PR comment lookup, creation, and update failures are surfaced and
fail the reporting step instead of being silently treated as successful
delivery. Claim cleanup and PR validation remain unchanged.

## Verification

- `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts --run`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`

## Risk

Low: the change is confined to terminal CI reporting and its workflow contract
tests; it does not change Goobers claim, cleanup, or gameplay behavior.
