# Session Handoff: Quest tracker controls

## Date

2026-08-27

## Persona

UX Designer

## Systems touched

hud-ux, quests

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Placed the quest tracker below the docked minimap on every floor. The Floor 2
family panel now receives the quest tracker as an existing avoidance region and
relocates when necessary. Added an `↑ ON` / `↑ OFF` control for each surfaced
active quest. The control toggles that quest's independent navigation state,
removing or restoring only its directional arrow and minimap waypoint markers;
the existing single focused/expanded `tracked` state is unchanged.

## Validation

- Before: the deterministic MainGameScene probe's Floor 2 layout placed the
  quest tracker at the upper-left; there was no per-quest arrow control.
- After: `tests/e2e/quest-waypoint-arrows.deterministic.test.ts` boots the real
  MainGameScene, confirms the tracker is beneath the minimap, clicks the
  shop-quest control, observes only its arrows disappear, then clicks again to
  observe them return.
- `npm run verify:fast` passed.

## Key Decisions Made

`showArrow` is optional for backward compatibility with saved/test quest state:
only `false` disables navigation, while newly accepted quests explicitly begin
enabled. Waypoint output is limited to the same surfaced active-quest cap as
the tracker, so every displayed navigation arrow has a visible control.

## What's Next / Blockers

No implementation blockers remain.
