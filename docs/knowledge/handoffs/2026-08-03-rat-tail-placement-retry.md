# Re-placing the rat tail: merchant-anchored, 2/3 of max, with reachability retries

**Date:** 2026-08-03

## Systems touched

mapgen, quests

## Ask

> Try again on placing the rat tail. Make sure it ends up in an actual reachable room.
> You can do retries if first choice fails. We want it to be about 2/3 as far as maximum
> distance would be.

Follow-on from `2026-08-03-floor1-quest-tour-distance.md`, which bounded the fetch item
to a 2–4 room-graph hop band around the **shop room**.

## Root cause of the erratic errand

The hop band anchored on the wrong room. `chooseObjectiveTiles` computes a `shopRoomPos`,
but the shopkeeper is in `FLOOR1_CRITICAL_PROGRESS_NPC_IDS`, so `spawnNpcFromPlacement`
overrides its room-role position and spawns it in the **welcome hub** — and the objective's
`shopRoomPos` is then rewritten to the NPC's actual tile. The errand the player walks is
`welcome hub → item → welcome hub`; the placement rule was measuring from a room the
merchant never occupies.

Measured against the merchant's real position (locked-door-aware BFS, seeds 1–40), the
shipped hop band produced fetch distances of **0.07–0.96 of the reachable maximum, median
0.51** — i.e. effectively unbounded in both directions. Hop counts are also a poor proxy
for walking distance, which compounded the spread.

## Change

`src/game/floorScenario.ts` only:

1. **`buildTravelDistanceField(floorMap, start, blockedDoorTiles)`** — new BFS returning
   per-tile walk distances (`-1` = unreachable) over passable tiles plus unblocked doors.
   `buildReachableFromSpawnMask` is now a thin derivation of it, so there is one BFS
   implementation rather than two (the old one used a stack, which is fine for
   connectivity but cannot produce distances).
2. **Fetch item placement** is anchored on `merchantPos` — `welcomeOfficePos` while the
   shopkeeper is a critical-progress NPC, `shopRoomPos` otherwise, keyed off
   `isCriticalProgressNpcType('shopkeeper')` so it stays correct if the merchant moves back
   to the shop room.
3. Candidates are scored on a travel field computed with the **initially locked doors
   (boss staircase + slime-rat room) treated as walls**. A finite distance is the
   reachability proof — this is exactly the state of the floor when the errand is issued.
4. Candidates are ranked by `|distance − 2/3 × maxDistance|`, ties broken by room id
   (deterministic). The rule **retries down the ranked list**: each candidate is accepted
   only if its resolved tile is passable and spawn-reachable with the locked doors shut;
   a rejection falls through to the next-best room.
5. Final placement is recomputed after the welcome carve / lock-aware connector / special-room
   sealing settle the real geometry. If no lock-aware reachable candidate exists at that point,
   Floor 1 generation now fails explicitly instead of restoring the old unvalidated hop-band path.

## Result (locked-door-aware BFS from the merchant's actual tile)

| metric                | before (hop band) | after    |
| --------------------- | ----------------- | -------- |
| fraction of max, min  | 0.07              | **0.36** |
| fraction of max, p25  | —                 | **0.65** |
| fraction of max, med. | 0.51              | **0.67** |
| fraction of max, p75  | —                 | **0.68** |
| fraction of max, max  | 0.96              | **0.85** |

(seeds 1–100). The residual spread is room granularity: on some floors no room sits near
the 2/3 mark, and the nearest one is what gets picked.

Fetch round trip (doors open, the leg walked twice): median 448, p90 576, max 842 tiles —
still inside the existing ≤ 1000-tile gate. Full quest tour stays under the existing
median ≤ 1250 / max ≤ 1900 thresholds unchanged.

**Zero unreachable placements** across seeds 1–100, both from spawn and from the merchant,
with the boss-stair and slime-rat doors shut.

## Regression gate

`tests/game/floor1-quest-tour-length.test.ts` gains two deterministic tests (no LLM judge):

- the rat tail is reachable from both the player spawn and the merchant with the locked
  doors shut, on every seed in the 24-seed prefix;
- per-seed distance fraction stays in (0.3, 0.9) and the **median sits in (0.6, 0.75)** —
  the median is what pins the 2/3 rule; the per-seed band is loose because room granularity
  limits how close a single seed can land.

## Observe before done

Real-artifact validation, not lab-only: the headless AI runner (`src/game/ai/headless-runner.ts`
via `npm run ai:headless`) was run at the canonical sweep config
(`--max-frames 19800 --weapon-personas`). Before the change the placement fractions above were
measured on the same runner's world construction; after the change, 14 spot-check seeds (1, 2, 3, 5, 7, 11, 13,
17, 19, 23, 24, 29, 31, 40 — sword) all reach **VICTORY** with no `ObjectiveRoutePlannerError: unreachable-required-goal`.

## Caveats / follow-ups

- Only 14 headless seeds were run locally; `gh` / `GITHUB_TOKEN` remain invalid
  in this sandbox, so no `workflow_dispatch` sweep was possible (AGENTS.md rule #15). The
  600-run canonical sweep should be re-run in CI against the 587/600 = 97.8% baseline.
- The **slime-rat room** placement is still untouched. The prior handoff's warning stands:
  relocating it needs an unlock-_sequence_-aware acceptance check (two rooms are locked at
  once), not a single-room removal predicate.
- The merchant anchor is derived, not asserted. If Floor 1 ever gives the shopkeeper its own
  room again, `isCriticalProgressNpcType('shopkeeper')` flips and the anchor follows — but
  nothing fails loudly if a _third_ placement path is added, so a future change that moves
  the merchant by some other mechanism should re-measure the fraction.
