# Session Handoff: Engine characterization guards (PhaserBridge + MainGameScene)

## Date

2026-06-29

## Persona(s) adopted

**QA/Tester** (primary) — the deliverable is additive, deterministic test
infrastructure (characterization guards), not a feature or refactor. Light
**Engine** lens to read the two god-classes and design the minimal probe seam.

## Routing verdict

✅ right persona — the task is squarely "pin current behavior with deterministic
checks before someone refactors," which is QA/Tester's wheelhouse.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — N/A. Multi-layer test infra (shared fixture extraction + a
unit characterization suite + a new probe lab + an e2e suite), 7 files, no new
ECS system or pipeline. Landed at the predicted medium size.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

This is the **WAVE 2 / workstream E PRECURSOR**: it adds DETERMINISTIC
characterization guards that pin the CURRENT observable behavior of the two
engine god-classes so a FUTURE session can decompose them and prove
equivalence. **No production code behavior changed** — this is additive test
infrastructure only.

### PhaserBridge (`src/engine/PhaserBridge.ts`, ~1336 LOC) — in-process unit guards

- **Extracted** the shared mock-scene harness (`MockImage`, `createSceneStub`,
  `createBridgeTestMap`) out of `tests/unit/phaser-bridge.test.ts` into
  `tests/fixtures/phaser-bridge-harness.ts` and rewired the existing 19-test
  suite to import it. Behavior-preserving: the existing suite still passes
  unchanged (verified the reconstruction matched the original line-for-line).
- **Added** `tests/unit/phaser-bridge-characterization.test.ts` (6 tests) with
  5 NON-duplicative create/sync/teardown contracts a decomposition will touch:
  1. feet→pixel mapping is symbolic via `ftToPx` (parametric across positions,
     not a hard-coded magic number).
  2. exactly 1:1 entity→image mapping for a MIXED world (player + 2 enemies +
     gem + gold), with per-type discrimination intact.
  3. idempotent re-sync — a second `sync()` on an unchanged world creates no
     duplicate visuals and destroys nothing.
  4. selective teardown — removing one entity destroys only its visual while
     survivors keep the same `MockImage` instance identity and positions.
  5. `destroy()` tears down EVERY live visual at once and clears the maps.

### MainGameScene (`src/engine/scenes/MainGameScene.ts`, ~2331 LOC) — e2e guards

- **Added** a dedicated probe lab `src/labs/main-scene-probe-lab/index.ts` that
  boots the REAL scene through the shipped bootstrap
  (`createFloor1GameConfig` + `createFloor1MainSceneOptions`) with a FIXED
  `worldSeed` (4242), and exposes a typed `window.__mainSceneProbe` automation
  API (boot facts, `resolveLoadout`, freeze sim, `setPlayerFeet`, camera/map
  reads). Registered in `src/lab-main.ts` `LAB_MODULE_PATHS`. The probe reads
  the scene's runtime fields via a structural cast — MainGameScene members are
  TS `private` (not `#private`), so they're runtime-readable (mirrors
  `ai-runner-lab`); **no engine source was modified.**
- **Added** `tests/e2e/main-game-scene-boot.test.ts` (2 guards) +
  `tests/e2e/helpers/main-scene-probe.ts`:
  1. **Boot wiring** — booting the real scene spawns a world + player, wires the
     entity→sprite bridge and the HUD, opens the loadout modal, populates the
     Phaser display list, and reports `worldState === 'loadout'`.
  2. **Camera-follow invariant** — after the loadout resolves (state → playing,
     sim frozen), the main camera centers on the player at `ftToPx(playerFeet)`
     and the camera-center DELTA equals `ftToPx(Δfeet)` across two player
     positions (proves the linear 1:1 follow with no smoothing/deadzone).

### Determinism notes (how flake was engineered out)

- Fixed `worldSeed`; assertions use exact integer feet and compute expected
  pixels with the shipped `ftToPx` — no `Math.random`/`Date.now` in any assert.
- The camera guard exploits the scene's `simulationPaused && pendingSimulationSteps <= 0`
  branch: it runs `updateCamera()` every frame but skips the sim loop, so the
  player only moves when the test teleports it.
- Camera reads use `worldView.centerX/centerY` (zoom/DPR-invariant) with a 2px
  tolerance for render-time pixel rounding.
- Player teleports target the MAP CENTER so the camera is provably unclamped by
  the bounds the scene installs (`setBounds(0,0, ftToPx(w), ftToPx(h))`); the
  test asserts map > viewport before sampling so a shrunk map fails loudly
  rather than flaking.

## Safety envelope for the decomposition session

### ✅ Now GUARDED (a decomposition must keep these green)

**PhaserBridge:**

- feet→pixel units boundary is `ftToPx` (symbolic, position-parametric).
- 1:1 entity→image creation for a heterogeneous multi-entity world, with
  per-type discrimination (player / rat / slime / gem / gold).
- idempotent re-sync (no duplicate creation, no spurious teardown).
- selective teardown preserves survivor visual identity + position.
- `destroy()` tears down all live visuals and clears bookkeeping maps.
- (Plus everything the PRE-EXISTING 19-test suite already covers: per-type
  texture selection, FOV hiding of enemies, gem/gold bob + shadow lifecycle,
  interpolation alpha, etc. — still green via the extracted harness.)

**MainGameScene (e2e):**

- Boot wiring: world+player created, bridge wired, HUD wired, loadout modal
  open, display list populated, `worldState === 'loadout'`.
- Camera-follow invariant: center == `ftToPx(playerFeet)` and delta ==
  `ftToPx(Δfeet)` (linear follow, no deadzone/smoothing).

### ❌ Still UNGUARDED (decomposition must add coverage or proceed carefully)

**PhaserBridge:**

- `sync()` AFTER `destroy()` (rebuild path) — deliberately NOT tested because
  `destroy()` tears down VFX subsystems; characterizing rebuild risks pinning
  accidental behavior. Treat as undefined until specified.
- Beam/arc/harvest/death-marker VFX bookkeeping is only indirectly covered.

**MainGameScene (the big gaps):**

- HUD element anchoring/layout/positions (only HUD PRESENCE is guarded, not
  geometry — `tests/e2e/hud-overlap-visual.test.ts` covers some HUD overlap via
  a different lab, but not MainGameScene's own wiring).
- Input wiring (keyboard/pointer → player intent, modal interactions).
- Display-list DEPTH/sort ordering of sprites.
- Scene `shutdown()`/teardown (does it destroy the bridge, HUD, cameras, RTs?).
- Camera zoom behavior: `updateSafeRoomZoom()` tween targets, render-scale, the
  UI camera. Only the worldView CENTER is guarded; zoom magnitude is not.
- Terrain layer build (`buildTerrainLayer`), minimap baking from this scene.
- The bulk of `update()` branch logic (state machine transitions: loadout →
  playing → boss → stairs → game_over), advance-frames stepping, pause/resume
  edge cases beyond the single freeze path used here.
- Boss bar / floor timer / objective HUD driven by this scene.

## What's Next

- The decomposition session (MainGameScene / PhaserBridge split) can now refactor
  with these guards as the equivalence net. Run `npm run verify` +
  `npm run test:e2e` after each extraction step; the probe lab gives a stable
  seam to add MORE characterization guards cheaply (extend
  `window.__mainSceneProbe` rather than reaching into new privates ad hoc).
- Consider promoting the highest-risk UNGUARDED items above (shutdown teardown,
  depth ordering, input wiring) into additional probe-lab guards BEFORE moving
  their code, so each extraction is covered before it moves.

## Blockers

None.

## Branch State

- Branch: `nalfeo-engine-characterization-guards`
- All tests passing: yes (`verify:fast`, full `verify`, full `test:e2e`, and
  `lab-gate-check.sh` all green; e2e suite ran twice with no flake)
- PR created: yes (see PR opened from this branch; auto-merge armed
  `--auto --squash`)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — nothing to paste.

## Test Results

- `npm run verify:fast` → ✅ (typecheck + lint + 25 changed unit tests).
- `npm run verify` → ✅ (typecheck, lint, format, 50 unit/integration tests +
  1 skipped, headless Floor 1 completion gate, production build).
- `npm run test:e2e` → ✅ 25/25 across 6 files (incl. the 2 new MainGameScene
  guards); the new spec also passed in an isolated run — two clean passes, no
  flake.
- `bash scripts/agent/lab-gate-check.sh` → ✅ (new lab does not regress the
  system→lab coverage gate).

## Key Decisions Made

- **Black-box probes over source edits.** Reached MainGameScene's `private`
  runtime fields via a structural cast in the LAB (not the engine), so ZERO
  engine source changed. No testability seam was added to `src/engine`.
- **Camera guard rides the existing pause branch** for determinism instead of
  stepping the sim — freezes the player so the only motion is the test's own
  teleport, making the `centerOn(ftToPx(...))` contract observable without
  wall-clock coupling.
- **Map-center teleports** to stay provably inside camera bounds, with an
  explicit map>viewport precondition so a future map-size change fails loudly
  rather than silently clamping.
- **Extracted the bridge harness** to a shared fixture so the new
  characterization suite and the existing suite share one source of truth (and
  to keep the new file focused on contracts, not boilerplate).
- Deliberately left `sync()`-after-`destroy()` UNGUARDED (documented above)
  rather than pin behavior that may be accidental.
