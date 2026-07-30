# Handoff: Floor 1 harvestable special-room recovery

## Systems touched: mapgen

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One targeted Floor 1 placement fix, one
focused regression update, and the required recovery-session artifacts.

## Summary

- Corrected `spawnFloor1HarvestableNodes()` so Floor 1 harvestables only choose
  `RoomRole.NORMAL` rooms.
- Removed the later spawn-room relocation/guarantee path that had been added on
  this branch.
- Re-baselined the deterministic collision-pair parity fixture for seeds 7 and
  137 to match the new special-room-exclusion behavior after verifying the
  updated slice stays byte-stable across back-to-back runs.
- Updated focused regression coverage to assert harvestables never land in
  special rooms and never occupy the player spawn tile.

## Files touched

- `src/game/floorScenario.ts`
- `tests/game/floor1-harvestable-spawn-room.test.ts`
- `docs/knowledge/review-ledgers/2026-07-26-floor1-harvestable-special-room-recovery.review-ledger.json`

## Verification

- `npx vitest run --project unit tests/game/floor1-harvestable-spawn-room.test.ts` ✅
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-26-floor1-harvestable-special-room-recovery.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- The pre-existing review thread about issue #1934's missing pre-coding
  issue-comment plan still needs explicit maintainer waiver or separate
  issue-side remediation; this recovery did not change that status.

## Recommended next steps

- Reply on the maintainer's PR comment with the addressing commit hash.
- Leave the unresolved issue-#1934 review thread for human waiver/escalation
  unless the maintainer explicitly clears it.

## Notes

- Local `npm ci` in this sandbox required a temporary, uncommitted rewrite of
  Azure Artifacts tarball URLs embedded in `package-lock.json` back to
  `https://registry.npmjs.org/` so the standard toolchain could install. The
  lockfile was restored before any commit.
