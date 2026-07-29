# Handoff: PR #2006 merge recovery

## Systems touched

mapgen, ci-policy, sprite-pipeline

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One merge-conflict resolution, one deterministic test re-baseline, and one small syntax repair needed to get the merge commit through local guards.

## Summary

- Merged `origin/main` into `copilot/fix-harvestables-spawn-issue-another-one` and resolved the only textual conflict in `tests/headless/collision-pair-parity.test.ts`.
- Recomputed the merged branch's Floor 1 collision-pair parity fingerprints and re-baselined the test to the merged deterministic values.
- Fixed a malformed line break in `briefs/characters/sweaty-merchant-v2.yaml` that blocked the merge commit's staged-file Prettier hook after the main merge.
- Revalidated the open review thread on PR #2006 with a separate model: the issue-#1934 process blocker still stands because there is still no explicit human maintainer waiver for the missed pre-coding issue-side plan comment.
- Checked the branch's recent GitHub Actions runs before making code changes: the latest completed recovery workflow on the pre-merge head (`30282443892`) had no failed jobs.

## Files touched

- `tests/headless/collision-pair-parity.test.ts`
- `briefs/characters/sweaty-merchant-v2.yaml`
- `docs/knowledge/handoffs/2026-07-29-pr2006-merge-recovery.md`

## Verification

- GitHub Actions inspection:
  - `list_workflow_runs` on branch `copilot/fix-harvestables-spawn-issue-another-one`
  - `get_job_logs` for run `30282443892` (`failed_jobs: 0`)
- Separate-model review-thread validation (`claude-sonnet-5`): blocker still applicable
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts` ✅
- `npx vitest run --project unit tests/game/floor1-harvestable-spawn-room.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- PR review comment `3650089187` is still substantively open. Issue #1934 now has a retroactive CI-filed plan comment, but not an explicit first-person maintainer waiver acknowledging that the required pre-coding issue comment was missed.

## Next steps

- Push the merge recovery commit so PR #2006 gets a fresh head with the main-merge conflict resolved.
- Run secret scan + parallel validation on the current branch state before final PR handoff.
- Leave the review thread unresolved unless the maintainer explicitly waives the timing requirement.
