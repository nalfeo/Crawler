# Handoff: PR #2368 inventory refresh CI recovery

**Date:** 2026-07-30  
**Session slug:** pr2368-inventory-refresh-ci-recovery  
**Issue/PR:** nalfeo/Crawler#2368  
**Apple estimate:** 2🍎

## Systems touched

inventory, hud-ux, ci-policy

## What was done

- Pulled the current failing GitHub Actions logs for run `30565024994`. The
  only real blocker was `E2E Visual — Game/UI`; `ci` and `Merge gate` were just
  propagating that failure.
- Root-caused the failing test (`main-game-scene-ui-exclusivity.test.ts >
shows a touch shortcut for boss chests outside safe rooms and opens the panel
on tap`) to the lab seam, not shipped runtime logic:
  `seedAvailableBossChest()` had started calling
  `spawnBossChestForDefeatedBoss()`, which correctly refuses to create chests
  off Floor 2. The UI-exclusivity suite boots a non-Floor-2 probe scene, so the
  helper silently created no chest and the touch shortcut never became visible.
- Repaired `src/labs/main-scene-probe-lab/index.ts` so the probe creates a
  valid available chest directly for the test seam by:
  - resolving a generated-equipment reward bundle for `boss-chest:ratfolk`
  - creating the boss-chest lifecycle record from that resolved bundle
  - refreshing the boss-chest UI afterward
- Added the missing branch metadata required by `verify:pr-prereqs` for this
  already-cross-layer PR:
  - ADR `2026-07-30-player-visible-acquisition-seam-and-headless-playability-invariants.md`
  - review ledger `2026-07-30-pr2368-inventory-refresh-ci-recovery.review-ledger.json`

## Verification

- `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅
- `npm run test:e2e -- tests/e2e/main-game-scene-quartermaster.test.ts` ✅
- `bash scripts/agent/verify-fast.sh` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-30-pr2368-inventory-refresh-ci-recovery.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Remaining work / notes

- The local install required a temporary, uncommitted rewrite of a few
  `package-lock.json` tarball URLs away from unreachable internal Microsoft
  mirrors so the sandbox could install dependencies; the lockfile was restored
  before final changes were staged.
- Once this repair commit is pushed, GitHub should rerun the branch and the
  downstream `ci` / `Merge gate` aggregators should clear if no new external
  blocker appears.
