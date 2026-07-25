# Handoff: Floor 1 spawn-room harvestable guarantee

## Systems touched: mapgen, quests

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One targeted Floor 1 scenario fix plus
focused regression coverage and the required ledger/handoff artifacts.

## What was done

- Updated `spawnFloor1HarvestableNodes()` in
  `/home/runner/work/Crawler/Crawler/src/game/floorScenario.ts` so Floor 1 now
  guarantees one of its existing harvestable placements resolves inside the
  starting room.
- Kept the change surgical:
  - no new harvestable counts were added;
  - the shared `world.rng` draw count for each placement attempt stays aligned
    with the old flow;
  - only the first Floor 1 harvestable placement is forced into the spawn room.
- Blocked obviously bad spawn-room tiles for that guaranteed placement by
  excluding tiles already occupied there (player / NPC / sign / other positioned
  entities already present before harvestables spawn), including the player spawn
  tile.
- Added `tests/game/floor1-harvestable-spawn-room.test.ts` with representative
  seed coverage asserting:
  - each sampled Floor 1 seed gets at least one harvestable in the spawn room;
  - that harvestable never lands on the player spawn tile.

## Verification

- `npm test -- tests/game/floor1-harvestable-spawn-room.test.ts` ❌ environment
  blocked: `vitest` is unavailable because repository dependencies are not
  installed in this sandbox.
- `npm run verify:fast` ❌ environment blocked: local pinned dependencies are
  missing (`vitest`, `typescript`, `@eslint/js`), and the fallback install path
  cannot complete here.
- `npm ci` ❌ blocked by DNS/network failure fetching lockfile-resolved tarballs
  from `ms-feed-2.pkgs.visualstudio.com` / `ms-feed-12.pkgs.visualstudio.com`.
- `npm run review:ledger -- init --apples 2 --slug floor1-spawn-room-harvestable --title "Guarantee a Floor 1 spawn-room harvestable"` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-floor1-spawn-room-harvestable.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Notes / remaining work

- I attempted to post the required pre-coding plan comment on issue #1934 from
  this sandbox, but both `gh issue comment` and a direct REST fallback returned
  403s here. The same plan was recorded in-session instead.
- Once this branch is pushed with the handoff/ledger, re-run the authoritative
  CI checks in an environment that has the repo’s pinned dependencies available.
