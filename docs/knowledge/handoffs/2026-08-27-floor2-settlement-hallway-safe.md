# Handoff: Floor 2 settlement hallway safety

## Date

2026-08-27

## Persona

Game Designer

## Systems touched

mapgen, inventory

## Apples

3🍎 estimated, 3🍎 actual. Exact: the fix required generated-map metadata, shared
safe-space consumption, Floor 2 visual activation, and seeded production-path coverage.

## Summary

Floor 2's settlement rooms were individually safe, but the narrow internal hallways between
the bar and annex rooms belonged to no room. Crossing one temporarily disabled safe context.

- `CaveSystemGenerator` now publishes the exact internal door-to-door connector tile indices
  on `FloorMap`; other maps default to an empty set.
- Shared safe-space lookup recognizes those indices only after settlement initialization
  succeeds.
- Settlement initialization repaints connector floor tiles with `SAFE_ROOM_FLOOR` while
  preserving `DOOR` terrain on internal and exterior doors.
- Exterior bar doors and their adjacent cave approaches remain hostile.
- Room interiors and NPC placement candidates are unchanged.

## Runtime observation

- **Before:** the real Floor 2 scenario pipeline on seed 42 reported all four connector
  tiles `(160..163, 58)` as `room: -1, safe: false`; the two center tiles were
  `STONE_FLOOR`.
- **After:** the same scenario reported all four tiles as `safe: true`; the internal doors
  remained `DOOR`, and the two center tiles became `SAFE_ROOM_FLOOR`.
- Both exterior doors `(155,53)` / `(155,62)` and adjacent cave tiles `(155,52)` /
  `(155,63)` remained `safe: false`.

## Verification

- `npm run typecheck:src` ✅
- `npx prettier --check <changed files>` ✅
- `npx vitest run tests/unit/cave-system-generator.test.ts tests/unit/floor2-scenario-initialization.test.ts --project unit` ✅ (51/51)
- `npm run verify:fast` ✅ (611 files / 8,325 tests in its primary test pass)
- Changed-file secret scan ✅
- Review-harness plan review (`gpt-5.4`) approved with five detail corrections, all adopted.
- Review-harness code review (`claude-sonnet-4.6`) found no code concerns; its only finding
  was the expected in-progress ledger/grade state.

## Decision record

`docs/knowledge/adr/2026-08-27-floor2-settlement-hallway-safety.md`

## Unresolved issues

None.
