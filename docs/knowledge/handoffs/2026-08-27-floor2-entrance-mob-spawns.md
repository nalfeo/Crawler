# Session Handoff: Floor 2 entrance mob spawns

## Date

2026-08-27

## Persona

Game Designer

## Systems touched

enemies, mapgen

## Apples

2🍎 estimated, 2🍎 actual

## What Was Done

Floor 2's ambient enemy director now rejects candidates inside the `SPAWN` room,
in addition to preserving its existing boss-den exclusion. The entrance remains
the Floor 2 player's safe arrival room, while normal territory rooms are still
eligible for ambient spawning. A focused deterministic unit test covers each
protected role and a valid territory room.

## Key Decisions Made

The exclusion belongs in Floor 2's final ambient-candidate acceptance gate
rather than the shared ambient resolver. This keeps Floor 1 and Floor 3 spawn
selection unchanged and avoids a broader candidate-filter API for one Floor 2
rule.

## Validation

- `npx vitest run tests/unit/floor2-director-territory.test.ts --project unit` ✅
- `npx vitest run tests/headless/floor2-completion.test.ts --project headless` ✅
  - Includes a real-headless assertion that tracks newly-created Floor 2 ambient
    enemies and rejects any creation in `RoomRole.SPAWN` or `RoomRole.BOSS_DEN`.
- `npm run verify:fast` ✅
- `npm run format:check` ✅

## Runtime / observe-before-done

- **Before:** the reported Floor 2 run `9d9825f5-656c-4b9e-b4f4-89d5f1d7350f`
  showed a mob inside the entrance room. The supplied blob bundle could not be
  fetched in this sandbox because its hostname did not resolve.
- **After:** `tests/headless/floor2-completion.test.ts` runs the real Floor 2
  headless pipeline and its new ambient-spawn assertion observed newly-created
  tracked ambient enemies while confirming none were created in `RoomRole.SPAWN`
  or `RoomRole.BOSS_DEN`.

## What's Next / Blockers

No blockers or follow-up work identified.
