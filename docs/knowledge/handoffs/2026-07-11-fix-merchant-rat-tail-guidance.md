# Fix Merchant Rat Tail Guidance

**Persona:** Content Designer

## Systems touched

quests

## Summary

Re-speaking to the Sweaty Merchant now restores his active errand as the tracked
quest. This brings back the existing directional arrow and minimap waypoint to
the Rat Tail after another quest has taken tracker focus.

## Changes

- `meetShopkeeper` re-tracks the Merchant errand whenever it is still active,
  rather than only when first accepting it.
- Added a Floor 1 regression covering Merchant quest focus after the Spell
  Broker quest temporarily takes focus.

## Runtime observation

In a real initialized Floor 1 world (seed 5), the competing tracked quest
produced a combat waypoint to the Slime Rat at `(922, 470)`. Speaking to the
Merchant again switched focus to `floor1-shopkeeper-errand` and produced the
Rat Tail item waypoint at `(122, 58)`.

## Validation

- `npx vitest run --project unit tests/game/floor1-scenario.test.ts`
- `npm run verify:fast`
- `npm run verify`
- `npm run verify:pr-prereqs`

## Apples

Estimated: 2 apples. Actual: 2 apples. Exact: one quest-focus fix plus regression
coverage, with no progression or balance changes.
