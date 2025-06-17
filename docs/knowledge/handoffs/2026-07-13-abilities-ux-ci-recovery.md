# Handoff: abilities UX CI recovery

## Date

2026-07-13

## Persona

UX Designer

## Systems touched

hud-ux, mobile-ux

## Apples

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact

## What changed

- Recovered PR #1087's `E2E Visual Regression` failure, which was actually three
  timeouts in `tests/e2e/abilities-ux.test.ts` after the new saferoom gate for
  the abilities loadout landed.
- Kept the production saferoom requirement intact; the fix is isolated to the
  abilities lab probe + the E2E harness.
- Taught the abilities lab probe to open the loadout under a temporary
  `safe_room` state and restore the prior world state on close, so the arena lab
  can deterministically exercise the real loadout UI without adding a fake safe
  room to the map.
- Narrowed the persistence test to the behavior it actually covers by opening
  through the probe seam instead of depending on a gameplay shortcut outside its
  scope.

## Observe before done

- Before: the real `abilities-lab` runtime timed out opening the loadout in CI
  and locally because the arena map has no safe room, so the new saferoom gate
  immediately rejected (or auto-closed) the UI path.
- After: `npx vitest run --project e2e tests/e2e/abilities-ux.test.ts` now
  boots the real abilities lab, opens the loadout deterministically, verifies
  the 1280×720 and 960×540 layout bounds, and confirms remove/re-equip
  interactions keep the loadout open and recover correctly after closing.

## Files touched

- `src/labs/abilities-lab/index.ts`
- `tests/e2e/abilities-ux.test.ts`

## Verification

- `npx vitest run --project e2e tests/e2e/abilities-ux.test.ts` ✅
- `npm run test:unit -- tests/unit/main-game-scene-mobile-ui.test.ts` ✅
- `npm run typecheck` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Notes

- `files/guard-telemetry.jsonl` was absent in this session, so no telemetry
  capture artifact was written.
