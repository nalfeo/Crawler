# Session Handoff: Weapon passive carryover VFX replay fix

## Date

2026-07-31

## Persona

Game Designer

## Systems touched

weapons, vfx, inventory

## Apples

2🍎 estimated, 2🍎 actual.

## What Was Done

- Added a restore-only suppression path for weapon passive activation flash emission by extending `synchronizeAbilityPassives(...)` with an optional `{ suppressActivationVfx }` flag and plumbing it into `applyPassive(...)`.
- Updated `restorePlayerCarryover(...)` to call `synchronizeAbilityPassives(world, playerEid, { suppressActivationVfx: true })` so carryover rehydration can recreate passive modifiers without replaying unlock/equip flash feedback.
- Added regression coverage in `tests/unit/player-carryover.test.ts` asserting weapon-gated passive activation VFX is not re-emitted across a floor carryover when loadout is unchanged.
- Strengthened existing weapon swap regression in `tests/game/weapon-skill-abilities.test.ts` to assert real swap-in transitions still emit activation flash events.

## Validation

- `runtime-tools-secret_scanning` on changed files: clean.
- `parallel_validation`: Code Review clean; CodeQL reported no alerts (analysis skipped due DB size).
- Local test/verify commands were attempted but blocked in this environment due dependency installation/network policy failures (`npm ci` cannot resolve upstream feed; `vitest` unavailable).

## Blockers / Follow-ups

- Issue-plan comment posting to `nalfeo/Crawler#2477` was attempted but blocked by GitHub API write restrictions (`HTTP 403` via `gh issue comment` and `gh api`).
- Once environment/package feed access is available, rerun:
  - `npm test -- tests/unit/player-carryover.test.ts tests/game/weapon-skill-abilities.test.ts`
  - `npm run verify:fast`
