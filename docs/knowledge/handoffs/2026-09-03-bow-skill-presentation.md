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
- Verdict: 🎯 Exact — the presentation-only catalog and HUD announcement change stayed within the planned small scope.

## What changed

- Added a shared presentation entry for `bow-shot-base` using the player-facing
  name `Steady Aim`, the bow prerequisite, and the concrete effect
  `+0.1 accuracy with bows`.
- Made the game ability registry consume that shared presentation instead of
  exposing the internal ability's generic `Bow Shot` copy.
- Added passive effect summaries to skill unlock announcements, so the Bow L5
  announcement reads `Passive Unlocked: Steady Aim — +0.1 accuracy with bows`.
- Kept the skill milestone's `abilityId`, grant flow, and numeric balance
  unchanged.

## Evidence

- Before: the Bow L5 ability catalog entry was `bow-shot-base` / `Bow Shot`
  with `Basic bow attack`, and its unlock announcement exposed only the
  generic ability name.
- After: the real `MainGameScene` deterministic HUD probe showed `Steady Aim`,
  `+0.1 accuracy with bows`, and no `bow-shot-base`.
- Focused game and registry tests: 47 passed.
- `npm run verify:fast`: passed.
- `npm run typecheck`: passed.
- Focused real-HUD e2e observation: passed.
