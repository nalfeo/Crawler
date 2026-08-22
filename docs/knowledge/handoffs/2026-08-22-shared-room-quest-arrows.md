# Shared-room quest arrow directions

## Systems touched

quests, hud-ux

## Summary

Quest waypoints now share a deterministic room anchor when multiple active
quest targets occupy different tiles in the same semantic room. Singleton
targets and already-identical targets retain their precise positions.

The MainGameScene probe now places two quest NPCs on diagonal tiles in one
off-screen room and verifies that both arrows remain visible, separated, and
share one rotation.

## Observation

- Before: disabling shared-room normalization makes the deterministic
  MainGameScene regression fail because the two arrows use different rotations.
- After: the real-scene regression passes 2/2; both same-room arrows render on
  the same edge at least 48 pixels apart with equal rotations.

## Validation

- `npx vitest run --project unit tests/ecs/questWaypoints.test.ts tests/unit/hud-direction-arrows.test.ts`
- `npx vitest run --project e2e tests/e2e/quest-waypoint-arrows.deterministic.test.ts`
- `bash scripts/agent/verify-fast.sh` (144 files, 2,368 tests)
- `npm run typecheck`
- Changed-file secret scan

## Apples

Estimated 2🍎; actual 3🍎 (📉 Under) because real-artifact observation required
strengthening the typed MainGameScene fixture in addition to the core fix and
regression.
