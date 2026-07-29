# Session Handoff: Refactor/cleanup campaign — multi-wave orchestration

## Date

2026-06-29

## Persona(s) adopted

**Producer** (primary) — the request was a broad, multi-layer "massive
refactor/cleanup" spanning core, engine, game, and tests, which is squarely
Producer territory: review the whole codebase, slice the backlog into
disjoint-file-set workstreams, and route each to a specialist child session.
Routed specialists: **QA/Tester** (property suites, map-fixtures,
characterization guards), **Engine** (MainGameScene/PhaserBridge decomposition),
**Core/Refactor** (helpers spawners split, DungeonGenerator split,
bt-ai-provider extraction).

## Routing verdict

🧩 needed Producer to split — a single session could not have safely landed
nine PRs across four layers without serializing into weeks of work; fanning out
into disjoint-file-set sessions with auto-rebase between merges was the unlock.

## Apples

Estimated: 🍎 x 5 <!-- declared before work began -->
Actual: 🍎 x 5
Verdict: 🎯 Exact — a full-codebase review plus orchestration of 9 PRs across 3
waves and 4 architectural layers, including cross-session conflict management and
a merge-gate diagnosis, is a top-tier coordination effort.

Hello kitties: 5/5 = 1.00 🎀

## Review Harness

N/A — this handoff commit is docs-only (orchestration summary + apples metric).
Each child PR ran its own review harness / verify gate; see the per-session
handoffs linked below.

## What Was Done

Orchestrated a behavior-preserving refactor campaign as a sequence of disjoint,
parallel-safe child sessions, each opening its own auto-merge PR gated by the
full `npm run verify` suite (including the ~8-min headless Floor-1 win-rate
proof). **Nine PRs landed on main; zero behavior changes; zero requirements
weakened; SeededRandom-only throughout.**

### Wave 0 — foundation (this session's own PR)

- **#477** — extracted shared `src/shared/vec.ts`, grid utilities, and the pure
  BFS `src/game/room-hops.ts` (`roomHopDistances`, `HopGraph { get }` accessor)
  out of `floorScenario.ts`; deduped blood constants. ADR 0033. MERGED.

### Wave 1 — fan-out (4 parallel sessions)

- **#483** (QA) — 6 fast-check property suites under `tests/property/` (37 tests,
  additive). MERGED.
- **#484** (Core) — split the ~725-LOC `src/core/helpers.ts` god-module into 6
  focused `src/core/spawners/*` modules behind a thin re-export facade (22
  spawners), with per-module test suites. MERGED.
- **#485** (AI) — extracted tuning consts, pure `computeFloorProgressScore`, and
  LOS `hasClearLineOfSight` geometry out of the ~3931-LOC
  `bt-ai-provider.ts` behind a behavior-identical facade. MERGED.
- **#486** (QA) — consolidated duplicated test map-builders into
  `tests/helpers/map-fixtures.ts` (9 parameterized builders + 15-test
  contract-lock, −527 net). MERGED.

### Wave 2 — precursor + core split (2 parallel sessions)

- **#490** (QA) — deterministic characterization guards pinning PhaserBridge
  (6-test unit suite + shared harness fixture) and MainGameScene (probe lab
  `window.__mainSceneProbe` + 2 e2e guards: boot wiring, camera-follow
  invariant). Additive; zero engine source changed. **Gated wave 3.** MERGED.
- **#489** (Core) — decomposed the 1726-LOC `DungeonGenerator.ts` into 8 verbatim
  `dungeon/*` modules behind a ~251-LOC facade, guarded by a golden-map
  determinism snapshot (30 maps byte-identical). MERGED.

### Wave 3 — engine decomposition (2 parallel sessions, off the #490-guarded main)

- **#491** (Engine) — split `PhaserBridge.ts` (1336 → 980) into
  `phaser-bridge/textures.ts` + pure `phaser-bridge/sprite-kind.ts`
  (`resolveRenderKind` et al.), +39 branch-covering unit tests. MERGED.
- **#492** (Engine) — extracted the entire ordered ECS pipeline from
  `MainGameScene.update()` into `src/engine/sim/simulation-step.ts`
  (`runSimulationStep`, afterInput hook preserves the paused single-step seam) +
  lifted 6 pure helpers to `main-game-scene-helpers.ts` with unit + fast-check.
  Caught and fixed a latent `formatAbilityTrigger` bug (object-literal lookup
  leaked `Object.prototype` members for junk ids → `Map`). MERGED.

### Net structural impact (LOC on the five heavy-hitter files)

| File                                          | Before | After | Δ                               |
| --------------------------------------------- | ------ | ----- | ------------------------------- |
| `src/core/helpers.ts`                         | 725    | 11    | facade; 22 spawners → 6 modules |
| `src/core/map/generators/DungeonGenerator.ts` | 1726   | 251   | −1475 → 8 modules               |
| `src/engine/scenes/MainGameScene.ts`          | 2331   | 2220  | pipeline + 6 helpers out        |
| `src/engine/PhaserBridge.ts`                  | 1336   | 980   | −356 → 2 modules                |
| `src/game/ai/bt-ai-provider.ts`               | 3931   | 3583  | −348 → 3 modules                |

New focused modules created: `src/shared/vec.ts`, `src/game/room-hops.ts`,
`src/core/spawners/*` (7), `src/core/map/generators/dungeon/*` (8),
`src/game/ai/{bt-ai-tuning,scoring,bt-ai-geometry}.ts`,
`src/engine/phaser-bridge/{textures,sprite-kind}.ts`,
`src/engine/sim/simulation-step.ts`,
`src/engine/scenes/main-game-scene-helpers.ts`. Plus ~120 new
unit/property/characterization tests across the campaign.

## What's Next

- **Wave 4 (deferred, lower value/higher care):** the MainGameScene lighting
  cluster and the UNGUARDED behaviors E flagged (scene `shutdown()` teardown,
  display-list depth/sort, input wiring, camera zoom magnitude) — each needs a
  `window.__mainSceneProbe` guard added BEFORE the code moves.
- `devtools-main` (~5942 LOC, dev-only) decomposition — lower priority.
- Further `floorScenario` decomposition; HUD bar factory; UI theme/grid
  extraction; expanding property suites to newly-pure helpers.
- `bt-ai-provider.ts` still has a ~3500-LOC stateful `BehaviorTreeAI` class —
  the next safe target is characterization guards on its decision outputs before
  any method extraction.

## Blockers

None. All nine PRs merged.

## Branch State

- Branch: `nalfeo-refactor-cleanup-review` (this session's #477 already merged;
  reset to main HEAD for this docs-only handoff commit)
- All tests passing: yes (every child PR landed green incl. the headless Floor-1
  gate; main is green)
- PR created: yes (this handoff) — child PRs #477, #483, #484, #485, #486, #489,
  #490, #491, #492 all MERGED

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present in this orchestrator session — nothing
to paste.

## Test Results

Not run in this orchestrator session (docs-only commit). Behavior preservation
was proven per-PR: each of the nine child PRs passed full `npm run verify`
including the headless Floor-1 win-rate gate, and the engine PRs additionally
passed `npm run test:e2e` against #490's characterization guards.

## Key Decisions Made

- **Disjoint-file-set fan-out + auto-rebase.** Workstreams were chosen so no two
  open PRs edited the same file; the repo's `rebase-prs` workflow serialized
  merges and cleanly handled the few real overlaps (#477↔#484 on `helpers.ts`,
  #485↔#486 on a diagonal-corner test).
- **Guards before decomposition.** The engine god-classes were ~0% UT, so a
  precursor session (#490) shipped deterministic characterization guards FIRST;
  wave 3 only launched once those guards were on main, giving each engine split
  a behavioral safety net.
- **Single-layer facades to avoid ADR churn.** Each refactor kept its public
  surface byte-identical via a re-export barrel/facade, keeping diffs
  single-layer (no cross-layer ADR required) while still shedding bulk.
- **Behavior proof = headless win-rate gate, not LLM judgment.** The ~8-min
  Floor-1 gate (plus golden-map snapshots and e2e camera/boot guards) was the
  deterministic equivalence net for every PR.
- **Merge-gate diagnosis over blind retry.** When #489 sat BLOCKED with all CI
  green, the cause was the conversation-resolution gate (2 unresolved
  `copilot-pull-request-reviewer` doc threads), not CI or human review — fixed by
  delegating the doc-fidelity fix back to the owning session and owner-resolving
  the reviewer-app threads.

## Retrospective

### Lessons Learned

- The `copilot-pull-request-reviewer` threads must be **owner-resolved**; the
  auto-resolve workflow bot skips them (`viewerCanResolve:false` for its App
  token), so an all-green PR can sit BLOCKED indefinitely on the
  conversation-resolution gate until a human/owner resolves them. Always check
  `reviewThreads` when `mergeStateStatus:BLOCKED` but every check passes.
- A self-notifying background watcher (`gh pr view … --jq .state` loop in async
  PowerShell) is a clean way to await merges without polling turns — it fires a
  completion notification.
- A "skipping" required-looking check (e.g. conditional `Build`) is NOT the
  blocker when sibling PRs with the same skip merged fine — look past it.

### Mistakes Made

- The first cross-session merge watcher bounded at 100×30s underran the real
  wait once a PR was repeatedly rebased; the early signal was a PR staying
  BLOCKED long after CI greened. Re-checking `reviewThreads` (not just checks)
  sooner would have surfaced the doc-thread gate a few minutes earlier.
- Initial recon assumed `MainGameScene.ts` lived at `src/engine/` — it's under
  `src/engine/scenes/`. Confirm paths against `git ls-tree origin/main` before
  trusting a baseline.

### Opportunities for Future Improvement

- Promote the highest-risk UNGUARDED engine behaviors (shutdown teardown,
  display-list depth, input wiring) into `__mainSceneProbe` guards as their own
  small precursor PR before any wave-4 engine extraction.
- Consider a repo helper that, on `mergeStateStatus:BLOCKED`, prints whether the
  cause is checks vs unresolved threads vs review — it would have made the #489
  diagnosis a one-liner.
- The `bt-ai-provider` stateful class is the largest remaining monolith; a
  characterization-guard-first approach (like #490 did for the engine) is the
  safe path in.
