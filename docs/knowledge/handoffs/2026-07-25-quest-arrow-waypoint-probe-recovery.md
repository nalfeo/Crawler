# Handoff: Quest arrow waypoint probe recovery

**Date:** 2026-07-25  
**Session slug:** quest-arrow-waypoint-probe-recovery  
**Issue/PR:** nalfeo/Crawler#1941  
**Apple estimate:** 2🍎

## Systems touched

hud-ux

## What was done

- Investigated the live PR #1941 blockers with GitHub Actions MCP for run `30153255430`.
- Confirmed `ci` and `Merge gate` were aggregate fallout; the real blockers were:
  - `Lightweight Checks` → Prettier formatting failures in `src/labs/ux-snapshot-lab/index.ts` and `tests/e2e/minimap-overlay.test.ts`
  - `E2E Visual — Game/UI` → both new minimap-arrow regressions timed out waiting for exported arrow bounds that never appeared
- Traced the E2E timeout to the UX snapshot probe helper: `setTrackedWaypointPx(...)` was re-tracking `floor1-tutorial`, whose active objective is the location-less `Reach level 2` goal, so `getTrackedQuestWaypoint(...)` correctly returned no waypoint and no edge arrow could ever render.
- Fixed the probe to activate and track `floor1-find-welcome`, which does have a positional waypoint, then reformatted the touched files.
- Tightened the radar regression to wait for the runtime-computed radar-arrow bounds before taking the screenshot it samples.
- Added a fresh 2🍎 review ledger for this recovery so `verify:pr-prereqs` can validate the current code-touching diff.

## Verification

- GitHub Actions diagnosis via MCP:
  - `Lightweight Checks` job `89667113192`
  - `E2E Visual — Game/UI` job `89667113209`
- `npx prettier --check src/labs/ux-snapshot-lab/index.ts tests/e2e/minimap-overlay.test.ts` ✅
- `git diff --check` ✅
- `npm run scope` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-quest-arrow-waypoint-probe-recovery.review-ledger.json` ✅
- Secret scan on changed files ✅
- Local Vitest re-run remains sandbox-blocked: `npx vitest run --project e2e tests/e2e/minimap-overlay.test.ts` cannot load `vitest.config.ts` because the worktree’s local `vitest` install is incomplete (`ERR_MODULE_NOT_FOUND` for `vitest/config`).

## Remaining work / notes

- Re-run CI on the PR branch to confirm the positional quest probe restores the minimap overlay/radar arrow regressions.
- After fetching and unshallowing `origin/main`, re-run `npm run verify:pr-prereqs`; before this handoff it still reported the review-ledger guard as missing context for the current diff.
