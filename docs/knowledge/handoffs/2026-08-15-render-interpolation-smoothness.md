# Session Handoff: Render between fixed sim steps (game felt laggy / not smooth)

## Date

2026-08-15

## Persona

Perf Optimizer (rendering smoothness slice)

## Systems touched

hud-ux, vfx

## Apples

2🍎 estimated, 2🍎 actual (🎯 on target — engine-only render fix, 2 source files + 1 test file)

## What Was Done

Issue #2945 ("the game feels laggy and not smooth when playing") was **not** a
throughput problem — it was missing render interpolation.

`MainGameScene` simulates on a fixed `GAME.DELTA_MS` (60 Hz) accumulator but
renders on rAF. Every rendered frame called `this.bridge.sync(this.world)`,
which defaults to `interpAlpha = 0` and `renderElapsedMs = world.elapsedMs`, and
`updateCamera()` centred on the raw fixed-step player position. Because rAF
frames never line up exactly with the 16.67 ms step, a rendered frame advanced
the world by 0, 1 or 2 steps — the world moved in whole-step jumps rather than
with wall-clock time. `PhaserBridge.sync(world, renderElapsedMs, interpAlpha)`
has supported interpolation all along and `weapon-lab`/`gore-lab` already passed
it; only the shipped game path skipped it.

Landed:

- `renderInterpolationAlpha(accumulatorMs, stepMs)` and
  `extrapolateRenderPosition(position, velocityPerStep, alpha)` in
  `src/engine/scenes/main-game-scene-helpers.ts` — pure, unit-tested (including
  fast-check properties). Alpha is clamped to `[0, 1]`.
- `MainGameScene.update()` syncs the bridge with that alpha and
  `world.elapsedMs + alpha * GAME.DELTA_MS` on the live gameplay path.
- `updateCamera()` follows the **same** extrapolated player position the bridge
  draws the player sprite at, so the player stays pinned to screen centre.
- Alpha resets to `0` before every frozen branch (pause, modals, dialogue,
  level-up, map overlay, reward opening) — those frames render exactly as before.

Render-side only: no world state is read or written differently, so the sim
fingerprint, headless runner, and win-rate gates are untouched.

**Observed in the running artifact** (real `MainGameScene` booted through the
shipped floor bootstrap, simulation running, held `ArrowRight`, camera centre
sampled every rAF) — per-frame camera delta in px:

- **Before:** `0.0000` ×10, `3.2080` ×37, `6.4160` ×4, `9.6240` ×5, `12.8320` ×3
  — every delta an exact integer multiple of one sim step, flipping between 1
  and 4 steps at near-identical frame times. That quantization _is_ the judder.
- **After:** deltas vary continuously with frame time (`3.8496`, `4.8107`,
  `5.7757`, `6.7368`, `7.6979`, `8.6629`, `9.3026`, `10.2656`, `11.2287`,
  `12.1917`, …).

The shipped game itself (`index.html` on the dev server) was also booted, taken
through the intro + loadout into gameplay and moved: renders correctly, zero
page errors.

## Key Decisions Made

- **Reused the existing bridge contract** instead of inventing a new render
  path. `interpAlpha` already existed and the labs already used it, so the fix
  is "wire the shipped game to the same seam the labs use", not a new mechanism.
- **Velocity extrapolation, not previous-position interpolation.** True
  interpolation between the two last steps would be marginally smoother on hard
  stops but adds a full step of input latency and a per-entity previous-position
  buffer. The codebase already chose extrapolation (`position + velocity *
alpha`), and worst-case error is one step of player speed (0.375 ft = 3 px).
- **Camera must use the identical expression as the sprite.** Interpolating
  sprites while the camera stayed on the raw position would make the player
  slide around screen centre once per step — worse than the original judder.
- **Kept lighting on the raw (non-interpolated) player position.** The lighting
  recompute is gated on that position changing; interpolating it would force a
  full light-field recompute every frame for a sub-cell visual difference.
- **Scope discipline:** an exploration pass also surfaced small CPU hot spots
  (per-frame `Set`/`Map` allocation at the top of `PhaserBridge.sync`, an
  O(entities × bossBattles) boss lookup inside the sprite loop, the per-frame
  lighting cache-key string build, `Array.from()` in several core systems).
  None of them explain step-quantized motion, so they were deliberately left
  out of this change and are logged below instead.

## What's Next / Blockers

No blockers. Follow-up candidates, highest value first:

1. Cache a `Map<bossEid, bossKey>` per floor so `PhaserBridge.sync` stops
   scanning `floorScenario.objective.bossBattles` once per rendered enemy.
2. Hoist the per-frame `activeEntities` `Set` / `preferredTextureCache` `Map` in
   `PhaserBridge.sync` to instance fields that are cleared instead of
   reallocated.
3. Replace the lighting `secondarySourceKeyParts` array+`join('|')` string key
   with an incremental numeric hash (it is rebuilt every frame the player moves).
4. Drop the `Array.from()` wrappers around bitecs queries in
   `healthSystem` / `deathTimerSystem` / `spawnAnimSystem` /
   `projectileCleanupSystem` / `harvestSystem` where iteration is non-mutating.
5. There is still **no live frame-time HUD**. `fovComputeMsAvg` and
   `lightingComputeMsAvg` are already tracked on the scene but never surfaced;
   wiring them plus a frame-time EWMA into a debug panel would make "feels
   laggy" reports measurable instead of anecdotal.

## Retrospective

### Lessons Learned

- **The lab was ahead of the game.** `weapon-lab` and `gore-lab` passed
  `interpAlpha` for months while the shipped scene passed nothing. When a
  bridge/system API has optional quality parameters, grep for _every_ call site:
  a defaulted parameter silently degrades exactly one caller and nothing fails.
- **Playwright's headless-shell renders at ~15 fps here** (rAF deltas of 50–83 ms
  in this sandbox), so absolute FPS numbers from this environment are worthless.
  The _shape_ of the data is not: at 15 fps the pre-change per-frame camera
  delta was still an exact multiple of one sim step, which is the falsifiable
  signature of the bug and reproduces at any refresh rate.
- The `main-scene-probe-lab` + `getCameraCenter()` probe is the cheapest way to
  observe real `MainGameScene.update()` behavior from a script; it boots the
  scene through the shipped `createFloorGameConfig` bootstrap.
- Playwright browsers are not preinstalled in a fresh session — `npx playwright
install chromium` is needed before any e2e run.

### Mistakes Made

- While rewriting the `bridge.sync(...)` call I dropped the adjacent
  `this.resumePendingRewardPresentations()` line and had to restore it. Early
  signal: the diff for a "one-line" change touched more lines than expected.
  When replacing a call inside a dense sequence, match on the single line, not
  the line plus its neighbours.
- The first smoothness measurement showed zero camera movement because the probe
  lab boots with the simulation paused, and the second showed a near-zero mean
  because the player walked into a wall within a second. Sanity-check that the
  observable actually changes at all _before_ building statistics on top of it.
- I first asserted `renderInterpolationAlpha(Infinity, step) === 1` in a test;
  the function returns `0` for non-finite input by design. Read your own guard
  clause before writing the expectation.

### Opportunities for Future Improvement

- `MainGameScene` unit tests are mostly `readFileSync` + string matching because
  the class is Phaser-coupled. The pure-helper extraction pattern used here
  (`main-game-scene-helpers.ts`) is the escape hatch; continue moving branch
  logic out of the god-class so guards can assert behavior instead of source text.
- A deterministic "motion is not step-quantized" e2e check would be the ideal
  permanent guard for this class of bug, but it needs a stable rAF cadence that
  CI's headless shell does not provide. Worth revisiting if a fixed-cadence
  render harness ever lands.
- Consider making `interpAlpha` a required parameter of `PhaserBridge.sync` so a
  future caller cannot silently opt out of interpolation again.
