# Handoff — AI runner UX parity

**Date:** 2026-06-25
**Persona:** Producer (cross-surface UX/bootstrap wiring)
**Apples:** estimated 🍎🍎 / actual 🍎🍎 (exact)

## Systems touched

ai-combat-balance

## Task

Enable the new base-game zoom/polish path in the visual AI runner lab and keep
that lab inheriting future base-game UX features instead of re-copying Phaser
host config by hand.

## Change

- `src/bootstrap/floor1-game-config.ts`
  - Added a shared `createFloor1GameConfig(parent, sceneOptions)` helper that
    owns the base Floor 1 Phaser host config (AUTO renderer, shared dimensions,
    pixel-art flags, arcade stub physics, BootScene + MainGameScene, FIT scale).
- `src/main.ts`
  - Switched the shipped game bootstrap to `createFloor1GameConfig(...)`.
- `src/labs/ai-runner-lab/index.ts`
  - Switched the visual AI runner to the same shared game-config helper so it
    inherits the base game's camera/UX/rendering bootstrap path.
- `tests/game/floor1-game-config.test.ts`
  - Added regression coverage that the shared helper owns the canonical base-game
    host settings and that `main.ts` boots through it.
- `tests/unit/ai-level-up-ux-wiring.test.ts`
  - Extended the AI runner wiring guard so the lab must keep using the shared
    game-config helper.

## Why this approach

The safe-room zoom itself already lives in `MainGameScene`, but the AI runner
was still hand-assembling its own Phaser game host. Centralizing the host config
removes that drift point so the visual AI surface stays on the same UX/rendering
path as the shipped game whenever bootstrap-level polish is added.

## Validation

- `npx vitest run tests/game/floor1-game-config.test.ts tests/unit/ai-level-up-ux-wiring.test.ts`
- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`
- `runtime-tools-secret_scanning` on touched code/test files

## Follow-ups / notes

- `files/guard-telemetry.jsonl` was not present in this session, so no guard
  telemetry section was added.
