# AGENTS.md — Crawler Project

## Quick Start

1. Run `bash scripts/agent/preflight.sh` at session start
2. Select your persona from the routing matrix in `docs/agent-os/personas/README.md` (default to **Producer** for multi-layer or ambiguous tasks), then read that persona doc
3. Before planning work in a system, read the relevant section of `docs/knowledge/handoffs/INDEX.md` and skim the top 3-5 listed handoffs for that system. Fall back to a broader scan of `docs/knowledge/handoffs/` only if the index has no coverage for your target system.
4. Load durable facts: call the memory MCP `read_graph` (or `search_nodes`) and skim `docs/knowledge/memory/` — see `docs/guides/agent-memory.md`
5. Run `bash scripts/agent/verify-fast.sh` after every meaningful change
6. Run `npm run verify:pr-prereqs` before creating a PR so review-harness and other PR blockers surface early. Do **not** run full `npm run verify` merely because you are committing or opening a PR; CI owns the full suite unless a human explicitly requests a local run or targeted diagnosis requires it.
7. Write a handoff file before ending implementation sessions (merge-intent changes); investigation sessions without merge-intent fixes may skip this
8. If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>` to write a committed per-session summary under `docs/knowledge/metrics/guard-telemetry/` (the durable, contamination-filtered collection path). The trimmed handoff template no longer carries a telemetry block — the committed summary file is the record.

- **Synchronize during authoring:** Preflight runs `npm run sync:main -- --reason session-start`. The `authoring-main-sync` guard measures bounded intervals between active agent tool calls and attempts another local rebase after 30 active minutes. If work is dirty, checkpoint it and run `npm run sync:main -- --reason periodic`; the reminder is non-blocking and remains due until synchronization succeeds. Run `npm run sync:main -- --reason pre-publish` before final validation and PR publication. If it changes HEAD, rerun affected validation. Synchronization never pushes, and missing/stale evidence alone never blocks publication.
- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.
- **Plans stay in session chat:** When giving a plan, write the full plan in session chat. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.
- **Published PRs detach by default:** Unless the human explicitly states before PR publication that the session should remain local, an implementation session must publish a ready-for-review PR, leave complete handoff context, then end/release its ownership immediately. Do **not** wait locally for CI, reviews, or cloud confirmation; CI Recovery assigns cloud Copilot for blockers, with the 10-minute scheduled sweep as the takeover backstop.
- **Broad sweeps default to GitHub:** For sweeps or batch evals with **more than 10 runs**, default to GitHub-backed `workflow_dispatch`/CI execution (for example `.github/workflows/weapon-sweep.yml` or `.github/workflows/ai-sweep.yml`) instead of local/session compute unless a human explicitly asks for local.
- **Sweep Results Viewer deep links are required:** Whenever you discuss, start, check, check the status of, or report results for any sweep (weapon-sweep **or** AI Sweep Eval), you **MUST** include an app-native Sweep Results Viewer reference in your response. Use the canvas `runId` input: `project:sweep-results-viewer runId=<run-id>`. A raw GitHub Actions URL may appear as a **secondary** fallback only — never as the sole navigation path. This applies to every mention of a sweep run id, workflow dispatch confirmation, status update, and results summary.
- **Investigation sessions are process-light:** Investigation/repro/debug sessions with no merge-intent fix may stay lightweight (no review ledger/full PR paperwork). If a fix should land, spin a separate implementation child session/PR and run the normal full process there.
- **Tooling-only ceremony is capped at 3🍎:** Work confined to developer/agent tooling, canvases, automation, or asset-pipeline tooling is estimated at no more than 3🍎 regardless of file count; the cap does not apply when runtime gameplay behavior or shipped game data changes.

## Request Intake

The sole maintainer works best answering questions one at a time rather than writing a full spec upfront. Do NOT wait for a complete brief — actively drive the framing:

1. **Interview, don't wait.** Ask the single most decisive question, let the maintainer answer, then ask the next. Never dump a wall of questions at once.
2. **Converge on a bounded, single-metric ask.** Continue until the request has one hard, measurable success gate (a number or checkable condition) plus a ranked list of soft tiebreakers. Open-ended "make it good/better/faster" directives are not ready to start.
3. **Reflect it back before coding.** Restate the ask in bounded form and get an explicit yes/no before writing code.
4. **Push back on drift.** If an ask has no measurable done-state, say so and ask the narrowing question instead of guessing or silently scoping it yourself.
5. **Say whether it's a good idea.** Be vocal about whether the ask is sound, and output plans directly in the session chat.

## Commands

| Task                      | Command                                   |
| ------------------------- | ----------------------------------------- |
| Typecheck                 | `npm run typecheck`                       |
| Lint                      | `npm run lint`                            |
| Lint (fix)                | `npm run lint:fix`                        |
| Format                    | `npm run format`                          |
| Format (check)            | `npm run format:check`                    |
| Unit tests                | `npm run test:unit`                       |
| All tests (4 projects)    | `npm test`                                |
| Unit tests (watch)        | `npm run test:watch`                      |
| Integration tests         | `npm run test:integration`                |
| E2E tests                 | `npm run test:e2e`                        |
| Coverage (unit)           | `npm run verify:coverage`                 |
| Dev server                | `npm run dev`                             |
| Lab mode                  | `npm run lab`                             |
| DevTools mode             | `npm run devtools`                        |
| Build                     | `npm run build`                           |
| Dead code                 | `npm run lint:dead-code`                  |
| Sprite extract palette    | `npm run sprites:extract-palette`         |
| Sprite run                | `npm run sprites:run`                     |
| Sprite gallery            | `npm run sprites:gallery`                 |
| Sprite approve            | `npm run sprites:approve`                 |
| Sprite unapprove          | `npm run sprites:unapprove`               |
| Sprite synth              | `npm run sprites:synth`                   |
| Sprite batch              | `npm run sprites:batch`                   |
| Sprite asset plan         | `npm run sprites:asset-plan`              |
| Sprite plan drafts        | `npm run sprites:plan-drafts`             |
| Sprite worker             | `npm run sprites:worker`                  |
| Sprite ingest once        | `npm run sprites:ingest-once`             |
| Sprite sync catalog       | `npm run sprites:sync-catalog`            |
| Sprite metadata           | `npm run sprites:metadata`                |
| Scope changed files       | `npm run scope`                           |
| Sync branch with main     | `npm run sync:main`                       |
| Fast verify               | `npm run verify:fast`                     |
| Full verify               | `npm run verify`                          |
| Full verify + headless    | `VERIFY_FULL=1 npm run verify`            |
| Sprite pipeline tests     | `npm run test:sprites`                    |
| Full verify + knip        | `VERIFY_KNIP=1 npm run verify`            |
| PR prereq check           | `npm run verify:pr-prereqs`               |
| Guard telemetry capture   | `npm run telemetry:capture`               |
| Record apple entry        | `npm run apples:record`                   |
| Full verify + coverage    | `VERIFY_COVERAGE=1 npm run verify`        |
| Guard + ledger tests      | `npm run test:guards`                     |
| Review ledger             | `npm run review:ledger`                   |
| Docs loop (local)         | `npm run docs:check`                      |
| Security loop             | `npm run security:check`                  |
| Health loop               | `npm run health:check`                    |
| Build + typecheck src     | `npm run build:typed`                     |
| Typecheck src only        | `npm run typecheck:src`                   |
| Lint with cache           | `npm run lint:cache`                      |
| Lint core layer           | `npm run lint:core`                       |
| Lint game layer           | `npm run lint:game`                       |
| Lint engine layer         | `npm run lint:engine`                     |
| Lint labs layer           | `npm run lint:labs`                       |
| Changed unit tests        | `npm run test:changed`                    |
| Headless tests            | `npm run test:headless`                   |
| AI headless runner        | `npm run ai:headless`                     |
| Sprite enqueue            | `npm run sprites:enqueue`                 |
| Flash verify              | `npm run verify:flash`                    |
| Verify core layer         | `npm run verify:core`                     |
| Verify game layer         | `npm run verify:game`                     |
| Verify engine layer       | `npm run verify:engine`                   |
| Verify labs layer         | `npm run verify:labs`                     |
| Perf baseline             | `npm run perf:baseline`                   |
| Gameplay fingerprint      | `npm run perf:fingerprint`                |
| Sim CPU profile           | `npm run perf:profile`                    |
| Benchmarks                | `npm run bench`                           |
| Unit test coverage        | `npm run test:coverage`                   |
| AI hill-climb sweep       | `npm run ai:hill-climb`                   |
| AI weapon sweep           | `npm run ai:weapon-sweep`                 |
| AI win-rate sweep         | `npm run ai:winrate-sweep`                |
| AI A/B decision mode      | `npm run ai:ab-decision-mode`             |
| AI A/B pathing mode       | `npm run ai:ab-pathing-mode`              |
| AI navmesh sweep          | `npm run ai:navmesh-sweep`                |
| AI navmesh seam sweep     | `npm run ai:navmesh-seam-sweep`           |
| AI gen configs            | `npm run ai:gen-configs`                  |
| AI sweep eval             | `npm run ai:sweep-eval`                   |
| AI aggregate shards       | `npm run ai:aggregate-shards`             |
| Sprite check-in           | `npm run sprites:checkin`                 |
| Sprite asset PR           | `npm run sprites:asset-pr`                |
| Sprite normalize items    | `npm run sprites:normalize-item-art`      |
| Sprite sort assets        | `npm run sprites:sort-assets`             |
| Sprite gen placeholders   | `npm run sprites:gen-placeholders`        |
| Sprite fetch gear icons   | `npm run sprites:fetch-gear-icons`        |
| Sprite placeholder audit  | `npm run sprites:placeholder-audit`       |
| Sprite backfill types     | `npm run sprites:backfill-manifest-types` |
| Sprite generate wiring    | `npm run sprites:generate-wiring`         |
| Sprite reprocess room     | `npm run sprites:reprocess:welcome-room`  |
| Terrain packs build       | `npm run terrain-packs:build`             |
| Terrain packs validate    | `npm run terrain-packs:validate`          |
| Azure setup (provision)   | `npm run setup:azure:provision`           |
| Azure env setup           | `npm run setup:azure:env`                 |
| Azure env setup (force)   | `npm run setup:azure:env:force`           |
| Azure GitHub setup        | `npm run setup:azure:github`              |
| Check physics defs sync   | `npm run check:physics-defs-sync`         |
| Check size coverage       | `npm run check:size-coverage`             |
| Check weight coverage     | `npm run check:weight-coverage`           |
| Check asset sort order    | `npm run check:sort-assets`               |
| Boss ability status       | `npm run boss-abilities:status`           |
| Docs index                | `npm run docs:index`                      |
| Visual review             | `npm run review:visual`                   |
| Visual review (det.)      | `npm run review:visual:deterministic`     |
| Visual review (LLM)       | `npm run review:visual:llm`               |
| Visual review (equip.)    | `npm run review:visual:equipment`         |
| Producer agent            | `npm run producer`                        |
| Epic status               | `npm run epic:status`                     |
| Perf find baseline        | `npm run perf:find-baseline`              |
| Merge train protection    | `npm run train:protection`                |
| Train protection status   | `npm run train:protection:status`         |
| Train protection enable   | `npm run train:protection:enable`         |
| Train protection rollback | `npm run train:protection:rollback`       |

For sprite workflow details and when to use sprite commands, see
`scripts/sprites/` for implementation details or `docs/knowledge/game-design/art-style-guide.md` for art context.

## Scoping heavy validation (local)

Heavy discretionary runs are the biggest source of wasted local time. Run `npm run scope`
(a working-tree-aware wrapper over the CI `detect-art-only.sh` classifier) and gate the
expensive checks on its flags. It prints `art_only` / `docs_only` / `gameplay_safe` for the
union of your committed branch changes **and** uncommitted work; it fails safe (all-false →
run everything) when it can't resolve a merge base.

| Heavy run                          | Run it locally only when…                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Headless Floor-1 (`VERIFY_FULL=1`) | `scope` shows `gameplay_safe=false` (else the sim can't change)                                                                  |
| Weapon sweeps (`ai:weapon-sweep`)  | **small smoke sweeps only (≤10 runs)**; for broad sweeps (>10), use GitHub workflow dispatch (`weapon-sweep.yml`/`ai-sweep.yml`) |
| Visual review (`review:visual`)    | a changed **UI surface** is in scope                                                                                             |
| `VERIFY_KNIP=1 npm run verify`     | refactoring or removing exports/deps                                                                                             |

CI still enforces the real gates on non-`gameplay_safe` PRs and on main-push, so scoping
these **locally** never weakens a required check — it just skips work that provably can't
fail. `verify:fast` already uses `scope` internally to skip the two headless-sim coverage
checks on a `gameplay_safe` change set.

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
- **AI**: `src/game/ai/` hosts deterministic runtime AI — headless simulation runners, behavior-tree kernels, win-rate sweeps, family-aware target selection. LLM/Director content, when implemented, is layered on top and runs only during floor-load transitions (see constitution Principle 6)

## Layer Rules (enforced by ESLint)

- `src/core/` → must not import from `src/engine/`, `src/game/`, or `src/labs/`
- `src/engine/` → must not import from `src/game/` or `src/labs/`
- `src/game/` → must not import from `src/engine/` or `src/labs/`
- `src/labs/` → unrestricted

## Key Files

| What                      | Where                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Docs hub & governance map | `docs/README.md`                                                                                                           |
| Architecture overview     | `docs/architecture.md`                                                                                                     |
| Agent personas            | `docs/agent-os/personas/*.md`                                                                                              |
| Policies                  | `docs/agent-os/policies/*.md`                                                                                              |
| **CI knobs reference**    | `docs/agent-os/policies/ci-config-knobs.md` — all runtime-tweakable CI variables, defaults, valid ranges, and interactions |
| Architecture decisions    | `docs/knowledge/adr/*.md`                                                                                                  |
| Specs                     | `.specify/specs/*.md`                                                                                                      |
| Game design               | `docs/knowledge/game-design/*.md`                                                                                          |
| Session handoffs          | `docs/knowledge/handoffs/*.md`                                                                                             |
| Agent memory              | `docs/guides/agent-memory.md`, `docs/knowledge/memory/`, `docs/knowledge/agent-memory.jsonl`                               |
| Guides                    | `docs/guides/*.md`                                                                                                         |
| CI config                 | `.github/workflows/`                                                                                                       |
| Automation loop scripts   | `scripts/agent/`                                                                                                           |
| Health metrics            | `docs/knowledge/metrics/`                                                                                                  |
| SpecKit constitution      | `.specify/memory/constitution.md`                                                                                          |

## Rules

1. **Lab-gated development**: No system ships without a lab. CI enforces this.
2. **Deterministic CI only**: No LLM-as-judge in CI. All gates are scripts with exit codes.
3. **Never use Math.random()**: Use `SeededRandom` from `src/shared/random.ts`
4. **Never use Date.now()**: Pass delta/frameCount as parameters
5. **Handoff required for implementation sessions**: For sessions producing merge-intent changes, write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending session. Include the `## Systems touched` field (comma-separated slugs from `docs/systems/README.md`) so the session shows up in `docs/knowledge/handoffs/INDEX.md`. It will be required by the pre-flight lint once the handoff tooling PR wires that in; treat as advisory until then. **Do NOT run `npm run docs:index` to rebuild `INDEX.md` yourself** — CI rebuilds it automatically on every merge that adds a handoff file, and concurrent sessions rebuilding the same file is a primary source of merge conflicts.
6. **ADR required**: Any decision affecting 2+ systems needs an ADR
7. **Always fix test and infra failures**: Never skip, ignore, or document broken tests/lint/build issues as "preexisting" or "unrelated" and move on. Fix every failure you encounter, regardless of whether you caused it. There is no such thing as a pre-existing issue that is out of scope — cruft compounds and wastes future agent time.
8. **Best-effort UT coverage progress**: As part of every fix/implementation, make a best effort to improve or preserve unit-test coverage in touched areas so work moves toward UT coverage goals.
9. **Observe before done (visual/runtime)**: For any visual or runtime bug/feature, reading the diff or source is NOT verification. Before claiming done you MUST (a) reproduce the old/broken behavior in the running artifact — a lab via `npm run lab` (`?lab=<name>`) or the game via `npm run dev` — and capture it (screenshot, a `tests/e2e/helpers/ui-probe.ts` probe, or headless `RunStats`), then (b) re-observe after the fix to confirm the behavior changed. State the before/after in the PR/handoff. For UX-facing changes, make this visual validation **headless and deterministic by default** so checks are reproducible and do not rely on an interactive manual run. Prefer promoting a recurring visual-bug class into a **deterministic** check (`tests/e2e/helpers/pixels.ts` / `ui-probe.ts`, see `tests/e2e/hud-overlap-visual.test.ts`; or a headless assertion, see `tests/headless/floor1-completion.test.ts`) — deterministic only, never an LLM-as-judge.
   - **Lab-only validation is INSUFFICIENT for wiring/behavior changes, and you MUST name the real artifact.** A lab (`src/labs/**`) force-calls the system under test, so a green lab proves the system works in isolation — it can NEVER prove the real game or headless runner actually calls it. For any change that adds/moves a system or alters runtime behavior, your "observe before done" note MUST name the **real pipeline artifact** you observed it in — the game (`npm run dev`) or a headless pipeline / win-rate gate (`src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`) — not a lab. If you validated only in a lab, the change is NOT done. This is enforced deterministically by the orphaned-system wiring guard (`npm run check:wired-systems`, ADR 0039); see rule #14. This rule exists because `spawnerSystem` shipped fully inert — lab-proven, ADR'd, merged — yet never referenced by either real pipeline (ADR 0034 → ADR 0036 fix in PR #665).
10. **PR title/description synthesis**: When creating or updating a PR title/description — including after any feedback turns — always synthesize the _entire_ session's work. Read the existing PR title/description first (via `gh pr view`), then write a holistic title and description that covers every change on the branch, not just the most recent task. Never replace the primary purpose of the PR with a secondary or follow-up concern. The title must reflect the dominant feature/fix; secondary changes belong as bullet points in the description.
11. **Never weaken explicit human requirements without asking**: Do NOT cut corners by quietly relaxing, disabling, or disregarding an explicit, user-stated requirement for a session — including the feature's own defining parameter — just to make a gate/test pass. This holds in every mode, **including autopilot**. If the only way you can see to get green is to weaken the requirement, STOP and ask the human first (state the trade-off and options); fix the test/gate around the requirement, not the requirement around the test.
12. **Never bend gameplay to pass seeds; gate on win-RATE, not cherry-picked seeds**: Do not tune game balance to rescue specific pre-existing seed runs, and do not add shortcuts/cheats that hold map structure fixed just to avoid recomputing success/failure rates. **Target: 90%+ of Floor 1 seeds should easily reach a win condition.** If a broad seed sweep shows materially less, treat it as a likely **AI-runner bug or extreme gameplay regression** and fix the root cause — never hand-pick a handful of comfortable seeds to make the gate green.
13. **Apple-scaled review harness before PR**: Every code-touching change runs the review harness scaled to its apple estimate and records it in a **review ledger** (`docs/knowledge/review-ledgers/<date>-<slug>.review-ledger.json`). **≥3🍎** → separate-model **plan review** **and** a **code-review loop until no concerns _or_ a 2-round cap then human escalation**; >3🍎 → the plan review must be **adversarial** (one reviewer enumerates ≥2 alternatives and argues against the chosen design) **and** **multi-model review** with adjudication (same 2-round-cap/escalation rule). Every plan review (≥3🍎) records a `plan_divergence` signal so the real design fork-rate can be measured. 1–2🍎 require no review stages (plan-review floor raised 2🍎→3🍎 on 2026-07-07 to match the code-review floor, ADR 0036; dual-plan synthesis retired as a required 4–5🍎 stage on 2026-07-08, ADR 0051 — replaced by the adversarial plan review). The `pr-review-ledger` guard hard-denies `create_pull_request` without a valid ledger for the tier (docs/art/deps-only diffs are exempt). Author it with the [`review-harness` skill](.github/skills/review-harness/SKILL.md); never weaken a stage to go green (see rule #11) — escalate to a human instead. Canonical: [`docs/agent-os/policies/review-harness-policy.md`](docs/agent-os/policies/review-harness-policy.md).
14. **Every game system must be wired or explicitly allowlisted**: Any `*System` exported from `src/core/**` or `src/game/**` MUST be referenced by a real runtime wiring site (`src/bootstrap/floor-main-scene-options.ts`, `src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`, `src/engine/scenes/MainGameScene.ts`) or added to the documented allowlist in `scripts/agent/health/orphaned-systems-lib.ts` with a reason. Lab/test references do NOT count. Enforced by `npm run check:wired-systems` (ADR 0039), run in `verify` and the `check-format-and-labs` CI job. Never allowlist a system just to go green (see rule #11) — allowlisting is only for systems intentionally not-yet-wired, and the reason must say so.
15. **Broad sweeps (>10 runs) use GitHub infrastructure by default**: Prefer GitHub Actions `workflow_dispatch`/CI runners over local or session compute for broad sweeps so sampling is parallelized and local resources stay available. Keep local sweeps for small smoke checks or explicit human override.
16. **Split investigation from landing implementation**: Investigation/repro/debug sessions can be scrappy and low-overhead when they are not landing code. Once an investigation identifies a fix to ship, open a separate implementation child session/PR and run the normal full process there.
17. **Sweep Results Viewer deep links are required for any sweep discussion**: Whenever you discuss, start, check, report status for, or summarize results of any sweep (weapon-sweep **or** AI Sweep Eval), include an app-native Sweep Results Viewer reference. Use the canvas `runId` input — `project:sweep-results-viewer runId=<run-id>` — so the viewer opens directly on that session. A raw GitHub Actions URL is a permitted secondary fallback only; never provide it as the sole navigation path.

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
- **Batch review fixes into one push per round.** Each push re-triggers the full merge-gate CI (~4.7 runs/branch historically). Accumulate all fixes for a review round, run `verify:fast` once, then push once — don't push per-fix. Rely on the armed `--auto --squash` merge; do not add manual poll/wait loops.

### Resolving addressed review comments

- Review-comment threads are reconciled by `.github/workflows/ci-recovery.yml` using the owner-scoped `CRAWLER_CI_PAT`, including cross-App Copilot reviewer threads.
- When you address a review comment by pushing a fix, reply **in that thread** with `✅ Addressed in <sha>: <one-line note>`. When a finding is deterministically non-applicable (the code does not need changing — e.g. the line no longer exists, or the concern was already addressed elsewhere), reply with `✅ Not applicable: <one-line reason>` — do NOT use this for substantive disagreements. The reconciler resolves the thread on the next event or 10-minute sweep.
- Only replies from the PR owner/member/collaborator or a trusted bot (e.g. the Copilot coding agent) count, so drive-by comments cannot bypass the conversation-resolution merge gate.
- The CI recovery task requires a different-model validator for every listed review thread. Substantive disagreement stays unresolved and escalates; only marker-confirmed fixes or deterministic non-applicability may auto-resolve.
- **Bot-pushed CI checks park in `action_required`.** When a commit is pushed by
  the same App token that would run the workflow, GitHub Actions parks the
  workflow run in `action_required` and does not schedule it. `gh pr checks`
  will never show those checks completing, so an armed `--auto` merge sits
  forever. Fix: push one commit under a **human or a different GitHub App
  identity** (an empty no-op commit — `git commit --allow-empty -m "chore: retrigger CI"` — is fine) to re-trigger the runs.
  <!-- Source handoff: 2026-06-24-safe-room-zoom-shepherd.md -->

## Known Environment Quirks

- **`claude-sonnet-4.5` is deprecated (since 2026-05-06) — do NOT use it.** If
  any task call specifies `model="claude-sonnet-4.5"`, the session will fail
  immediately at `session.create`. Use `claude-sonnet-4.6` or `claude-sonnet-5`
  instead. This applies to all `task()` calls in skills and agent sessions.
  If you need to update a legacy reference, replace `claude-sonnet-4.5` →
  `claude-sonnet-4.6` everywhere in accessible configuration.
  <!-- Source issue: #2209, handoffs 2026-07-25-ci-recovery-loop-pr-1886, 2026-07-27-ci-recovery-typo-threshold -->

- **Copilot guards load once per session — `extensions_reload` after syncing
  main.** A guard merged to `main` after your session started is not running in
  your session, and `git pull` does not change that: the extension host loaded
  the guard set at session start. This is a safety hole, not just a telemetry
  gap. Empirically confirmed — a session that predated `authoring-main-sync`
  recorded 10 guard events over two days (all PR-time) and began firing it
  immediately after one `extensions_reload`. 68 of 71 committed telemetry files
  show the same near-empty PR-time-only signature. Treat sparse
  `files/guard-telemetry.jsonl` as a prompt to reload.
  <!-- Source handoff: 2026-07-27-perf-skill-benchmark-warmup.md -->

- **`scripts/agent/lab-gate-check.sh` is slow on Windows Git Bash.** It was
  refactored to O(systems + labs) (lab base-names are precomputed once via bash
  parameter expansion instead of forking `basename`/`sed`/`tr` per system×lab
  pair), which cuts the fork count sharply — but per-fork overhead on Windows
  Git Bash still makes it the slowest local check. CI enforces it (blocking,
  `check-format-and-labs`), so **do not run it locally on Windows** — run it on
  CI or in WSL. Independently rediscovered in ≥ 3 handoffs (`mana-and-abilities`,
  `headless-runner-pathfinding-slowdown`, `ai-exploration-kernels`); do not add
  "the lab gate is slow" to the handoff again.
  <!-- Source handoff: 2026-06-17-headless-ai-runner.md -->

- **Knip in full `verify` is opt-in** (`VERIFY_KNIP=1 npm run verify`). It's advisory
  in CI regardless, so run it locally only when refactoring/removing exports.

- **A `bash` on `PATH` on Windows may resolve to the WSL interop shim**
  (`C:\Windows\System32\bash.exe`, a genuine Linux `x86_64-pc-linux-gnu` bash),
  not Git-Bash/MSYS2. Two things silently break tests that `spawnSync('bash', ...)`
  a script by absolute path: (1) a `path.resolve()`-built Windows path
  (`C:\Users\...`) is meaningless to WSL, which needs the corresponding WSL
  mount form instead; (2) WSL does **not** forward the parent process's env
  vars into the Linux session unless they're named in the `WSLENV`
  allow-list, so custom env-var test hooks (e.g. `SCOPE_FILES_OVERRIDE`) are
  silently dropped rather than erroring. Use
  `tests/helpers/bash-script-path.ts` (`toBashScriptPath()` for the path,
  `bashEnv()` for env vars) — both are no-ops on non-Windows/non-WSL bash.
  Separately, a just-exited WSL bash child can leave its working directory
  transiently locked from Windows' point of view for a few seconds; `rmSync`'s
  own `maxRetries` does not cover a busy top-level `rmdir`, so cleanup needs a
  real async wait-and-retry loop (see `local-scope.test.ts`'s `rmDirWithRetry`).
  <!-- Source handoff: 2026-07-16-enemy-projectile-telegraph.md -->

## Tech Stack

TypeScript (strict) · Phaser 4 · bitecs 0.4 · Vite · Vitest · fast-check · ESLint · Prettier · GitHub Actions
