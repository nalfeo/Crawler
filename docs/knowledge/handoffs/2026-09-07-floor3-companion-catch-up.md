# Session Handoff: Floor 3 companion catch-up speed

## Date

2026-09-07

## Persona

Game AI Engineer

## Systems touched

ai-combat-balance, ai-pathfinding

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — localized companion movement-speed
override, tuning data, and deterministic real-pipeline regressions.

## Kickoff

Recommended: the issue has a bounded 180-frame catch-up gate and the existing
companion decision is already wired through `enemyAISystem` and
`movementSystem`, so the change can stay localized without introducing a new
system or lab.

## What Was Done

- Added Floor-3-only follow-speed tuning for player-owned Companions:
  baseline at least 1.25x current player speed (or authored companion speed),
  a monotonic 0.01 speed-per-foot ramp beyond the friendly leash, and a 2.5x
  cap.
- Applied the override only to `Companion` entities with both `TeamId.PLAYER`
  and `ownerTeam === TeamId.PLAYER` while their existing decision is `follow`.
  Rival targeting, in-leash behavior, Floor 4, and NPC-owned rosters retain
  their existing paths.
- Added real `enemyAISystem` -> `movementSystem` tests for distance ramp,
  cap, 180-frame leash return, and non-Floor-3/NPC isolation.

## Real-Pipeline Evidence

The deterministic companion regression exercised the production
`companionAISystem` -> `enemyAISystem` -> `movementSystem` path: a companion
starting 24 ft away returned to the 6 ft friendly leash within 180 frames.
The real `tests/headless/floor3-completion.test.ts` also passed after the
tuning change. The issue's remote run bundle was not downloaded, so no
before-run distance telemetry is claimed.

## Validation

- `tests/ecs/companion-ai-system.test.ts`: 14/14 passed.
- `tests/headless/floor3-completion.test.ts`: passed.
- `npm run typecheck`: passed.
- `bash scripts/agent/verify-fast.sh`: completed successfully.

## Blockers

None.
