# Goobers hosted-progress token recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 2🍎 — actual: 2🍎. Exact: the failure was isolated to one missing
workflow environment binding plus its existing contract test.

## Summary

- Exposed the job-scoped `github.token` as `GITHUB_TOKEN` to the
  `goobers run --github-progress` process.
- Kept the separate `GOOBERS_GITHUB_TOKEN` / `GH_TOKEN` repository mutation
  credential unchanged, preserving the Contents write requirement for branch
  publication.
- Extended the workflow contract test to prevent either hosted-progress or
  repository credentials from silently disappearing.
- Removed `GITHUB_TOKEN` from the generated `runner.envPassthrough` list so the
  hosted-progress token stays on the top-level `goobers run` process instead of
  being copied into every deterministic and agentic stage. No gaggle stage reads
  `GITHUB_TOKEN`; repository mutation stages use `GH_TOKEN`.

## Evidence

- Before: Goobers run `33254739553` stopped before backlog claim with
  `github progress requires GITHUB_TOKEN`.
- After: the parsed workflow contract requires `GITHUB_TOKEN:
${{ github.token }}` on the exact `Run the workflow` step while continuing to
  require the write-capable secret fallback for repository operations.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
