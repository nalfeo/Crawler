# Session Handoff: Decompose bt-ai-provider.ts (workstream C)

## Date

2026-06-29

## Persona(s) adopted

AI/Gameplay engineer. The task is a careful, behavior-preserving refactor of the
behavior-tree AI provider, squarely in the `src/game/ai/` layer, gated on the
headless Floor 1 win-rate — so the AI/Gameplay persona's "behavior is sacred,
prove it with the sim" mindset fit better than a generic Producer split.

## Routing verdict

✅ right persona — single-layer, single-concern refactor with a clear behavior
gate; no cross-layer coordination needed.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — the three extractions were methodical and low-risk as
expected; the only surprise (an existing test reaching into the now-removed
private `hasClearLineOfSight`) was a one-edit fix.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

ai-behavior-tree

## What Was Done

Workstream C of the refactor fan-out: started safely decomposing the ~3990-line
`src/game/ai/bt-ai-provider.ts` (one giant stateful `BehaviorTreeAI` class)
**without changing AI behavior**. Stateful class methods were deliberately left
intact. Three in-layer extractions, all behind a behavior-identical facade (no
importer changes):

1. **`bt-ai-tuning.ts` (new)** — 78 pure tuning constants + `DEFAULT_CONFIG`,
   extracted by a script that slices exact line ranges so values are
   **byte-identical** (no hand-copy typo risk), re-imported into the provider.
2. **`scoring.ts`** — relocated the already-pure, already-tested
   `computeFloorProgressScore` (+ `QUEST_PROGRESS_SCORE_WEIGHT`); re-exported
   from `bt-ai-provider.ts` so `tests/game/floor-progress-score.test.ts` is
   untouched.
3. **`bt-ai-geometry.ts` (new)** — extracted the pure `hasClearLineOfSight` LOS
   sampler as a structurally-typed free function; 6 call sites now pass
   `world.floorMap`. New `tests/game/bt-ai-geometry.test.ts` (fast-check
   properties + corner-cut/wall unit tests). Adapted the duplicate corner-cut
   assertion in `behavior-tree-ai.test.ts` to call the extracted function.

`bt-ai-provider.ts` dropped ~378 lines net; the public surface
(`BehaviorTreeAI`, `computeFloorProgressScore`, `AINavigationDebug`/
`AINpcMemoryDebug`/`AILockedDoorMemory`) is unchanged.

## What's Next

- **Continue the decomposition** in follow-up passes: the remaining bulk is the
  stateful `BehaviorTreeAI` class (~565→end). Candidate next-safe extractions:
  more pure geometry/vector/angle helpers (kiting/standoff math) that don't read
  `this`, ideally consolidated alongside `bt-ai-geometry.ts`. Each move must be
  proven by the headless win-rate gate.
- Do **not** attempt to break apart stateful methods without a per-extraction
  win-rate re-run; that is the only behavior proof.

## Blockers

None. PR open with auto-merge armed; it will land when required CI checks pass.

## Branch State

- Branch: `nalfeo-bt-ai-provider-extract`
- All tests passing: yes (full `npm run verify` green, incl. headless gate + build)
- PR created: yes — https://github.com/nalfeo/Crawler/pull/485 (auto-merge
  `--squash` armed)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` not present this session.

## Test Results

Full `npm run verify` passed end-to-end:

- Steps 1–6: typecheck, lint, format, unit, build, integration — all green.
- Step 7/8: **Headless Floor 1 completion gate — 17/17 tests, 2/2 files passed**
  (the lone "player health reached zero" log line is one expected seed death;
  the gate asserts win-RATE and passed). This is the behavior-preservation proof.
- Step 8/8: production build succeeded.

`npm run verify:fast` also green (60 unit tests, 6 changed files linted).

## Key Decisions Made

- **Programmatic slicing over hand-copy** for the tuning constants — a silent
  value typo in a tuning const would corrupt the win-rate gate; slicing exact
  byte ranges removes that risk entirely.
- **Structural typing for `hasClearLineOfSight`** (`LineOfSightMap` shape rather
  than importing concrete `FloorMap`) so the pure function is unit-testable with
  a tiny fake grid instead of constructing a full tile map + room graph.
- **Kept the diff inside `src/game/ai/`** (one layer) so the pr-preflight ADR
  guard does not trigger; no ADR required.
- **Left the stateful class intact** this pass — decomposing instance methods is
  too risky to do in one session without per-step behavior proofs.
