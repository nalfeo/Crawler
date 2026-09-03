# Handoff: Bow skill milestone presentation

## Date

2026-09-03

## Persona

UX Designer

## Systems touched

skills, abilities, hud-ux

## Apples

- Estimated: 2🍎
- Actual: 2🍎
- Verdict: 🎯 Exact — the catalog copy, HUD announcement, and the single Bow L5
  effect correction stayed within the planned small scope.

## What changed

- Added a shared presentation entry for `bow-shot-base` using the player-facing
  name `Steady Aim`, the bow prerequisite, and the concrete effect
  `+0.1 accuracy with bows`.
- Changed the Bow L5 ability effect from an inert `damage +0` stat add to the
  advertised `accuracy +0.1` while a bow is equipped. This is a real gameplay
  change: the milestone previously granted nothing.
- Made the game ability registry consume that shared presentation instead of
  exposing the internal ability's generic `Bow Shot` copy.
- Added passive effect summaries to skill unlock announcements, so the Bow L5
  announcement reads `Passive Unlocked: Steady Aim — +0.1 accuracy with bows`.
- Kept the skill milestone's `abilityId` and grant flow unchanged; the Bow L5
  modifier now matches the milestone's existing documented numeric reward.
- Replaced the `TBD` effect summaries on the generic L10/L15/L20 placeholder
  abilities so those milestone banners no longer surface a placeholder sentinel
  to players.

## Evidence

- Before: the Bow L5 ability catalog entry was `bow-shot-base` / `Bow Shot`
  with `Basic bow attack`, and its unlock announcement exposed only the
  generic ability name.
- After: the real `MainGameScene` deterministic HUD probe showed `Steady Aim`,
  `+0.1 accuracy with bows`, and no `bow-shot-base`.
- Focused Bow skill/ability regression tests: 33 passed.
- `npm run verify:fast`: passed.
- `npm run typecheck`: passed.
- Focused real-HUD e2e observation: passed.
