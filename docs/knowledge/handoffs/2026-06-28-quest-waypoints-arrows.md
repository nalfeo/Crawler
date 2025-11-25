# Quest waypoints + HUD direction arrows — 2026-06-28

## Problem

Floor 1 grew large enough that the human player survives easily but can't
_find_ the quest goals. Choice: longer floor timer vs. waypoints+arrows. Picked
findability fix (waypoints + off-screen arrows) over inflating the timer — time
wasn't the bottleneck, navigation was.

## What shipped

- **`src/core/systems/questWaypoints.ts`** — pure `getQuestWaypoints(world, playerEid?)`
  maps the tracked quest's first active objective → ≤1 `{x,y,label,kind}` waypoint
  in feet. talk→NPC eid (fallback room), collect→item, counter `kill-slime-rat`→
  slime-rat room, goal flags→shop/spell/stairs, equip→shop. Grind goals (reach
  level 2, broad kill quotas) → `[]`. No engine imports.
- **`src/engine/HudDirectionArrows.ts`** — edge arrow ring + distance label,
  hidden when target on-screen, coloured by kind.
- **`src/engine/HudMinimap.ts`** — gold `DOT_WAYPOINT` markers on overlay + radar,
  ungated on visited (the point is to guide there).
- **`src/engine/HudUI.ts`** — wired arrows into create/sync/destroy.
- **`src/labs/quest-waypoint-lab/`** + `src/lab-main.ts` registration.
- **`tests/ecs/questWaypoints.test.ts`** — 8 tests, one per quest stage.

## Validation

- `npm run verify:fast` ✅; `npm run typecheck` ✅; 8/8 waypoint tests ✅.
- Full `npm run verify` failed only on the headless wall-time perf guard (seed 42
  sword 31.9s / bat 88.3s > 30s) under parallel CPU load; **isolated rerun of
  `tests/headless/floor1-completion.test.ts` = 60/60 pass in 127s**. HUD/resolver
  are not in the headless sim path, so no gameplay regression.
- Observed in lab (`?lab=questwaypoints-lab`): gold waypoint marker on minimap +
  quest panel tracking "Find the Welcome Office"; arrow hides when target enters
  the viewport. Before: no marker/arrow.

## Apples: 🍎🍎🍎 estimated → 🍎🍎🍎 actual (exact)

## Systems touched

quests

## Next ideas

- Promote a deterministic UI probe for the minimap marker / edge arrow.
- Pulse animation on the arrow when very close.
