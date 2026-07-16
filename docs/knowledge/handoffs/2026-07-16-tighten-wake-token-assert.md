# Handoff: Tighten merge-train wake-up token assertion

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 estimated and actual — single-file test assertion tightening; no
review-harness stages required at this tier.

## What changed

- `tests/unit/merge-train-validate-publish.test.ts`: the "reconciliation
  wake-up step uses GITHUB_TOKEN, not the App token" test previously
  asserted only `not.toContain('steps.app-token.outputs.token')`. That
  loosened invariant would also accept an unrelated PAT/secret expression
  and no longer actually enforced the GITHUB_TOKEN boundary. Tightened it
  to an explicit allowlist of the two equivalent default-token expressions
  (`${{ secrets.GITHUB_TOKEN }}` / `${{ github.token }}`), plus a retained
  explicit not-App-token assertion.
- No workflow or handoff changes — `.github/workflows/merge-train-validate.yml`
  already uses `secrets.GITHUB_TOKEN` for the wake-up step (unchanged) and
  `docs/knowledge/handoffs/2026-07-15-merge-train-wakeups.md` from PR #1165
  remains accurate.

## Validation

- `npx vitest run --project unit tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-workflow-wakeups.test.ts`
  (12/12 pass)
- `npm run verify:fast`

## Follow-up

None — this closes out the last review-round nit from PR #1165 (already
merged as commit 037f3bab) on a clean follow-up branch.
