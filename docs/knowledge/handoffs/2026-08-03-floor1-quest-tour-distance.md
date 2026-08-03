# Bounding Floor 1 quest travel distance

**Date:** 2026-08-03
**Systems touched:** floor-scenario, map-generation, ai-headless-runner

## Ask

> Fix map gen so the total distance required to travel for quests is a reasonable amount.

Follow-on from the prior session that diagnosed the remaining failures in the
600-run Floor 1 sweep baseline (587/600 = 97.8% at HEAD `94eda19`).

## Diagnosis

The timeout class of failures (seeds 10, 20, 58, 60 across 9 weapon-runs) are
**near-miss victories, not stalls**. Re-run at a 600 s budget all 9 win, finishing
331.2–347.3 s against the 330 s cap. Travel efficiency is 92–97%, wiggle 0.7–3.8%,
idle ≈ 0%: `totalPathTravel` scales linearly with duration at ~24 ft/s, i.e. the AI
walks continuously for the whole run. **Duration is route length, not lost time.**
Population-wide, win-time p99 is 321 s against a 330 s cap — only ~3% margin, so the
entire right tail is pressed against the budget.

## Root cause

Floor 1 objective placement in `chooseObjectiveTiles` (`src/game/floorScenario.ts`)
deliberately _maximized_ distance:

- `questItemPos` (the merchant's rat-tail fetch item) was `[...candidates].reverse()`
  — the room **farthest** from spawn. The errand is a **round trip** (shop → item →
  shop), so the longest leg on the map was walked twice.
- `slimeRatRoomPos` was sorted to maximize its **minimum** distance to every other
  special point — reliably the most isolated room on the map, typically the corner
  opposite the boss staircase, making `slime→stair` the single longest leg.

Only `welcomeOfficePos` was bounded (the existing `WELCOME_MIN_HOPS` /
`WELCOME_TARGET_HOPS` 3–8 hop band). That band is the pattern this change copies.

### Measured quest tour (door-aware BFS, seeds 1–100)

| metric | before | after    |
| ------ | ------ | -------- |
| median | 1252   | **1068** |
| p90    | 1548   | **1372** |
| p95    | 1658   | **1497** |
| max    | 1950   | **1761** |

The doubled shop errand — the leg most worth bounding, since every tile is walked
twice — dropped from a **550-tile round trip to 332** at the median (−40%).

At ~24 ft/s and 4 ft/tile, the median tour dropped from ~209 s to ~178 s of pure
walking out of the 330 s budget.

## Change

`src/game/floorScenario.ts`, `chooseObjectiveTiles` only:

1. **Fetch item** — bounded to a **2–4 room-graph hop band around the shop**
   (target 3), ordered _within_ the band by squared tile distance to the shop.
   Hops are the structural constraint ("far enough to be a real detour"); tile
   distance is what actually costs time, so it drives the ordering.
2. **Slime-rat room placement was left unchanged** — see "Attempted and reverted".

All existing guards are preserved: the `roomsReachableWithoutBossRoom` deadlock BFS,
distinct-room guarantees, and degenerate-map fallbacks (every filter falls back to the
unfiltered pool when it would empty).

`src/core/map/generators/dungeon/roles.ts` (`BOSS_STAIR` = farthest room from spawn)
was **not** changed — it affects every floor and generator, and the fetch-item bound
delivered a safe win without it.

## Attempted and reverted — read this before retrying

Relocating the **slime-rat room** to sit "on the way to the boss" (minimize
`hops(shop→slime) + hops(slime→stair)`) collapsed the `slime→stair` leg from a median
of 319 tiles to 41 and took the whole tour to a median of 862. **It was reverted**: it
made the headless runner throw `ObjectiveRoutePlannerError: unreachable-required-goal`
on roughly 3 seeds in 25 (confirmed on seeds 1, 2, 24 with sword).

Why: the slime-rat room's doors start **LOCKED**
(`buildInitiallyLockedDoorTileSet(fm, [staircasePos, slimeRatRoomPos])`), exactly like
the boss staircase. Steering it toward the boss route makes it a chokepoint, and the
route planner correctly refuses to plan a floor where a required goal sits behind a
door that never opens in time.

Two guards were tried and were **both insufficient**:

1. Requiring the boss-stair/welcome/shop/item rooms to stay reachable with the slime
   room removed.
2. Requiring the slime room not to be an articulation point of the room graph at all.

Neither fixed the erroring seeds. The likely reason the second guard still fails is
that **two** rooms are locked simultaneously (slime _and_ boss stair), so the correct
predicate is joint reachability under the full unlock _sequence_, not single-room
removal. Anyone retrying this must model the unlock order — the cheapest way is to
reuse the AI's own `makeFloor1DoorAwareTravelOracle` / `planObjectiveRoute` as an
acceptance check on the candidate placement, rather than hand-rolling a graph
predicate. The item-only change verified clean on the same seeds, which isolates the
slime relocation as the sole cause.

## Regression gate

`tests/game/floor1-quest-tour-length.test.ts` — deterministic, no LLM judge. Measures
the actual door-aware BFS tour over a 24-seed prefix and asserts median ≤ 1250 tiles
and max ≤ 1900 tiles, plus a dedicated bound on the doubled fetch round trip (≤ 1000
tiles). A future placement change that re-inflates the route fails here instead of
silently eating the win-rate margin.

## Validation

- `npx tsc --noEmit` clean; eslint + prettier clean.
- `tests/game` unit suite: 1086 tests green (72 files), including
  `floor1-scenario.test.ts` (reachability, no sealed rooms) and the new tour gate.
- Seeds 1, 2 and 24 (sword) — which errored under the reverted slime relocation —
  verified VICTORY under the shipped item-only change.
- 600-run headless sweep (100 seeds × 6 weapons, `--max-frames 19800`,
  `--weapon-personas`) — the canonical `weapon-sweep.ts` config matching
  `weapon-sweep.yml` — **was still running at session end**. Re-run and record the
  win rate against the 587/600 = 97.8% baseline before merge. Note that a −15% median
  tour reduction may not by itself recover all 4 timeout seeds, whose overshoot was
  1.2–17.3 s; the remaining headroom is in the `slime→stair` leg, which needs the
  unlock-sequence-aware guard described above.

## Caveats / follow-ups

- **`gh` / `GITHUB_TOKEN` are invalid in this sandbox**, so no `workflow_dispatch` was
  possible (AGENTS.md rule #15 prefers GitHub-backed sweeps for > 10 runs). All sweep
  evidence is local, at the canonical CI config.
- **Blast radius:** objective placement changes flip many seeds' outcomes. Report the
  aggregate win rate, never named seeds (rules #12/#13).
- **Deaths are a separate class, untouched here.** The 4 death runs (12/pistol,
  25/throwing-knife, 29/throwing-knife, 35/bow) all die at 165–227 s _before_ the boss,
  entirely to trash-mob chip damage (rat 110–145, slime 65–99; totals 230–252), with
  exactly 1 close call each, minHP 2.3–2.9%, and **0 s in `RETREAT` state** in the melee
  deaths. That is an AI retreat-policy gap, not a map-gen problem.
- **`stuckPct` telemetry is broken.** It reads ~26% in _every_ run including a clean
  207 s win — a constant fraction of run length with zero diagnostic signal. It is
  almost certainly counting stationary combat/interaction frames as "stuck". Worth
  fixing separately; it will mislead future investigators.
- `findTilePath` treats doors as impassable (they are quest-gated) and returns `[]` on
  failure, so any geometric tour measurement needs its own door-aware BFS.
