# Handoff - Floor 2 AI Hunt Progression

**Date:** 2026-07-15  
**Branch:** `nalfeo-fix-floor-2-ai-progression`  
**Estimate:** 5 apples 🍎🍎🍎🍎🍎

## Systems touched

ai-pathfinding, ai-combat-balance, ai-behavior-tree, quests, hud-ux, weapons,
enemies, boss-rooms

## Summary

Implemented and proved production Floor 2 progression for the deterministic
headless runner:

- Added persistent family hunts that choose reachable live family trash, patrol
  reachable territory interiors, recover from closed loops, and rotate incomplete
  families without seed-specific behavior.
- Prevented sealed or inactive Floor 2 bosses from becoming movement or weapon
  targets until the den is unlocked and the encounter has started.
- Preserved direct Floor 2 weapon selection and improved melee boss pressure,
  retreat sensing, projectile dodging, and den-egress routing.
- Confirmed the apparent attribution mismatch was neutral enemy removal and
  director pruning, not missing player source ownership.
- Added 75% family / 25% neutral territory spawn composition with deterministic
  overlap normalization.
- Added durable progression evidence for family and neutral kills, hunt engagement,
  active combat, nearby density, den unlocks, boss start/defeat, exit completion,
  and minimum health.
- Changed every production Thin the Horde den objective from 100 to the
  user-approved 50 player-attributed non-boss family kills.
- Added stable family-color overlap bands to both the fullscreen minimap and docked
  radar, with discovery gating, boss-defeat grayscale invalidation, and a lab plus
  deterministic visual coverage.
- Kept production density at nearby target 5 after the target-12 experiment proved
  unsafe with the faster 50-kill progression.

## Production proof

Command:

`npm run ai:headless -- --seed 42 --weapon sword --floor floor2 --max-frames 100000 --max-time-ms 600000 --progress 3600`

The exact run reproduced twice with identical gameplay metrics:

- Victory at frame 47,923 / 798.7 seconds, leaving 401.3 seconds.
- Family trash kills: imps 50, myconids 51, kobolds 50, faeries 51.
- Imps den unlocked at 50; boss started at 214.7s and defeated at 215.3s.
- Myconids den unlocked at 50; boss started at 404.3s and defeated at 405.0s.
- Kobolds den unlocked at 50; boss started at 613.5s and defeated at 613.9s.
- Faeries den unlocked at 50; boss started at 778.1s and defeated at 778.3s.
- Every den was entered, every production boss encounter started and was defeated,
  and the exit completed.
- 9,838 damage dealt / 1,001 taken; minimum health 59.9%.
- Hunt kills: 199 family / 69 neutral; family mix 74.3%.
- Hunt active-combat occupancy 68.8%.
- Nearby enemies averaged 7.3 and peaked at 22.

Artifacts:

- `files/floor2-threshold50-density5-exact.log`
- `files/floor2-threshold50-density5-repeat-exact.log`
- `files/floor2-threshold50-density12-exact.log` records the rejected experiment.

## Files touched

- `src/game/ai/bt-ai-provider.ts`, `bt-ai-tuning.ts`, `event-log.ts`, `types.ts`
- `src/game/ai/headless-runner.ts`, `headless-runner-cli.ts`
- `src/game/floor2BossEligibility.ts`, `floor2Scenario.ts`, `spawn-zones.ts`
- `src/game/weaponSystem.ts`
- `src/shared/data/quests.floor2.dens.json`
- `src/engine/HudMinimap.ts`, `minimap-family-tint.ts`
- `src/labs/hud-family-relationships-lab/index.ts`
- Unit, behavior-tree, headless, integration, and deterministic E2E tests
- Review ledger and ADR for this change

## Verification

- Focused quest, attribution, spawn-zone, hunt, boss-eligibility, telemetry, and
  minimap tests passed.
- Deterministic minimap E2E passed in docked and fullscreen modes.
- `npm run verify:fast` passed 69 files / 803 tests.
- The exact production proof command passed twice with identical metrics.
- Separate-model code review and multi-model review with adjudication completed
  clean.

## Unresolved issues

- Hunt combat occupancy is 68.8%, slightly below the earlier 70-80% preference.
  The user authorized experimentation but required confirmation before shipping
  density changes. Target 12 caused a death at 283.2 seconds and is not included.
- A broad multi-seed balance sweep was not run; the approved hard gate was the
  exact deterministic seed-42 production victory.

## Recommended next steps

- Let CI enforce the full test and headless gates on the ready PR.
- If 70-80% combat occupancy remains a hard product requirement, run a separate
  approved pacing experiment across a broad GitHub-hosted seed sweep rather than
  increasing density on this progression branch.
