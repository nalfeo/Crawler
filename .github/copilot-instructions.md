# Copilot Instructions — Crawler

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show dungeon. It uses Phaser 4 for rendering and bitecs 0.4 for ECS game logic. This project is entirely agent-driven.

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
- ECS systems are deterministic and usually shaped as `(world: GameWorld) => void` (pipeline systems may accept/return deterministic data)
- No Phaser imports in `src/core/` — the bridge pattern keeps logic portable
- Every new ECS system MUST have a lab in `src/labs/`
- Write conventional commits. Allowed types (enforced by commitlint): `feat`, `fix`, `chore`, `docs`, `lab`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`
- Write a handoff file before ending your session

## Merge Policy

- When authorized to merge a PR (via agent-merge automation or explicit instruction), always use `gh pr merge --auto --squash` to enable GitHub's auto-merge. This completes the merge automatically once all required checks pass — do not poll or wait manually.
- **No human review is required to merge.** There is no branch protection rule requiring an approving review. Never attribute a merge failure to a "human review block" without explicit proof.
- When `gh pr merge` fails, diagnose the actual cause before giving up:
  1. Run `gh pr checks <pr-number>` to see which checks are failing.
  2. Run `gh run list --branch <branch>` and `gh run view <run-id> --log-failed` to read the actual error output.
  3. Fix the underlying CI failure, then re-run `gh pr merge --auto --squash`.
- If `gh pr merge` explicitly states that reviews are required, stop and report this to the user — do not guess.

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
