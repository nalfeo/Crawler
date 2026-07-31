# Copilot Instructions — Crawler

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show dungeon. It uses Phaser 4 for rendering and bitecs 0.4 for ECS game logic. This project is entirely agent-driven.

## Request Intake

The sole maintainer works best answering questions one at a time rather than writing a full spec upfront. Do NOT wait for a complete brief — actively drive the framing:

1. **Interview, don't wait.** Ask the single most decisive question, let the maintainer answer, then ask the next. Never dump a wall of questions at once.
2. **Converge on a bounded, single-metric ask.** Continue until the request has one hard, measurable success gate (a number or checkable condition) plus a ranked list of soft tiebreakers. Open-ended "make it good/better/faster" directives are not ready to start.
3. **Reflect it back before coding.** Restate the ask in bounded form and get an explicit yes/no before writing code.
4. **Push back on drift.** If an ask has no measurable done-state, say so and ask the narrowing question instead of guessing or silently scoping it yourself.
5. **Say whether it's a good idea.** Be vocal about whether the ask is sound, and output plans directly in the session chat.

## Before Starting

1. Run `bash scripts/agent/preflight.sh`
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Before planning work in a system, read the relevant section of `docs/knowledge/handoffs/INDEX.md` and skim the top 3-5 listed handoffs for that system. Fall back to a broader scan of `docs/knowledge/handoffs/` only if the index has no coverage for your target system. New handoffs must declare `## Systems touched` (comma-separated slugs from `docs/systems/README.md`) — required once the handoff-tooling lint wires it in, advisory until then.
4. **Declare your apple estimate** — read `docs/agent-os/policies/complexity-policy.md`, pick 🍎–🍎🍎🍎🍎🍎, and state it in your first turn before writing any code

- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.
- **Plans stay in session chat:** When giving a plan, write the full plan in session chat. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.
- **Synchronize during authoring:** Preflight runs `npm run sync:main -- --reason session-start`. The `authoring-main-sync` guard measures bounded intervals between active agent tool calls and attempts another local rebase after 30 active minutes. If work is dirty, checkpoint it and run `npm run sync:main -- --reason periodic`; the reminder is non-blocking and remains due until synchronization succeeds. Run `npm run sync:main -- --reason pre-publish` before final validation and PR publication. If it changes HEAD, rerun affected validation. Synchronization never pushes, and missing/stale evidence alone never blocks publication.
- **Published PRs detach by default:** Unless the human explicitly states before PR publication that the session should remain local, an implementation session must publish a ready-for-review PR, leave complete handoff context, then end/release its ownership immediately. Do **not** wait locally for CI, reviews, or cloud confirmation; CI Recovery assigns cloud Copilot for blockers, with the 10-minute scheduled sweep as the takeover backstop.
- **Broad sweeps default to GitHub:** For sweeps or batch evals with **more than 10 runs**, default to GitHub-backed `workflow_dispatch`/CI execution (for example `.github/workflows/weapon-sweep.yml` or `.github/workflows/ai-sweep.yml`) instead of local/session compute unless a human explicitly asks for local.
- **Investigation sessions are process-light:** Investigation/repro/debug sessions with no merge-intent fix may stay lightweight (no review ledger/full PR paperwork). If a fix should land, spin a separate implementation child session/PR and run the normal full process there.
- **Tooling-only ceremony is capped at 3🍎:** Work confined to developer/agent tooling, canvases, automation, or asset-pipeline tooling is estimated at no more than 3🍎 regardless of file count; the cap does not apply when runtime gameplay behavior or shipped game data changes.

## Validation

- After every change: `npm run verify:fast` (typecheck + lint + changed unit tests, ~30s)
- Before running heavy discretionary checks (headless `VERIFY_FULL=1`, weapon sweeps, visual review), run `npm run scope` and only run them when its flags say they can be affected (`gameplay_safe=false`, UI surface changed, etc.). For broad sweeps (>10 runs), default to GitHub workflow dispatch (`weapon-sweep.yml` / `ai-sweep.yml`) instead of local compute unless a human explicitly requests local execution. CI still enforces the real gates, so scoping locally never weakens a required check. See the "Scoping heavy validation" table in `AGENTS.md`.
- When execution is complete (before asking for PR creation): `npm run verify:pr-prereqs` so review-harness and preflight blockers are surfaced immediately instead of at `create_pull_request`.
- Do **not** run full `npm run verify` merely because you are committing or opening a PR. CI owns the full suite; run it locally only when a human explicitly requests it or targeted diagnosis requires it. The ~306s headless Floor-1 and coverage gates remain CI-owned by default.
- Before creating PR: Ensure `scripts/agent/lab-gate-check.sh` passes
- Before creating PR: Run the **review harness** for the change's apple tier and record a valid **review ledger** (`npm run review:ledger -- validate`) — the `pr-review-ledger` guard hard-denies `create_pull_request` otherwise. See `.github/skills/review-harness/SKILL.md`.
- During fixes/implementations, make a best effort to improve or preserve unit-test coverage in touched areas so changes move toward UT coverage goals.

## Pull Request Reviews

For every pull request or diff review, follow the canonical exhaustive-review contract in
`.github/instructions/review.instructions.md`. Adopt its Reviewer persona, complete every
review category before responding, deduplicate by root cause, and return all validated
findings in one pass. Before commenting, read the complete prior review history; never
reopen or repost a finding that has a prior `✅ Addressed in <sha>` or
`✅ Not applicable:` response unless a later thread reply provides concrete evidence
that the resolution failed.

## Critical Rules

- **`claude-sonnet-4.5` is deprecated — do NOT use it.** All `task()` calls that
  specify `model="claude-sonnet-4.5"` will fail at `session.create`. Use
  `claude-sonnet-4.6` or `claude-sonnet-5` for code review and general tasks.
  <!-- Source issue: #2209 — deprecated 2026-05-06 -->
- All game randomness uses `SeededRandom` — NEVER `Math.random()`
- ECS systems are deterministic and usually shaped as `(world: GameWorld) => void` (pipeline systems may accept/return deterministic data)
- No Phaser imports in `src/core/` — the bridge pattern keeps logic portable
- Every new ECS system MUST have a lab in `src/labs/`
- **Every `*System` exported from `src/core/**`/`src/game/**` MUST be wired into a sim-side/shared runtime pipeline** (`src/bootstrap/floor-main-scene-options.ts`, `src/core/simulation-core-step.ts`, `src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`) or added to the documented allowlist in `scripts/agent/health/orphaned-systems-lib.ts`. A `MainGameScene.ts`-only, lab, or test reference does NOT satisfy the guard. Enforced by `npm run check:wired-systems` (ADR 0039).
- Write a handoff file before ending implementation sessions (merge-intent changes). **Do NOT run `npm run docs:index` to rebuild `docs/knowledge/handoffs/INDEX.md`** — CI rebuilds it automatically after each merge that adds a handoff. Concurrent agent sessions both rebuilding INDEX.md is a primary source of merge conflicts.
- If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>` to commit a per-session guard-telemetry summary under `docs/knowledge/metrics/guard-telemetry/` (durable, contamination-filtered). The trimmed handoff template no longer carries a telemetry block — the committed summary file is the record.
- **Apple complexity**: declare your 🍎–🍎🍎🍎🍎🍎 estimate before writing any code. For **≥3🍎 sessions**, run `npm run apples:record -- --session <slug> --estimated <n> --actual <n>` at handoff — the script writes the JSON and computes all derived fields. **1–2🍎 sessions do not need a file.** See `docs/agent-os/policies/complexity-policy.md`
- **Apple-scaled review harness**: scale review to the apple estimate and record a **review ledger** before PR. **≥3🍎** → separate-model **plan review** **and** a **code-review loop until no concerns _or_ a 2-round cap then human escalation**; >3🍎 → the plan review must be **adversarial** (one reviewer enumerates ≥2 alternatives and argues against the chosen design) **and** **multi-model review** with adjudication (same 2-round-cap/escalation rule). Every plan review (≥3🍎) records a `plan_divergence` signal. 1–2🍎 require no review stages (plan-review floor raised 2🍎→3🍎 on 2026-07-07; dual-plan synthesis retired at 4–5🍎 on 2026-07-08, ADR 0051). Enforced by the `pr-review-ledger` guard (docs/art/deps-only diffs exempt). Use the `review-harness` skill; never weaken a stage to go green — escalate to a human instead. Canonical: `docs/agent-os/policies/review-harness-policy.md`.
- **PR title/description synthesis**: When creating or updating a PR title/description — including after any feedback turns — always synthesize the _entire_ session's work. Read the existing PR title/description first (via `gh pr view`), then write a holistic title and description that covers every change on the branch, not just the most recent task. Never replace the primary purpose of the PR with a secondary or follow-up concern. The title must reflect the dominant feature/fix; secondary changes belong as bullet points in the description.
- **Never weaken explicit human requirements without asking**: Do not cut corners by quietly relaxing, disabling, or disregarding an explicit, user-stated requirement — including the feature's own defining parameter — to make a gate/test pass. This applies in every mode, **including autopilot**. If green seems to require weakening the requirement, STOP and ask first; fix the test/gate around the requirement, not the requirement around the test.
- **Never bend gameplay to pass seeds; gate on win-RATE**: Do not tune game balance to rescue specific pre-existing seed runs, and do not add shortcuts/cheats that hold map structure fixed to avoid recomputing success/failure rates. Target: **90%+ of Floor 1 seeds should easily win**. Materially less ⇒ likely AI-runner bug or extreme regression — fix the root cause, never cherry-pick comfortable seeds to green the gate.
- **Broad sweeps (>10 runs) use GitHub infrastructure by default**: Prefer GitHub Actions `workflow_dispatch`/CI runners over local or session compute for broad sweeps so sampling is parallelized and local resources stay available. Keep local sweeps for small smoke checks or explicit human override.
- **Split investigation from landing implementation**: Investigation/repro/debug sessions can be scrappy and low-overhead when they are not landing code. Once an investigation identifies a fix to ship, open a separate implementation child session/PR that follows the full normal process (apple accounting, verify gates, review harness/ledger, and handoff).

## Merge Policy

- **Always create PRs as ready for review — never as draft.** When using the `create_pull_request` tool, always pass `draft: false` or omit the draft parameter entirely. The CI pipeline and review + fix automation are only triggered on non-draft PRs, so draft PRs stall the whole pipeline.
- When authorized to merge a PR (via agent-merge automation or explicit instruction), always use `gh pr merge --auto --squash` to enable GitHub's auto-merge. This completes the merge automatically once all required checks pass. Do not run open-ended manual polling/wait loops after arming, but do perform a bounded final-state verification (`state=MERGED` and non-null `mergeCommit`) and clear unresolved review threads before idling.
- **No human review is required to merge.** There is no branch protection rule requiring an approving review. Never attribute a merge failure to a "human review block" without explicit proof.
- When `gh pr merge` fails, diagnose the actual cause before giving up:
  1. Run `gh pr checks <pr-number>` to see which checks are failing.
  2. Run `gh run list --branch <branch>` and `gh run view <run-id> --log-failed` to read the actual error output.
  3. Fix the underlying CI failure, then re-run `gh pr merge --auto --squash`.
- If `gh pr merge` explicitly states that reviews are required, stop and report this to the user — do not guess.

### Resolving addressed review comments

- Review-comment threads are reconciled by `.github/workflows/ci-recovery.yml` using the owner-scoped `CRAWLER_CI_PAT`, including cross-App Copilot reviewer threads.
- When you address a review comment by pushing a fix, reply **in that thread** with `✅ Addressed in <sha>: <one-line note>`. When a finding is deterministically non-applicable (the code does not need changing — e.g. the line no longer exists, or the concern was already addressed elsewhere), reply with `✅ Not applicable: <one-line reason>` — do NOT use this for substantive disagreements. The reconciler resolves the thread on the next event or 10-minute sweep.
- Only replies from the PR owner/member/collaborator or a trusted bot (e.g. the Copilot coding agent) are honored.
- A different-model validator must check every listed review thread. Substantive disagreement stays unresolved and escalates; only marker-confirmed fixes or deterministic non-applicability may auto-resolve.

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
