# Copilot Instructions — Crawler

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show dungeon. It uses Phaser 3 for rendering and bitecs 0.4 for ECS game logic. This project is entirely agent-driven.

## Before Starting

1. Run `bash scripts/agent/preflight.sh`
2. Read your assigned persona in `docs/agent-os/personas/`
3. Check recent handoffs in `docs/knowledge/handoffs/`

## Validation

- After every change: `npm run verify:fast` (typecheck + lint + tests, ~30s)
- Before committing: `npm run verify` (full suite, ~3min)
- Before creating PR: Ensure `scripts/agent/lab-gate-check.sh` passes

## Critical Rules

- All game randomness uses `SeededRandom` — NEVER `Math.random()`
- ECS systems are pure functions: `(world: GameWorld) => void`
- No Phaser imports in `src/core/` — the bridge pattern keeps logic portable
- Every new ECS system MUST have a lab in `src/labs/`
- Write conventional commits: `feat:`, `fix:`, `chore:`, `lab:`, `docs:`
- Write a handoff file before ending your session

## Test Strategy

- Unit tests for all pure functions (damage calc, loot tables, XP curves)
- Use `createTestWorld()` from `tests/helpers/world-factory.ts` — never construct worlds manually
- Property-based tests with fast-check for game invariants
- Integration tests for multi-system pipelines

## Architecture Layers

```
src/core/    → Pure ECS (no rendering imports)
src/engine/  → Phaser bridge (rendering only)
src/game/    → Game systems (crafting, loot, floors, AI)
src/labs/    → Dev sandboxes (unrestricted imports)
src/shared/  → Constants, types, utilities
```
