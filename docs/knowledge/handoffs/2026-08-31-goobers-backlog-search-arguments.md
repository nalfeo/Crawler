# Goobers backlog search argument recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 2🍎 — actual: 2🍎. Exact: the hosted failure reduced to one malformed
CLI invocation plus its existing workflow contract test.

## Summary

- Replaced the combined `gh search issues` query string with explicit repository,
  state, label, and assignee flags.
- Preserved the negative in-review label qualifier as a separate positional
  search argument after `--`.
- Strengthened contract coverage to reject the malformed combined query.

## Evidence

- Before: scheduled Actions run `33362454076` failed in
  `Resolve Goobers recovery target` because GitHub CLI interpreted the combined
  query as repository
  `nalfeo/Crawler is:issue is:open label:\"goobers:approved\" ...`.
- Issue `#3798` therefore remained open, unassigned, and unclaimed.
- After: each filter has its own GitHub CLI argument boundary, with
  `-label:"goobers/status:in-review"` passed after the option terminator.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `npm run format:check -- --check .github/workflows/goobers-run.yml tests/unit/goobers-run-workflow.test.ts`

## Recommended next step

- After merge, dispatch or observe `Goobers Run` and confirm issue `#3798` is
  selected before the Goobers implementation stages begin.
