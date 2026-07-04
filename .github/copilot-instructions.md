# Copilot Instructions — Crawler

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show dungeon. It uses Phaser 4 for rendering and bitecs 0.4 for ECS game logic. This project is entirely agent-driven.

## Before Starting

1. Run `bash scripts/agent/preflight.sh`
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Before planning work in a system, read the relevant section of `docs/knowledge/handoffs/INDEX.md` and skim the top 3-5 listed handoffs for that system. Fall back to a broader scan of `docs/knowledge/handoffs/` only if the index has no coverage for your target system. New handoffs must declare `## Systems touched` (comma-separated slugs from `docs/systems/README.md`) — required once the handoff-tooling lint wires it in, advisory until then.
4. **Declare your apple estimate** — read `docs/agent-os/policies/complexity-policy.md`, pick 🍎–🍎🍎🍎🍎🍎, and state it in your first turn before writing any code

## Validation

- After every change: `npm run verify:fast` (typecheck + lint + changed unit tests, ~30s)
- Before committing: `npm run verify` (typecheck, lint, format, guards, unit + integration tests, **early PR prerequisites**, build). The ~306s headless Floor-1 gate is **deferred to its required CI job** by default — run it locally with `VERIFY_FULL=1 npm run verify` (do this when touching `src/core`, `src/game/ai`, or balance). Coverage is **not** run locally by default (it ~5x's unit-test time and is enforced in CI); add `VERIFY_COVERAGE=1` or run `npm run verify:coverage` for a local coverage gate.
- When execution is complete (before asking for PR creation): `npm run verify:pr-prereqs` so review-harness and preflight blockers are surfaced immediately instead of at `create_pull_request`.
- Before creating PR: Ensure `scripts/agent/lab-gate-check.sh` passes
- Before creating PR: Run the **review harness** for the change's apple tier and record a valid **review ledger** (`npm run review:ledger -- validate`) — the `pr-review-ledger` guard hard-denies `create_pull_request` otherwise. See `.github/skills/review-harness/SKILL.md`.
- During fixes/implementations, make a best effort to improve or preserve unit-test coverage in touched areas so changes move toward UT coverage goals.

## Critical Rules

- All game randomness uses `SeededRandom` — NEVER `Math.random()`
- ECS systems are deterministic and usually shaped as `(world: GameWorld) => void` (pipeline systems may accept/return deterministic data)
- No Phaser imports in `src/core/` — the bridge pattern keeps logic portable
- Every new ECS system MUST have a lab in `src/labs/`
- **Every `*System` exported from `src/core/**`/`src/game/**` MUST be wired into a real runtime pipeline** (`src/bootstrap/floor-main-scene-options.ts`, `src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`, `src/engine/scenes/MainGameScene.ts`) or added to the documented allowlist in `scripts/agent/health/orphaned-systems-lib.ts`. A green lab does NOT prove the real game calls the system — lab-only validation is insufficient for wiring/behavior changes; "observe before done" must name the real game or headless artifact. Enforced by `npm run check:wired-systems` (ADR 0039).
- Write conventional commits. Allowed types (enforced by commitlint): `feat`, `fix`, `chore`, `docs`, `lab`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`
- Write a handoff file before ending your session
- If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>` to commit a per-session guard-telemetry summary under `docs/knowledge/metrics/guard-telemetry/` (durable, contamination-filtered). The trimmed handoff template no longer carries a telemetry block — the committed summary file is the record.
- **Apple complexity**: declare your 🍎–🍎🍎🍎🍎🍎 estimate before writing any code; score actuals + verdict at handoff; create an individual file in `docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json` — see `docs/agent-os/policies/complexity-policy.md`
- **Apple-scaled review harness**: scale review to the apple estimate and record a **review ledger** before PR. >1🍎 → separate-model **plan review**; >3🍎 → **dual-plan synthesis** (2 models + judge) **and** **multi-model review** with adjudication; **≥3🍎** → a **code-review loop until no concerns**. Enforced by the `pr-review-ledger` guard (docs/art/deps-only diffs exempt). Use the `review-harness` skill; never weaken a stage to go green. Canonical: `docs/agent-os/policies/review-harness-policy.md`.
- **PR title/description synthesis**: When creating or updating a PR title/description — including after any feedback turns — always synthesize the _entire_ session's work. Read the existing PR title/description first (via `gh pr view`), then write a holistic title and description that covers every change on the branch, not just the most recent task. Never replace the primary purpose of the PR with a secondary or follow-up concern. The title must reflect the dominant feature/fix; secondary changes belong as bullet points in the description.
- **Never weaken explicit human requirements without asking**: Do not cut corners by quietly relaxing, disabling, or disregarding an explicit, user-stated requirement — including the feature's own defining parameter — to make a gate/test pass. This applies in every mode, **including autopilot**. If green seems to require weakening the requirement, STOP and ask first; fix the test/gate around the requirement, not the requirement around the test.
- **Never bend gameplay to pass seeds; gate on win-RATE**: Do not tune game balance to rescue specific pre-existing seed runs, and do not add shortcuts/cheats that hold map structure fixed to avoid recomputing success/failure rates. Target: **90%+ of Floor 1 seeds should easily win**. Materially less ⇒ likely AI-runner bug or extreme regression — fix the root cause, never cherry-pick comfortable seeds to green the gate.

## Merge Policy

- When authorized to merge a PR (via agent-merge automation or explicit instruction), always use `gh pr merge --auto --squash` to enable GitHub's auto-merge. This completes the merge automatically once all required checks pass. Do not run open-ended manual polling/wait loops after arming, but do perform a bounded final-state verification (`state=MERGED` and non-null `mergeCommit`) and clear unresolved review threads before idling.
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
- **Copilot code-review threads need an owner resolve.** Threads authored by the `copilot-pull-request-reviewer` app come back with `viewerCanResolve: false` for the auto-resolve workflow's App token (a GitHub App can't resolve another App's thread), so the bot **skips** them even after you reply with the marker. After replying `✅ Addressed in <sha>`, resolve such a thread yourself as the PR owner via GraphQL `resolveReviewThread` rather than waiting on the bot — otherwise an already-armed `--auto` merge stays **BLOCKED** on the conversation-resolution gate.

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
