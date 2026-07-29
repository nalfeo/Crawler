# Handoff: PR #2006 recovery follow-up

## Systems touched

mapgen

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One main merge, one deterministic parity
re-baseline, and one documentation accuracy update for the still-open review
thread.

## Summary

- Merged latest `origin/main` into `copilot/fix-harvestables-spawn-issue-another-one`
  and resolved the only textual conflict in
  `briefs/characters/sweaty-merchant-v2.yaml`.
- Revalidated the PR #2006 review thread with a separate model after checking the
  live issue/PR history: issue #1934 now has a retroactive owner-filed plan
  comment, but there is still no explicit maintainer waiver for the missed
  pre-coding timing requirement.
- Updated the original 2026-07-25 handoff note so it no longer incorrectly says
  the issue has no plan comment.
- Rebaselined `tests/headless/collision-pair-parity.test.ts` to the current,
  deterministic merged-head fingerprint family that matches the restored
  spawn-room-harvestable behavior.

## Files touched

- `briefs/characters/sweaty-merchant-v2.yaml`
- `docs/knowledge/handoffs/2026-07-25-floor1-spawn-room-harvestable.md`
- `docs/knowledge/handoffs/2026-07-29-pr2006-recovery-followup.md`
- `tests/headless/collision-pair-parity.test.ts`

## Verification

- GitHub Actions inspection:
  - `list_workflow_runs` for branch `copilot/fix-harvestables-spawn-issue-another-one`
  - `get_job_logs` for failing run `30415015072`
- Separate-model review-thread validation (`claude-sonnet-5`): blocker still
  applicable; explicit waiver still missing
- `npx vitest run --project unit tests/game/floor1-harvestable-spawn-room.test.ts` ✅
- `npx vitest run --project headless tests/headless/floor1-legacy-death-regressions.test.ts` ✅
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- PR review comment `3650089187` remains substantively open. The retroactive
  issue plan comment corrected the earlier missing-comment fact, but it did not
  explicitly waive the issue’s “before writing any code” timing requirement.

## Next steps

- Push the merge + parity/test/handoff updates so PR #2006 gets a fresh
  non-conflicting head.
- Run secret scanning and parallel validation on the final diff before closing
  out the repair session.
- Leave the review thread unresolved unless the maintainer explicitly waives the
  timing requirement.
