# AGENTS.md — Crawler Project

## Quick Start

1. Run `bash scripts/agent/preflight.sh` at session start
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Check `docs/knowledge/handoffs/` for recent session context
4. Load durable facts: call the memory MCP `read_graph` (or `search_nodes`) and skim `docs/knowledge/memory/` — see `docs/guides/agent-memory.md`
5. Run `bash scripts/agent/verify-fast.sh` after every meaningful change
6. Run `bash scripts/agent/verify.sh` before committing (includes `verify:pr-prereqs`, so review-harness + other PR prerequisites fail early instead of waiting for `create_pull_request`)
7. Write a handoff file before ending your session
8. If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>` to write a committed per-session summary under `docs/knowledge/metrics/guard-telemetry/` (the durable, contamination-filtered collection path). The trimmed handoff template no longer carries a telemetry block — the committed summary file is the record.

## Commands

| Task                    | Command                            |
| ----------------------- | ---------------------------------- |
| Typecheck               | `npm run typecheck`                |
| Lint                    | `npm run lint`                     |
| Lint (fix)              | `npm run lint:fix`                 |
| Format                  | `npm run format`                   |
| Format (check)          | `npm run format:check`             |
| Unit tests              | `npm run test:unit`                |
| All tests (4 projects)  | `npm test`                         |
| Unit tests (watch)      | `npm run test:watch`               |
| Integration tests       | `npm run test:integration`         |
| E2E tests               | `npm run test:e2e`                 |
| Coverage (unit)         | `npm run verify:coverage`          |
| Dev server              | `npm run dev`                      |
| Lab mode                | `npm run lab`                      |
| DevTools mode           | `npm run devtools`                 |
| Build                   | `npm run build`                    |
| Dead code               | `npm run lint:dead-code`           |
| Sprite extract palette  | `npm run sprites:extract-palette`  |
| Sprite run              | `npm run sprites:run`              |
| Sprite gallery          | `npm run sprites:gallery`          |
| Sprite approve          | `npm run sprites:approve`          |
| Sprite synth            | `npm run sprites:synth`            |
| Sprite batch            | `npm run sprites:batch`            |
| Sprite asset plan       | `npm run sprites:asset-plan`       |
| Sprite plan drafts      | `npm run sprites:plan-drafts`      |
| Sprite worker           | `npm run sprites:worker`           |
| Sprite ingest once      | `npm run sprites:ingest-once`      |
| Sprite sync catalog     | `npm run sprites:sync-catalog`     |
| Sprite metadata         | `npm run sprites:metadata`         |
| Fast verify             | `npm run verify:fast`              |
| Full verify             | `npm run verify`                   |
| Full verify + headless  | `VERIFY_FULL=1 npm run verify`     |
| PR prereq check         | `npm run verify:pr-prereqs`        |
| Guard telemetry capture | `npm run telemetry:capture`        |
| Full verify + coverage  | `VERIFY_COVERAGE=1 npm run verify` |
| Guard + ledger tests    | `npm run test:guards`              |
| Review ledger           | `npm run review:ledger`            |
| Docs loop (local)       | `npm run docs:check`               |
| Security loop           | `npm run security:check`           |
| Health loop             | `npm run health:check`             |

For sprite workflow details and when to use sprite commands, see
`scripts/sprites/` for implementation details or `docs/knowledge/game-design/art-style-guide.md` for art context.

## Server Launch Diagnostics

When diagnosing Crawler dev/lab/devtools launch failures, inspect these session artifacts before retrying commands:

1. `files/worktree-server-launch.log` — append-only JSONL launch/discovery events and errors.
2. `files/worktree-server-status.json` — latest structured discovery snapshot used by the Worktree Server canvas.

## Session Server Lifecycle Policy

When working in a Copilot worktree session, keep **at most one active dev/lab/devtools server per session** unless there is an explicit reason to run more.

1. **Reuse first (hot reload path):** if the session already has a healthy server that serves the route you need, reuse it instead of launching another.
2. **Replace cleanly when needed:** if you must relaunch (hung process, wrong mode, wrong flags), stop the existing server process tied to the same session/workspace first, then start the new one.
3. **Always print the URL on launch:** every successful launch command must output the URL that should be opened (base URL, or specific route URL if relevant).

### Azure-required sidecar policy

When launching sprite sidecar workflows (`sprites:gallery` or `scripts/sprites/sidecar/cli.ts`), treat Azure connectivity as required by default.

1. On a fresh worktree just run `npm run sprites:gallery` — the launcher auto-bootstraps `.env.local` via the fast, env-only path (`pwsh scripts/setup-azure-env.ps1 -IncludeStorage`, ~18s) when the required Azure credentials are missing, and skips instantly when they are already present.
2. For a routine credential refresh, use `npm run setup:azure:env` (fast, env-only — fetches endpoint/keys, writes `.env.local`; no resource provisioning). Use `npm run setup:azure:env:force` to regenerate an existing/partial `.env.local`. Reserve `npm run setup:azure` (full `-ProvisionResources`, ~228s) for first-time or changed Azure resources.
3. Launch sidecar with default backend selection only (Azure: `azure-blob` + `azure-queue`).
4. Do **not** switch to local/noop backends unless a human explicitly asks for local/offline mode (opt in with `SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop`).
5. If Azure credentials are missing or invalid, report the blocker and stop instead of silently falling back — the launcher fails fast with an actionable message and never auto-overwrites an existing `.env.local`.

## Architecture

- **ECS (bitecs 0.4)**: Game logic in `src/core/` — pure functions, no rendering
- **Phaser 4**: Rendering only in `src/engine/` — replaceable layer
- **Labs**: Sandboxes in `src/labs/` — every system needs a lab before shipping
- **AI**: `src/game/ai/` is reserved for Ollama integration — when implemented, floor-load only

## Layer Rules (enforced by ESLint)

- `src/core/` → must not import from `src/engine/`, `src/game/`, or `src/labs/`
- `src/engine/` → must not import from `src/game/` or `src/labs/`
- `src/game/` → must not import from `src/engine/` or `src/labs/`
- `src/labs/` → unrestricted

## Key Files

| What                      | Where                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Docs hub & governance map | `docs/README.md`                                                                             |
| Architecture overview     | `docs/architecture.md`                                                                       |
| Agent personas            | `docs/agent-os/personas/*.md`                                                                |
| Policies                  | `docs/agent-os/policies/*.md`                                                                |
| Architecture decisions    | `docs/knowledge/adr/*.md`                                                                    |
| Specs                     | `.specify/specs/*.md`                                                                        |
| Game design               | `docs/knowledge/game-design/*.md`                                                            |
| Session handoffs          | `docs/knowledge/handoffs/*.md`                                                               |
| Agent memory              | `docs/guides/agent-memory.md`, `docs/knowledge/memory/`, `docs/knowledge/agent-memory.jsonl` |
| Guides                    | `docs/guides/*.md`                                                                           |
| CI config                 | `.github/workflows/`                                                                         |
| Automation loop scripts   | `scripts/agent/`                                                                             |
| Health metrics            | `docs/knowledge/metrics/`                                                                    |
| SpecKit constitution      | `.specify/memory/constitution.md`                                                            |

## Rules

1. **Lab-gated development**: No system ships without a lab. CI enforces this.
2. **Deterministic CI only**: No LLM-as-judge in CI. All gates are scripts with exit codes.
3. **Never use Math.random()**: Use `SeededRandom` from `src/shared/random.ts`
4. **Never use Date.now()**: Pass delta/frameCount as parameters
5. **Conventional commits**: full type set enforced by commitlint — `feat:`, `fix:`, `chore:`, `docs:`, `lab:`, `refactor:`, `test:`, `perf:`, `ci:`, `build:`, `revert:`
6. **Handoff required**: Write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending session
7. **ADR required**: Any decision affecting 2+ systems needs an ADR
8. **Always fix test and infra failures**: Never skip, ignore, or document broken tests/lint/build issues as "preexisting" or "unrelated" and move on. Fix every failure you encounter, regardless of whether you caused it. There is no such thing as a pre-existing issue that is out of scope — cruft compounds and wastes future agent time.
9. **Best-effort UT coverage progress**: As part of every fix/implementation, make a best effort to improve or preserve unit-test coverage in touched areas so work moves toward UT coverage goals.
10. **Observe before done (visual/runtime)**: For any visual or runtime bug/feature, reading the diff or source is NOT verification. Before claiming done you MUST (a) reproduce the old/broken behavior in the running artifact — a lab via `npm run lab` (`?lab=<name>`) or the game via `npm run dev` — and capture it (screenshot, a `tests/e2e/helpers/ui-probe.ts` probe, or headless `RunStats`), then (b) re-observe after the fix to confirm the behavior changed. State the before/after in the PR/handoff. For UX-facing changes, make this visual validation **headless and deterministic by default** so checks are reproducible and do not rely on an interactive manual run. Prefer promoting a recurring visual-bug class into a **deterministic** check (`tests/e2e/helpers/pixels.ts` / `ui-probe.ts`, see `tests/e2e/hud-overlap-visual.test.ts`; or a headless assertion, see `tests/headless/floor1-completion.test.ts`) — deterministic only, never an LLM-as-judge.
    - **Lab-only validation is INSUFFICIENT for wiring/behavior changes, and you MUST name the real artifact.** A lab (`src/labs/**`) force-calls the system under test, so a green lab proves the system works in isolation — it can NEVER prove the real game or headless runner actually calls it. For any change that adds/moves a system or alters runtime behavior, your "observe before done" note MUST name the **real pipeline artifact** you observed it in — the game (`npm run dev`) or a headless pipeline / win-rate gate (`src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`) — not a lab. If you validated only in a lab, the change is NOT done. This is enforced deterministically by the orphaned-system wiring guard (`npm run check:wired-systems`, ADR 0039); see rule #15. This rule exists because `spawnerSystem` shipped fully inert — lab-proven, ADR'd, merged — yet never referenced by either real pipeline (ADR 0034 → ADR 0036 fix in PR #665).
11. **PR title/description synthesis**: When creating or updating a PR title/description — including after any feedback turns — always synthesize the _entire_ session's work. Read the existing PR title/description first (via `gh pr view`), then write a holistic title and description that covers every change on the branch, not just the most recent task. Never replace the primary purpose of the PR with a secondary or follow-up concern. The title must reflect the dominant feature/fix; secondary changes belong as bullet points in the description.
12. **Never weaken explicit human requirements without asking**: Do NOT cut corners by quietly relaxing, disabling, or disregarding an explicit, user-stated requirement for a session — including the feature's own defining parameter — just to make a gate/test pass. This holds in every mode, **including autopilot**. If the only way you can see to get green is to weaken the requirement, STOP and ask the human first (state the trade-off and options); fix the test/gate around the requirement, not the requirement around the test.
13. **Never bend gameplay to pass seeds; gate on win-RATE, not cherry-picked seeds**: Do not tune game balance to rescue specific pre-existing seed runs, and do not add shortcuts/cheats that hold map structure fixed just to avoid recomputing success/failure rates. **Target: 90%+ of Floor 1 seeds should easily reach a win condition.** If a broad seed sweep shows materially less, treat it as a likely **AI-runner bug or extreme gameplay regression** and fix the root cause — never hand-pick a handful of comfortable seeds to make the gate green.
14. **Apple-scaled review harness before PR**: Every code-touching change runs the review harness scaled to its apple estimate and records it in a **review ledger** (`docs/knowledge/review-ledgers/<date>-<slug>.review-ledger.json`). >1🍎 → separate-model **plan review**; >3🍎 → **dual-plan synthesis** (2 models + judge) **and** **multi-model review** with adjudication; **≥3🍎** → a **code-review loop until no concerns**. The `pr-review-ledger` guard hard-denies `create_pull_request` without a valid ledger for the tier (docs/art/deps-only diffs are exempt). Author it with the [`review-harness` skill](.github/skills/review-harness/SKILL.md); never weaken a stage to go green (see rule #12). Canonical: [`docs/agent-os/policies/review-harness-policy.md`](docs/agent-os/policies/review-harness-policy.md).
15. **Every game system must be wired or explicitly allowlisted**: Any `*System` exported from `src/core/**` or `src/game/**` MUST be referenced by a real runtime wiring site (`src/bootstrap/floor-main-scene-options.ts`, `src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`, `src/engine/scenes/MainGameScene.ts`) or added to the documented allowlist in `scripts/agent/health/orphaned-systems-lib.ts` with a reason. Lab/test references do NOT count. Enforced by `npm run check:wired-systems` (ADR 0039), run in `verify` and the `check-format-and-labs` CI job. Never allowlist a system just to go green (see rule #12) — allowlisting is only for systems intentionally not-yet-wired, and the reason must say so.

> Several of these rules are now **hard-enforced** at the tool-call boundary by
> the `copilot-guards` extension. See
> [`.github/extensions/copilot-guards/README.md`](.github/extensions/copilot-guards/README.md)
> for the full list, bypass mechanism, and rationale for items that are NOT
> enforced.

## Merge Policy

- When authorized to merge a PR, always use `gh pr merge --auto --squash`. This enables GitHub's auto-merge and completes once all required checks pass. Do not run open-ended manual polling/wait loops after arming, but do perform a bounded final-state verification (`state=MERGED` and non-null `mergeCommit`) and clear unresolved review threads before idling.
- **No human review is required to merge.** Branch protection does NOT require an approving review. Never attribute a merge failure to a "human review block" without explicit proof from `gh pr merge` output.
- When `gh pr merge` fails, diagnose the actual cause before giving up:
  1. Run `gh pr checks <pr-number>` to see which checks are failing.
  2. Run `gh run list --branch <branch>` then `gh run view <run-id> --log-failed` to read actual error output.
  3. Fix the underlying CI failure, then re-run `gh pr merge --auto --squash`.
- Only stop and report to the user if `gh pr merge` itself explicitly states a review is required.

### Resolving addressed review comments

- Review-comment threads are auto-resolved by `.github/workflows/auto-resolve-review-threads.yml` — you do **not** click "Resolve conversation", and no PAT is involved (it runs as the GitHub App bot, never as a human).
- When you address a review comment — whether by pushing a fix **or** by explaining in-thread why no change is needed — reply **in that thread** with the marker `✅ Addressed` (ideally `✅ Addressed in <sha>: <one-line note>`). The workflow resolves the thread on the next push/sweep. The code does **not** need to be outdated.
- Only replies from the PR owner/member/collaborator or a trusted bot (e.g. the Copilot coding agent) count, so drive-by comments cannot bypass the conversation-resolution merge gate.
- **Copilot code-review threads need an owner resolve.** Threads authored by the `copilot-pull-request-reviewer` app come back with `viewerCanResolve: false` for the auto-resolve workflow's App token (a GitHub App can't resolve another App's thread), so the bot **skips** them even after you reply with the marker. After you reply `✅ Addressed in <sha>` on such a thread, resolve it yourself as the PR owner via GraphQL `resolveReviewThread` rather than waiting on the bot — otherwise an already-armed `--auto` merge stays **BLOCKED** on the conversation-resolution gate. Example: `gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t='<thread-node-id>'`.
- **Bot-pushed CI checks park in `action_required`.** When a commit is pushed by
  the same App token that would run the workflow, GitHub Actions parks the
  workflow run in `action_required` and does not schedule it. `gh pr checks`
  will never show those checks completing, so an armed `--auto` merge sits
  forever. Fix: push one commit under a **human or a different GitHub App
  identity** (an empty no-op commit — `git commit --allow-empty -m "chore: retrigger CI"` — is fine) to re-trigger the runs.
  <!-- Source handoff: 2026-06-24-safe-room-zoom-shepherd.md -->

## Known Environment Quirks

- **`scripts/agent/lab-gate-check.sh` is pathologically slow (~50 s/system) on
  Windows Git Bash.** The check forks a subprocess per system, and Windows
  Git Bash's per-fork overhead dominates the total. Independently
  rediscovered in ≥ 3 handoffs (`mana-and-abilities`,
  `headless-runner-pathfinding-slowdown`, `ai-exploration-kernels`). Run it
  on CI or in WSL locally; do not add "the lab gate is slow" to the handoff
  again.
  <!-- Source handoff: 2026-06-17-headless-ai-runner.md -->

## Tech Stack

TypeScript (strict) · Phaser 4 · bitecs 0.4 · Vite · Vitest · fast-check · ESLint · Prettier · GitHub Actions
