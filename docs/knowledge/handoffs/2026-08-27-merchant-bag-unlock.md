# Session Handoff: Merchant Bag Unlock

## Date

2026-08-27

## Persona

Game Designer

## Systems touched

quests

## Apples

2🍎 estimated, 2🍎 actual (exact). The change remained a feature-unlock predicate plus focused coverage.

## What Was Done

- On floors configured with `merchantCharmGatesEquipment`, the Bag now unlocks only
  after that configured merchant prerequisite quest is complete.
- Floors without that gate retain their existing fetch-item unlock behavior.
- Added coverage for the reported pre-errand pickup and adjusted both merchant
  questline tests to assert the Bag remains locked through the fetch step and
  becomes available on completion.

## Validation

- The Floor 1 scenario questline test observes the configured Floor 1 runtime setup:
  pre-errand and mid-errand rat-tail pickup leave `featureUnlocks.inventory` false;
  equipping the charm and completing the errand changes it to true.
- Focused quest and Floor 1 scenario tests: 85 passed.
- `npm run verify:fast`: passed (144 files, 2,368 tests).

## Blockers

None.
