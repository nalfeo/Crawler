# Session Handoff: Unify visual/headless simulation pipelines (issue #663)

## Date

2026-07-11

## Persona

Engineer

## Systems touched

enemies, weapons, ci-policy

## Apples

2🍎 exact

## What Was Done

Resolved the two known ordering divergences between the visual and headless
simulation pipelines (issue #663):

1. **`weaponSystem` position**: ran post-movement in headless, pre-movement in
   visual. Fixed — now pre-movement in both.
2. **`floor1EnemyDirectorSystem` position**: ran post-core in headless, pre-core
   in visual. Fixed — now pre-core in both.
3. **Single source of truth**: `src/game/ai/simulation-step.ts` is now a pure
   ECS core pipeline (no hardcoded game systems). `src/game/ai/headless-runner.ts`
   builds `mergedPreSystems`/`mergedPostSystems` from
   `createFloorMainSceneOptions(mergedConfig.floorId)`, so both visual and headless
   derive their ordering from the same definition.
4. **`level_up` reset**: moved out of the headless step body and into
   `headless-runner.ts` (before each step call), mirroring `MainGameScene.update()`
   which resets state between frames in the visual game.
5. **Contract tests added**: `tests/unit/headless-runner-pipeline-wiring.test.ts`
   guards the structural wiring (import + no-hardcode). The pipeline-parity
   ordering invariants (`weaponSystem` + `floor1EnemyDirectorSystem` in `preSystems`)
   are added to `tests/game/floor1-main-scene-options.test.ts`. Covers true
   `spawnerSystem → floor1EnemyDirectorSystem` adjacency (restored in both pipelines).
6. **Collision-pair parity fingerprints re-baselined**: The pipeline reordering
   changes combat cadence in the first 1500-frame headless slice. The new values
   are deterministic (two-invocation stability check passes).
7. **All affected tests updated**: 10+ test files updated to pass canonical
   `preSystems`/`postSystems` explicitly since the step no longer hardcodes them.

Observed in headless: `npm run test -- --project headless` passes all 21 test
files; the Floor 1 win-rate gate (`floor1-completion.test.ts`) is green with
the new pipeline ordering.

## Key Decisions Made

- **Strip-and-inject vs. conditional override**: Chose to fully strip all game
  systems from `simulation-step.ts` rather than conditionally skipping/overriding
  specific ones. This makes the contract explicit — callers must always pass
  canonical systems — and prevents silent drift.
- **Canonical systems merged with caller's simulationOptions**: In
  `headless-runner.ts`, the caller's `config.simulationOptions.preSystems` are
  appended AFTER canonical ones (not replacing them), so tests can inject extra
  instrumentation without losing the real pipeline.
- **`meleeBroadPhase`/`beamBroadPhase` passed explicitly** (not spread from
  simulationOptions) to avoid double-injecting pre/post systems if the caller
  also passes them via `simulationOptions`.
- **TypeScript narrowing workaround**: After the `if (world.state !== 'playing') throw`
  guard, TypeScript narrows `world.state` to `'playing'`. The `level_up` reset
  uses `readRunState(world)` (a helper already in the file) to bypass this.
- **Arena lockin tests now use canonical preSystems**: `spawnerArenaSystem` is
  needed to transition `arenaState → 2` when a spawner dies. The old tests only
  had `weaponSystem` in preSystems because the old headless step had
  `spawnerArenaSystem` hardcoded. Updating to canonical preSystems was the correct
  fix.

## What's Next / Blockers

- The broad seed sweep (>10 seeds) should be run via GitHub `workflow_dispatch`
  to re-measure win rate after the pipeline change. The local Floor-1 gate
  (`floor1-completion.test.ts`) is green, but a full sweep confirms no
  regression in ambient-spawn timing that the single-frame effects could amplify
  with future tuning.
- The `statusEffect-pipeline-parity.test.ts` comment was updated to document
  the new contract ("both pipelines receive statusEffectSystem via preSystems"),
  but there is no end-to-end test that exercises the FULL canonical preSystems
  in the visual pipeline. The visual pipeline is covered by manual observation
  per rule #10; a future session could automate this.

## Retrospective

### Lessons Learned

- **`spawnerArenaSystem` was the hidden dependency**: The arena lockin tests only
  had `weaponSystem` in preSystems. The spawner's HP reached 0 fine, but
  `arenaState` never transitioned to 2 because `spawnerArenaSystem` (which
  performs that transition) wasn't running. The debug trace (`spawner HP 120 → 30
after 200 frames`) was the key signal — damage was happening, but the state
  machine wasn't advancing.
- **Source-string guards are a fast, zero-runtime way** to lock structural wiring
  invariants (which function a caller must import and use). Preferred over
  runtime tests for pure structural constraints.
- **The `level_up` reset position matters**: In the old headless step, the reset
  happened INSIDE the step (between abilitySystem and floorObjectiveSystem). The
  new position (before each step in the runner) means objectives latch one frame
  later. The simulation-step.test.ts had to be updated to reflect the two-frame
  behavior. This is actually MORE faithful to the visual game.

### Mistakes Made

- Initially tried `preSystems: [statsSystem, statSystem, weaponSystem]` for the
  arena lockin tests without `spawnerArenaSystem`. The spawner was slowly taking
  damage but `arenaState` never reached 2, causing a timeout failure. Should have
  checked `spawnerArenaSystem`'s role earlier by tracing what changes `arenaState`.
- The source-string contract test initially checked `not.toContain('weaponSystem')`
  but the JSDoc comment in `simulation-step.ts` mentions `weaponSystem` as an
  example. Changed to check for actual call sites (`weaponSystem(world)`) instead.

### Opportunities for Future Improvement

- The `floor2-victory-pipeline.test.ts` uses an inline `postSystems` closure
  (`(w) => w.floorObjectiveTick?.(w)`) rather than importing canonical postSystems.
  A future cleanup could import `createFloor2MainSceneOptions()` if one is added,
  to stay fully canonical.
- Consider a CI check that runs the Floor 1 win-rate gate with 50+ seeds on every
  PR that touches `simulation-step.ts` or `headless-runner.ts`. Currently only the
  15-seed local gate runs.
