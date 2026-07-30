# Handoff: Floor 1 spawn-room harvestable guarantee

## Systems touched: mapgen, quests

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One targeted Floor 1 scenario fix plus
focused regression coverage and the required ledger/handoff artifacts.

## What was done

- Updated `spawnFloor1HarvestableNodes()` in
  `/home/runner/work/Crawler/Crawler/src/game/floorScenario.ts` so Floor 1 now
  guarantees a spawn-room harvestable by relocating one already-spawned node
  into the starting room only when the normal placements left it empty.
- Kept the change surgical:
  - the normal Floor 1 harvestable placement loop is unchanged, so the main RNG
    stream and downstream entity ids stay aligned with the old flow;
  - no new harvestable counts or extra entities are introduced;
  - the relocation targets the legal spawn-room interior tile farthest from the
    player spawn and spawn-room exits to minimize path/collision perturbation.
- Blocked obviously bad spawn-room tiles for that relocated placement by
  excluding tiles already occupied there (player / NPC / sign / other positioned
  entities already present in the spawn room), including the player spawn tile.
- Added `tests/game/floor1-harvestable-spawn-room.test.ts` with representative
  seed coverage asserting:
  - each sampled Floor 1 seed gets at least one harvestable in the spawn room;
  - that harvestable never lands on the player spawn tile.

## Verification

- `npx vitest run --project unit tests/game/floor1-harvestable-spawn-room.test.ts` ✅
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts tests/headless/floor1-npc-objective-anchor-regression.test.ts` ✅
- `npm run review:ledger -- init --apples 2 --slug floor1-spawn-room-harvestable --title "Guarantee a Floor 1 spawn-room harvestable"` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-25-floor1-spawn-room-harvestable.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Notes / remaining work

- I attempted to post the required pre-coding plan comment on issue #1934 from
  this sandbox, but both `gh issue comment` and a direct REST fallback returned
  403s here. The same plan was recorded in-session instead.
- Update (2026-07-29): issue #1934 now has a retroactive plan comment posted by
  the CI recovery flow under the owner account. That fixes the older "issue has
  no plan comment" fact, but it does not by itself waive the original
  pre-coding timing requirement; PR #2006's review thread still needs explicit
  maintainer acknowledgment before it can be resolved deterministically.
- `npm ci` remains blocked in this sandbox because some lockfile tarballs still
  resolve to `ms-feed-2.pkgs.visualstudio.com`; I used no-save public-registry
  installs plus `npx` for local validation instead.
