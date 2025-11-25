# Session Handoff: Dynamic lab-testable FOV granularity + discovered-terrain darkening

## Date

2026-07-02

## Persona(s) adopted

**Producer** (lead) — the request spanned four layers (core ECS `FloorMap`/`fovSystem`,
engine `light-field` + a new `fov-config` bridge + `MainGameScene` API/telemetry, the
AI-runner lab, and docs/ADR), so it routed as a multi-layer feature rather than a
single-system change. The Producer coordinated the systems/engine implementation work
and drove the full 4-apple review harness.

## Routing verdict

✅ right persona — a multi-layer, ADR-touching feature with a review harness is exactly
the Producer's remit; no single specialist persona owned all of core + engine + labs + docs.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — scope matched: multi-system change + ADR amendment + lab tooling +
the full 4-apple review harness (dual-plan synthesis, plan review, 3-round multi-model
review with adjudication). The one review-surfaced defect (truth-in-labeling on the
sub-factor visibility invariant) was contained to docs + tests.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

ai-pathfinding

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-fov-dynamic-granularity.review-ledger.json`
Stages (4🍎, all required): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → **valid 4-apple ledger** (exit 0).

- **dual_plan_synthesis**: plans from gpt-5.5 + gemini-3.1-pro-preview, synthesized by judge claude-opus-4.8.
- **plan_review**: gpt-5.4 (rubber-duck) — 6 concerns (2 blocking), all 6 adopted (see `plan-synthesized.md`).
- **code_review + multi_model_review**: 3 rounds, models gpt-5.4 + claude-sonnet-4.6 + gemini-3.1-pro-preview,
  distinct adjudicator claude-opus-4.8. Looped until clean.

## What Was Done

Two bundled user requests, delivered together:

1. **Discovered-terrain darkening (dim, not black), default ON.** `FloorMap` gained a
   persistent `discovered` bitmap (set by `fovSystem` alongside `visible`).
   `computeLightField` renders discovered-but-not-currently-visible cells at a dim
   `discoveredLight` (`LightingConfig.discoveredLight`, default `0.05`, clamped to
   `ambient`; `0` reproduces legacy full-black). Explored terrain now persists as a dim
   "memory" on the fog overlay + minimap.

2. **Dynamic, lab-testable FOV granularity (down to 4px).** `FloorMap` gained an integer
   `subFactor` (default `DEFAULT_FOV_SUB_FACTOR = 2` = 16px, max `MAX_FOV_SUB_FACTOR = 8`
   = 4px) replacing the hardcoded ×2. `fovSystem` scales its radius and `lightPasses`
   mapping by the factor, so **vision range in feet is unchanged** at any factor. New
   engine `fov-config.ts` bridges the pixel-facing `cellPx` (lab UI) to the core integer.
   `MainGameScene` exposes a FOV debug API with per-frame EWMA perf telemetry
   (`runFovSystem` hook on `SimulationStepHooks`). The AI-runner lab gained a "FOV" folder
   (preset buttons 32/16/8/4px + sub-factor slider + Perf subfolder), mirroring the
   existing lighting-config pattern.

- **ADR-0034** amended (2026-07-02): finer FOV is now opt-in (was rejected on perf grounds
  in the original); benchmarks show even 4px costs <0.3ms/frame + ~2MB on a real floor-1
  map. Documents the precise visibility guarantee and the `setSubFactor` discovered-reset.
- Fixed 3 pre-existing sprite typecheck errors surfaced by the touched build
  (`asset-queue.test.ts`, `issue-pipeline.test.ts`).

## What's Next

- Nothing required for this feature. Optional future polish: a lab toggle to visualize the
  discovered-vs-visible boundary, and promoting the FOV perf EWMA into a headless perf gate
  if finer factors ever ship by default.

## Blockers

None.

## Branch State

- Branch: `nalfeo-reimagined-invention`
- All tests passing: yes (unit 2856/2856, integration ✓, headless ✓ incl. floor1 win-rate gate, build ✓)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` does not exist this session.

## Test Results

- `npm run verify:fast` → ✅ (typecheck + lint + 612 changed unit tests)
- `npm run test:unit` → ✅ 2856 passed / 0 failed
- `npm run verify` (full) → ✅ (see final run in session: typecheck, lint, format, unit/integration/headless, pr-prereqs, build)
- `bash scripts/agent/lab-gate-check.sh` → ✅
- Observe-before-done (deterministic): `tests/headless/fov-discovered-darkening.test.ts`
  pins black at `discoveredLight=0` → dim at `0.05`. FOV divergence pinned in
  `tests/ecs/fov-system.test.ts` (interior-identical + radius-boundary + occlusion-edge).

## Key Decisions Made

- **Default frozen at subFactor=2.** `setSubFactor(2)` is an early-return no-op, so shipped
  gameplay is byte-identical to pre-amendment behavior; finer factors 3–8 are **lab-only**.
- **Remedy B over decoupling** (adjudicated by claude-opus-4.8). Multi-model review correctly
  found that tile-level `isVisible(tx,ty)` is **not** globally identical across `subFactor` —
  it diverges by ~1 tile at the vision-radius boundary and at occlusion/doorway edges (interior
  is byte-identical; finer ⊆ coarser). We chose to **document the precise guarantee honestly +
  pin both divergences with tests**, rather than decouple gameplay perception from the fog knob
  (which would make the finer setting cosmetic-only — defeating the user's "testable finer
  granularity" ask — and introduce a worse doorway mismatch in core). The over-broad "identical
  at any factor" claim in the ADR + a vacuous test were the only real defects, both fixed.
- **`setSubFactor` resets discovered memory by design.** Every caller immediately recomputes
  FOV + rebuilds the light field, so no stale/black frame results. Documented in ADR §2.

## Retrospective

### Lessons Learned

- **`verify:fast` runs only _changed_ test files.** I renamed a call in `MainGameScene.ts`
  that a _different_ test file (`main-game-scene-lighting-overlay.test.ts`) asserts on via a
  source-structure grep; `verify:fast` never ran it, so the break only showed in the full
  `npm run test:unit`. **Always run full `test:unit` before PR, not just `verify:fast`.**
- **Reviewer diffs: insist on three-dot.** A round-3 reviewer ran two-dot `git diff main`,
  which inverts main's newer commits and made an advanced-main `ci.yml` rework look like a
  regression in this branch. Verified via `git diff main...HEAD` (empty for `.github/`) +
  `git merge-base` that the branch does not touch `ci.yml`. When a reviewer flags a file
  outside your feature, check three-dot diff / merge-base before "fixing" it.
- **A watch-shaped hardcoded constant hides real invariance limits.** The original "quarter-tile
  is identical to any finer factor" intuition was false at boundaries; only an empirical run of
  the real `fovSystem` exposed it. Pin behavior you _claim_, don't assert it in prose.

### Mistakes Made

- Over-trusted the initial "tile visibility is invariant across subFactor" framing and wrote a
  test whose name over-promised it. Early signal I ignored: I couldn't actually construct a map
  where the assertion could _fail_, because the test used a fully-open map (no radius/occlusion
  edges in view). A test that _cannot_ fail is a smell — that was the tell.
- Left an internal ADR contradiction (§2 "cleared only on floor change" vs the `setSubFactor`
  reset note) after the first doc pass; caught in round 2. Re-read the _whole_ doc for
  consistency after inserting a carve-out, not just the edited paragraph.

### Opportunities for Future Improvement

- The review-harness code-review agents would benefit from an explicit instruction to use
  **three-dot** `git diff <base>...HEAD` so they never mistake an advanced base branch for the
  change under review.
- Consider a tiny helper in `tests/helpers` for "open map with a wall/doorway" so FOV divergence
  pins don't hand-roll wall painting per test.
