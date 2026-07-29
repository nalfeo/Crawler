# Session Handoff: Engine — MainGameScene god-class decomposition

## Date

2026-06-29

## Persona(s) adopted

**Engine** lens (primary) — the deliverable is a behavior-preserving structural
decomposition of an engine god-class, reading/threading the ECS pipeline and
Phaser-facing scene state. No new gameplay, so not Game/Designer; no new test
infra design beyond coverage for what was extracted, so not QA/Tester.

## Routing verdict

✅ right persona — "carve a focused module out of a 2331-LOC engine scene without
changing behavior" is squarely the Engine lens.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — new module + helpers module, 7 files, tests required, no ADR
(single-layer src/engine). Two small unplanned items (a latent prototype-key bug
caught by my own fast-check, and two pre-existing e2e flakes) were one-liners and
did not move the needle off Medium.

Hello kitties: 3/5 = 0.60 🎀

## Context

WAVE 2 child session, orchestrated alongside a sibling decomposing
`PhaserBridge` in parallel. Safety net = Session E's deterministic
characterization guards (PR #490, on main):

- **headless Floor-1 win-rate gate** (`tests/headless/floor1-completion.test.ts`)
  — proves the ECS pipeline order/args are unchanged. This is the marquee
  behavior-preservation proof.
- **e2e `main-game-scene-boot.test.ts`** — proves boot wiring + camera-follow.
- Source-parsing unit guards that `readFileSync` MainGameScene.ts and assert
  structural invariants (pause early-return, decrement seam, normal-sync triple,
  public surface, preserved consts).

Disjoint ownership respected: did NOT touch `src/engine/PhaserBridge.ts`,
`src/engine/phaser-bridge/*`, `src/core/map/*`, `tests/unit/phaser-bridge*`,
`tests/fixtures/phaser-bridge-harness.ts` (sibling/other sessions own those).

## What Was Done

### 1. Marquee — extract the ordered ECS pipeline (`runSimulationStep`)

`MainGameScene.update()` inlined the entire ordered ECS system pipeline
(~24 systems) plus the paused single-step bookkeeping. Extracted verbatim into:

- **NEW `src/engine/sim/simulation-step.ts`** —
  `runSimulationStep(world, inputState, hooks)`. Call order + arguments are
  byte-identical to the former inline body. `collisionSystem` is run once and its
  result threaded into `damageSystem/areaDamageSystem/trapSystem/itemPickupSystem`
  within the step. Single-layer: imports only `src/core` + `src/shared`, so **no
  ADR** required.
- The pause-step drain (`if (simulationPaused && pendingSimulationSteps > 0) {
pendingSimulationSteps = max(0, n-1); accumulator = 0 }`) is interleaved between
  `preSystems` and `movementSystem` in the original. To keep the order
  byte-faithful, it is injected via an **`afterInput` hook** that fires at exactly
  that seam — the scene keeps ownership of its `this.*` step state.
- `update()` now constructs the hooks object (`preSystems`, `postSystems`,
  `afterInput`) and calls `runSimulationStep`. The surrounding per-frame loop
  (accumulator, `inputCaptureOverride` re-poll at `steps > 0`, sessionRecorder
  telemetry, `state !== 'playing'` break, accumulator clamp, and the
  post-loop `updateDoorOverlay → updateLightingOverlay → bridge.sync(...)` triple)
  is unchanged.

### 2. Lift 6 pure private methods to module scope + tests

**NEW `src/engine/scenes/main-game-scene-helpers.ts`** with the 6 former private
methods, `this.*` reads replaced by explicit params:

- `getFloorRunOutcome(world)`
- `areLightingRectsEqual(a, b)`
- `getLightingViewRect(field, worldView)` (+ exported `LIGHTING_VIEW_BUFFER_PX`)
- `resolveNpcQuestIndicatorState(defId, world, controllers)`
- `formatAbilityTrigger(abilityId)`
- `resolveDialogueLines(defId, world, deps)`

All 9 call sites in MainGameScene rewired; now-unused imports pruned
(`buildDirtyRectFromPixelBounds`, 7 dialogue constants,
`FLOOR1_LEAVE_FLOOR_QUEST_ID`, the inline `LIGHTING_VIEW_BUFFER_PX` const) and the
23 pipeline-only system imports removed (`fovSystem` kept — still used in
`create()`).

**NEW `tests/unit/main-game-scene-helpers.test.ts`** (19 tests) — unit +
fast-check coverage for all 6 helpers, using the canonical
`createTestWorld()` + `spawnPlayer()` + `initializeFloor1Scenario()` floor setup.

**NEW `tests/unit/simulation-step.test.ts`** (5 tests) — pins the extracted
module's hook contract directly: `preSystems → afterInput → postSystems` ordering,
the seam fires exactly once, same-world identity, no-hooks tolerance, and a real
Floor-1 smoke step.

### 3. Tightly-coupled latent bug fix (`formatAbilityTrigger`)

My fast-check property test caught a real latent type-safety bug in the code being
lifted: `formatAbilityTrigger` looked up an **object literal**
(`triggerText[abilityId] ?? 'Auto trigger'`), so junk ids that collide with
inherited `Object.prototype` keys (`'valueOf'`, `'toString'`, `'constructor'`, …)
returned the inherited Function instead of falling back. Switched to a `Map`, which
has no string-key prototype chain. **Output is identical for every real ability
id** (`fireball`/`heal`/`pulse-shield` and all other unknowns) — this only fixes
the junk-input type violation. Fixed per repo rule #8 (coupled latent bug in code
being changed) and the code-change rule on tightly-coupled bugs.

### 4. Opportunistic e2e flake hardening (pre-existing)

While running `npm run test:e2e`, `minimap-overlay.test.ts` timed out at the
`page.goto(..., { waitUntil: 'networkidle' })` step. Three isolated re-runs failed
on **three different tests**, every time on the identical `page.goto` networkidle
30s timeout (never an assertion) — a definitively-proven pre-existing flake: the
`ux-snapshot-lab` keeps a Vite HMR socket + sprites-sidecar polling open, so
`networkidle` never reliably settles. The repo's own robust helpers
(`tests/e2e/helpers/ui-probe.ts`, `main-scene-probe.ts`) already moved off
`networkidle` to `waitUntil: 'commit'` for exactly this reason. Applied the same
one-line fix to the two stragglers (`minimap-overlay.test.ts`,
`hud-overlap-visual.test.ts`); the canvas `waitForSelector` + settle that follow
preserve each test's exact assertions. After the fix the previously-flaky
"teal floor tiles" test dropped from ~95s to ~15s and the full suite is stable.

### Deferred / N/A

- **Task 3 (lighting cluster extraction)** — DEFERRED. `updateLightingOverlay`
  and the `setLightingPreset/Config`/`rebuildLightField` cluster are stateful and
  unguarded; only their 2 pure helpers (`areLightingRectsEqual`,
  `getLightingViewRect`) were lifted in Task 2. Not cleanly behavior-preserving to
  move the stateful parts without first extending the probe — out of scope here.
- **Task 4 (move high-risk unguarded behavior)** — N/A. Did not move
  `shutdown()` teardown, display-list depth/sort, or input wiring, so no probe/e2e
  guard extension was needed this session.

## Verification

- `npm run verify` — ✅ green: typecheck + lint + format, **2698 unit tests
  (238 files)**, **49 integration (+1 skipped)**, **headless Floor-1 completion
  gate 17/17** (behavior-preservation proof), build.
- `npm run test:e2e` — ✅ green: **25/25 (6 files)**, including E's
  `main-game-scene-boot.test.ts` (boot wiring + camera-follow) and the hardened
  minimap/hud visual tests.
- Public surface confirmed byte-identical vs `HEAD` (constructor, create, update,
  requestInventoryToggle/requestEquipAction/requestAchievementsToggle/
  isInventoryOpen, `static readonly KEY = 'MainGameScene'`).

## Behavior-preservation argument

The ECS pipeline order/args are unchanged (verified verbatim against
`git show HEAD:...` and proven by the headless win-rate gate). The paused
single-step seam is preserved exactly via the `afterInput` hook. The lifted
helpers are pure and pinned by new unit/property tests. `formatAbilityTrigger`'s
output is unchanged for every reachable input. All of Session E's guards stay
green. Net: no observable behavior change.

## Files

| File                                           | Change                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/engine/sim/simulation-step.ts`            | NEW — extracted ECS pipeline (`runSimulationStep`)                                                        |
| `src/engine/scenes/main-game-scene-helpers.ts` | NEW — 6 lifted pure helpers                                                                               |
| `src/engine/scenes/MainGameScene.ts`           | update() rewired to `runSimulationStep`; 6 methods removed; call sites rewired; imports pruned (−159 net) |
| `tests/unit/simulation-step.test.ts`           | NEW — hook-contract + smoke coverage                                                                      |
| `tests/unit/main-game-scene-helpers.test.ts`   | NEW — unit + fast-check coverage                                                                          |
| `tests/e2e/minimap-overlay.test.ts`            | flake fix: `networkidle` → `commit`                                                                       |
| `tests/e2e/hud-overlap-visual.test.ts`         | flake fix: `networkidle` → `commit`                                                                       |

## Follow-ups (next session)

- **Lighting cluster (Task 3)**: extend `window.__mainSceneProbe` to expose the
  lighting overlay state, add a deterministic e2e guard pinning it, THEN extract
  `setLightingPreset/Config` + `rebuildLightField` + `updateLightingOverlay` into a
  focused helper. (E's explicit guidance: extend the probe rather than reaching
  into new privates ad hoc.)
- **High-risk unguarded behavior (Task 4)**: same pattern — guard first, then move
  `shutdown()` teardown / display-list depth ordering / input wiring.
- Consider lifting more pure read-model helpers (objective markers, overlay text)
  as further low-risk slices.
