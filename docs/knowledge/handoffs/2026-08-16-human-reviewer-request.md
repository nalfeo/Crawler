# Handoff: Human reviewer request

## Systems touched

ci-policy

## What changed

- The PR ready guard now requests `nalfeo` only when the canonical
  `requiresHumanApproval` policy identifies a ready PR as human-gated.
- It never removes an existing requested reviewer.
- Requests are idempotent and cover direct labels, balance-telemetry branches,
  and closing issues carrying `human-approval-required`.
- Requests are skipped when the configured reviewer authored the PR, avoiding
  GitHub's self-review rejection.

## Validation

- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs`
- `npm run verify:fast`

## Apples

Estimated 2🍎; actual 2🍎 (🎯 Exact). The change was limited to the existing
PR-state guard, its workflow wording, and deterministic policy coverage.
