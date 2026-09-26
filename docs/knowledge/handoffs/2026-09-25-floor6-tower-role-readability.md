# Handoff: Floor 6 tower-role readability

## Systems touched

floor6-scenario, scenario-presentation, main-game-scene, floor6-tests

## Summary

Added manifest-owned combat-role labels for the existing Floor 6 tower roster:
Rapid lane response, Heavy Relay guard, and Wide route coverage. The labels
flow through the pure scenario snapshots to build choices, occupied-tower
inspection, and procedural world labels. No combat behavior, automatic player
attacks, movement, equipment controls, economy values, wave pacing, or targeting
changed.

## Observation

Before: a player could earn requisitions with normal movement and automatic
combat, but saw tower names/costs/ranges without a readable combat job.

After: the real `floor6-player-loop` normal-pointer acceptance flow earns and
collects requisitions, presents `Rapid lane response` in the Signal Slinger
choice, builds it, and observes the same role in both world label and inspection.
The deterministic headless Floor 6 replay retains all authored roles in its
terminal-safe presentation roster after tower teardown.

## Verification

- Focused unit: `floor6-player-interaction`, `floor6-towers`, and
  `floor6-wave-director` — 58 tests passed.
- Focused headless: `floor6-economy-obs` — 2 tests passed.
- Focused real scene: the normal-pointer `floor6-player-loop` acceptance test
  passed (54.3s) with local Chromium.
- `npm run typecheck:src` and `npm run verify:fast` passed.

## Unresolved issues

None. Numeric balance remains subject to the existing Floor 6 human gate.

## Recommended next steps

Publish ready for review; CI and the merge train own post-publication checks.
