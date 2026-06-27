# Copilot Instructions — Crawler

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show dungeon. It uses Phaser 4 for rendering and bitecs 0.4 for ECS game logic. This project is entirely agent-driven.

## Before Starting

1. Run `bash scripts/agent/preflight.sh`
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Check recent handoffs in `docs/knowledge/handoffs/`
4. **Declare your apple estimate** — read `docs/agent-os/policies/complexity-policy.md`, pick 🍎–🍎🍎🍎🍎🍎, and state it in your first turn before writing any code

## Validation

- After every change: `npm run verify:fast` (typecheck + lint + changed unit tests, ~30s)
- Before committing: `npm run verify` (full suite — typecheck, lint, format, unit/integration/headless tests, build). Coverage is **not** run locally by default (it ~5x's unit-test time and is enforced in CI); add `VERIFY_COVERAGE=1` or run `npm run verify:coverage` for a local coverage gate.
- Before creating PR: Ensure `scripts/agent/lab-gate-check.sh` passes
- During fixes/implementations, make a best effort to improve or preserve unit-test coverage in touched areas so changes move toward UT coverage goals.

## Critical Rules

- All game randomness uses `SeededRandom` — NEVER `Math.random()`
- ECS systems are deterministic and usually shaped as `(world: GameWorld) => void` (pipeline systems may accept/return deterministic data)
- No Phaser imports in `src/core/` — the bridge pattern keeps logic portable
- Every new ECS system MUST have a lab in `src/labs/`
- Write conventional commits. Allowed types (enforced by commitlint): `feat`, `fix`, `chore`, `docs`, `lab`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`
- Write a handoff file before ending your session
- If `files/guard-telemetry.jsonl` exists, paste `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` into the handoff
- **Apple complexity**: declare your 🍎–🍎🍎🍎🍎🍎 estimate before writing any code; score actuals + verdict at handoff; create an individual file in `docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json` — see `docs/agent-os/policies/complexity-policy.md`

## Merge Policy

- When authorized to merge a PR (via agent-merge automation or explicit instruction), always use `gh pr merge --auto --squash` to enable GitHub's auto-merge. This completes the merge automatically once all required checks pass — do not poll or wait manually.
- **No human review is required to merge.** There is no branch protection rule requiring an approving review. Never attribute a merge failure to a "human review block" without explicit proof.
- When `gh pr merge` fails, diagnose the actual cause before giving up:
  1. Run `gh pr checks <pr-number>` to see which checks are failing.
  2. Run `gh run list --branch <branch>` and `gh run view <run-id> --log-failed` to read the actual error output.
  3. Fix the underlying CI failure, then re-run `gh pr merge --auto --squash`.
- If `gh pr merge` explicitly states that reviews are required, stop and report this to the user — do not guess.

### Resolving addressed review comments

- Review-comment threads are auto-resolved by `.github/workflows/auto-resolve-review-threads.yml` — do **not** click "Resolve conversation", and no PAT is used (it runs as the GitHub App bot, never as a human).
- When you address a review comment (push a fix **or** explain in-thread why no change is needed), reply **in that thread** with the marker `✅ Addressed` (ideally `✅ Addressed in <sha>: <one-line note>`). The workflow resolves the thread on the next push/sweep; the code does **not** need to be outdated.
- Only replies from the PR owner/member/collaborator or a trusted bot (e.g. the Copilot coding agent) are honored.

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
