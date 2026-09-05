# Spec: Floor 4 Playable Completion (seed 404, dual-runner)

> **Status:** this document is the **slice-1 acceptance contract** for the
> `floor-4-playable-completion` epic. Criteria **C1–C8 are met in both runners**:
> Floor 4 now leaves every intermission through the scenario-owned public
> confirmation contract, with the visual runner pressing the real MainGameScene
> modal and the headless runner calling the same scenario authority directly.
> Slices 3 and 4 are complete; **slice 2 needed no separate fix** (see §Verdict
> on the reported spawn discrepancy).
> **Authored:** 2026-09-02. **Contract table added:** 2026-09-03.
> **Estimated complexity:** 🍎🍎 (one confirmed, floor-agnostic engine defect + two
> regression tests + one additive debug-telemetry field; no gameplay/balance change).
> **Epic:** [`floor-4-playable-completion`](../../docs/knowledge/epics/floor-4-playable-completion/floor-4-playable-completion.epic.json),
> a focused follow-up to the already-materialized
> [`floor4-arena.md`](floor4-arena.md) spec.
> **ADR:** [2026-09-02-generated-sprite-animation-self-healing.md](../../docs/knowledge/adr/2026-09-02-generated-sprite-animation-self-healing.md).
> **Canonical home:** this spec is the completion-contract record; `floor4-arena.md`
> remains the living Floor 4 systemic contract (waves, Headliners, Green Room, HUD).
> **Test suites:** `tests/headless/floor4-arena-completion.test.ts`,
> `tests/e2e/floor4-ai-completion.deterministic.test.ts`.

## Contract

Per the epic: canonical deterministic seed **404**, direct floor4 start, must be
completable by the **production** `BehaviorTreeAI` in both:

1. the headless runner (`runHeadless`), and
2. the visual AI-runner lab's real `MainGameScene` (`ai-runner-lab`),

with no direct world-state mutation, invulnerability, forced enemy death, phase
skipping, test-only spawn path, or runner-only gameplay shortcut. Balance,
representative win rate, economy tuning, achievements, new content, and visual
polish are explicitly out of scope (user instruction; matches the epic's review
gate).

## Acceptance criteria — C1–C8 and their assertion map

This table is the **mapping of record** for the epic's slice-1 contract. Every
criterion the epic names has an id, and every id has a concrete assertion in
each runner. The two test files tag their assertions with these ids in
comments; keep the tags and this table in sync.

| Id     | Criterion (epic wording)                                                       | Headless assertion — `tests/headless/floor4-arena-completion.test.ts`                                                                                                                            | Visual assertion — `tests/e2e/floor4-ai-completion.deterministic.test.ts`                                                                                                                                                                                                                       | Status                  |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **C1** | the standard Floor 4 scenario initializes                                      | `timeline[0]` is `COUNTDOWN` with reason `floor4-initialized`; `headlinerCard` acts are `[1..5]`                                                                                                 | `effectiveFloor === 'floor4'`; `timeline[0]` is `COUNTDOWN` / `floor4-initialized`                                                                                                                                                                                                              | ✅ met                  |
| **C2** | at least one physical hostile wave enemy spawns through the authored feed-gate | `waveTelemetry.enemiesSpawned > 0` and `gateTelegraphsArmed > 0`                                                                                                                                 | `enemiesSpawned >= 200` and `gateTelegraphsArmed > 0`                                                                                                                                                                                                                                           | ✅ met                  |
| **C3** | all five wave windows release enemies                                          | `waveTelemetry.wavesReleased === 40` (manifest-derived full-release ceiling: `wavesPerAct(8) × acts(5)`, so no single act can satisfy it alone); timeline `WAVES` acts are exactly `[1,2,3,4,5]` | same two assertions off the lab's `floor4Arena` snapshot                                                                                                                                                                                                                                        | ✅ met                  |
| **C4** | all five Headliners physically spawn and are defeated through ordinary combat  | `headlinerTelemetry.spawned === 5`, `defeated === 5`, `overtimeStarted === 0`; timeline `HEADLINE` acts are `[1..5]`                                                                             | `spawned === 5`, `defeated === 5`, timeline `HEADLINE` acts are `[1..5]`, and the run reaches `VICTORY` without `game_over`; visual pacing may enter authored overtime, but no forced finisher/kill path may terminate the run                                                                  | ✅ met (see note)       |
| **C5** | each intermission resolves through its **public scenario/UI interaction**      | timeline `INTERMISSION` acts are `[1..5]`, `actIncome` acts are `[1..5]`, exit reasons are `public-green-room-exit` ×4 then `public-stairs`, all from `confirmFloor4StairDescend`                | same timeline/reason assertions, plus `floor4SurfaceTrace` proves the real `floor4-stair-descend` ModalPicker path opened, confirmed, and resumed five times                                                                                                                                    | ✅ met                  |
| **C6** | the phase trace reaches `VICTORY`                                              | `floor4Arena.phase.kind === 'VICTORY'` and the last timeline entry is `VICTORY`                                                                                                                  | polled `phase.kind === 'VICTORY'` from `window.__aiRunnerDebug()`                                                                                                                                                                                                                               | ✅ met                  |
| **C7** | `RunStats.outcome` is `victory`                                                | `stats.outcome === 'victory'`                                                                                                                                                                    | no `RunStats` exists in the visual runner; the equivalent is C6 — `isFloor4ArenaVictory` **is** `isVictoryReached`                                                                                                                                                                              | ✅ met (by equivalence) |
| **C8** | execution terminates under the existing Floor 4 stall backstop                 | `gameTimeMs < floor4.manifest.timer.durationMs` (3 600 000 ms) and `totalFrames < MAX_FRAMES`                                                                                                    | `gameMs < durationMs` — the raw `world.elapsedMs` clock (`window.__aiRunnerDebug().gameMs`), the same field `floor4ObjectiveTick` compares against the manifest deadline; NOT `floor4Arena.arenaElapsedMs`, which only advances during `WAVES`/`HEADLINE` and is capped well below the backstop | ✅ met                  |

Cross-cutting, asserted in both runners: **determinism** (headless repeats
byte-identical completion telemetry; the visual real-browser gate repeats the
required completion facts and public modal sequence) and, for the visual runner,
**zero page errors**.

**C4 note.** "Ordinary combat" is enforced structurally, not by a counter alone:
`resolveFloor4HeadlinerDefeat` only marks `defeated` on a genuine health-zero
kill. The headless seed still asserts `overtimeStarted === 0`; the visual runner
instead asserts terminal `VICTORY` with no `game_over`, because entering authored
overtime in the slower real scene is not itself a forced kill.

**C7 equivalence.** `ScenarioDefinition.isVictoryReached` for Floor 4 _is_
`isFloor4ArenaVictory` (`src/game/scenarioDefinitions.ts:686`), which is exactly
`phase.kind === 'VICTORY'`. Asserting C6 in the visual runner therefore asserts
the same predicate that produces headless `RunStats.outcome === 'victory'` —
without adding a lab-only outcome field, which slice 1 must not do.

**C5 note.** Acts 1–4 still use the lightweight authored break hold rather than
the full future Green Room shop transaction, but the transition out of every
break is now a public confirmation path: `confirmFloor4StairDescend` records
`public-green-room-exit` for acts 1–4 and `public-stairs` for act 5.

### Constraints on the two gates

Both tests use the production `BehaviorTreeAI`, the shared `ScenarioDefinition`,
the real simulation steps, and (for the visual gate) the real `MainGameScene`
driven only through the AI-runner lab's public controls. They may accelerate
deterministic simulation (headless frame stepping; the lab's own `#ai-speed-16`
button) but they do **not** mutate health/phase/objective state, grant
invulnerability, force kills, inject enemies, skip interactions, or add
test-only gameplay hooks. Neither test touches `src/**`.

The contract's shared literals — the five acts, the manifest-derived
wave-release ceiling, the manifest-derived stall backstop, and C5's public exit
reasons — live in `tests/helpers/floor4-completion-contract.ts` and are imported
by both gates, so a change to one criterion cannot silently loosen only one
runner.

## Slice 1 — Baseline (reproduce first)

### Headless baseline

Command: `BehaviorTreeAI` + `runHeadless({ seed: 404, floorId: 'floor4', ... })`
(the same pipeline as `npm run ai:headless -- --seed 404 --floor floor4`).

**Observed (recaptured 2026-09-03, unchanged from the original baseline):**

| Evidence field                          | Value                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `outcome`                               | `victory`                                                                                                 |
| `totalFrames` / `gameTimeMs`            | `36487` / `608116.67` ms (backstop is 3 600 000 ms)                                                       |
| `floor4Arena.arenaElapsedMs`            | `600000`                                                                                                  |
| `waveTelemetry`                         | `wavesReleased 40`, `enemiesSpawned 249`, `enemiesCut 101`, `debtDiscarded 23`, `gateTelegraphsArmed 133` |
| `headlinerTelemetry`                    | `spawned 5`, `defeated 5`, `chestsSpawned 5`, `chestsForceResolved 0`, `overtimeStarted 0`                |
| `actIncome`                             | 5 entries, acts 1–5                                                                                       |
| terminal timeline entry                 | `VICTORY` @ frame `36487`, reason `public-stairs`                                                         |
| phase-timeline fingerprint (17 entries) | `COUNTDOWN` → (`WAVES:n` → `HEADLINE:n` → `INTERMISSION:n`) × 5 → `VICTORY`                               |

Every `INTERMISSION → next phase` transition is logged with reason
`public-green-room-exit` (acts 1–4) or `public-stairs` (act 5 → `VICTORY`), both
recorded by `confirmFloor4StairDescend` after the authored intermission hold.

**First failed criterion (headless):** none after slice 4; C1–C8 pass.

**Conclusion:** headless already satisfies the "beatable" contract. No headless
runtime fix was required.

### Visual baseline (this is where the failure actually was)

Command: drive `ai-runner-lab` (`lab.html?lab=ai-runner`) via Playwright — select
Floor 4 + seed 404 through `#ai-run-target-select` / `#ai-seed-input` /
`#ai-run-apply`, then run production AI at `#ai-speed-16`.

**Observed (before fix):** selecting Floor 4 + seed 404 calls
`phaserScene.scene.restart()`. Restarting **immediately** (as any automated driver
does, and as the lab UI itself allows) reliably froze the render/update loop
within **1–16 frames**, with an uncaught
`TypeError: Cannot read properties of undefined (reading 'duration')` inside
Phaser's `Animation.getFirstTick`, thrown from inside `MainGameScene.update()`.
Confirmed **floor-agnostic** (reproduces on Floor 1 too — this was never a Floor 4
gameplay bug) and specifically triggered by fast `scene.restart()`, not by floor
choice or speed. This matches the epic review's noted "reported windowed behavior
is empty": the scene never got far enough to spawn anything — it froze at frame 1–16,
before the arena director's first tick.

**Root cause (confirmed against Phaser's real source,
`node_modules/phaser/src/animations/`):** `AnimationManager#generateFrameNumbers`
returns `[]` (only a `console.warn`, no throw) when the texture isn't yet
registered in the `TextureManager`. The project's own
`registerGeneratedSpriteAnimations` (`src/engine/generatedAssets/animations.ts`)
unconditionally called `anims.create({ frames: [], ... })` in that case,
permanently registering a broken zero-frame `Animation` under the walk-cycle key
in Phaser's **global, per-game** `AnimationManager` (not reset by scene restarts).
The very first `.play()` on that poisoned key crashed inside
`Animation#getFirstTick` (`state.currentFrame` undefined). Confirmed separately
that calling `.play()` on a key that was **never created at all** is safe in real
Phaser (`AnimationState.startAnimation` early-returns without setting
`isPlaying`) — this is what makes "skip creating, retry later" both correct and
safe.

This is a genuine load-order race between async generated-sprite texture decode
and Phaser's synchronous scene lifecycle — not a test artifact. A human clicking
through the lab UI happens to wait long enough to avoid it; any automated driver
(and thus this epic's own e2e completion test) would not, unless it either
artificially waits or the bug is fixed.

**First failed criterion (visual, pre-fix): C1** — the standard Floor 4 scenario
never finished initializing into a running scene, so C2–C8 were unreachable.
Telemetry at failure: frame stuck at 1–16, `window.__aiRunnerDebug().floor4Arena`
absent, one uncaught `TypeError: Cannot read properties of undefined (reading
'duration')` on the page.

**First failed criterion (visual, post-fix):** none after slice 4; C1–C8 pass.

### Verdict on the reported spawn discrepancy

The epic review recorded that "existing act-1 headless coverage reports physical
spawns, while the reported windowed behavior is empty," and required slice 1 to
either localize it to a runtime seam or correct it as an invalid report.

**Verdict: invalid report as a Floor 4 spawn defect — localized instead to a
floor-agnostic runtime seam** between async generated-sprite texture decode and
Phaser's synchronous scene lifecycle (`registerGeneratedSpriteAnimations` →
Phaser's global `AnimationManager` → `MainGameScene.update()`). The windowed run
was not spawning _nothing_; it was frozen before `arenaDirectorSystem`'s first
tick by an uncaught animation `TypeError`, i.e. an **observability/lifecycle
failure, not a spawn-parity failure**. Evidence that it is not Floor 4 specific:
the same freeze reproduces on Floor 1, and once the seam is fixed the visual
runner releases waves and Headliners identically **in kind** to headless (same 5
acts, same 5/5 Headliners spawned and defeated, same terminal `VICTORY`). No
second, independent Floor 4 spawn-logic defect exists — which is why the epic's
slice 2 needed no separate fix.

## Fix (slice 2/4 — visual runtime defect)

- `src/engine/generatedAssets/animations.ts` — added
  `confirmGeneratedSpriteAnimation(anims, textureKey, animation): boolean`, which
  skips `anims.create()` (instead of creating a broken animation) when
  `generateFrameNumbers` returns an empty array, so the key is never poisoned.
  `registerGeneratedSpriteAnimations` now uses this helper and only reports
  genuinely-created keys.
- `src/engine/PhaserBridge.ts` — added a small `pendingAnimationTextures` map and
  a per-frame retry in `sync()` for just the still-pending keys (typically 0–1
  entries), so the animation self-heals within the same scene lifetime once the
  texture finishes loading — no full registry rescan every frame.
- `tests/fixtures/phaser-bridge-harness.ts` — the mock `AnimationManager` /
  `AnimationState` did not model this race at all (`generateFrameNumbers` always
  returned a full frame array; `.play()` didn't check `manager.exists(key)`
  first, unlike real Phaser). Added `markTextureNotReady`/`markTextureReady` and
  an existence check on `.play()` so the mock actually matches real Phaser
  behavior — without this fix a regression test here would have given a false
  pass.
- Full-suite regression: `tests/unit/generated-asset-animations.test.ts`,
  `tests/unit/player-walk-animation.test.ts`.

**No Floor 4 gameplay/scenario code changed.** This is a floor-agnostic engine
fix in the generated-sprite animation registration path.

### Was there a separate Floor 4 spawn-parity bug (epic's slice 2)?

No. Once the crash above is fixed, the visual run spawns waves and Headliners
identically in kind to headless (same 5 acts, same 5/5 Headliners spawned and
defeated, same terminal `VICTORY` phase). The previously "reported windowed
behavior is empty" was fully explained by the freeze happening before the arena
director's first real tick — not a second, independent spawn-logic defect. Raw
counters (`wavesReleased`, `enemiesSpawned`, exact frame/`gameTimeMs`) are **not**
byte-identical between the two runners in this session's evidence run
(headless: `wavesReleased=40, enemiesSpawned=249, frame=36487`; visual:
`wavesReleased=40, enemiesSpawned=253, frame=36538`) — expected, because headless
steps on a fixed 1/60s tick while the visual runner accumulates Phaser's own
delta clock; both are internally deterministic (see the headless test's
same-seed-twice assertion) but are not required to be bit-identical against each
other, only to agree on the **completion facts**: phase reached `VICTORY`, all 5
wave windows released, all 5 Headliners spawned and defeated. Both runs did.

## Evidence (after fix)

- **Headless** (`tests/headless/floor4-arena-completion.test.ts`, 2 tests): seed 404
  reaches `outcome: 'victory'`, `waveTelemetry.wavesReleased === 40` (the
  manifest-derived full-release ceiling), `headlinerTelemetry.spawned === 5 &&
defeated === 5`, `phase.kind === 'VICTORY'`, terminates at ~36.5k frames
  (well under the 60k cap), and records `public-green-room-exit` ×4 plus
  `public-stairs`; a repeated seed-404 run produces byte-identical completion
  telemetry.
- **Visual** (`tests/e2e/floor4-ai-completion.deterministic.test.ts`, 1 test,
  ~160s wall time): drives the real `ai-runner-lab` / `MainGameScene`, restarts
  **300ms after page load** (deliberately inside the previously-observed 1–16
  frame crash window), runs production `BehaviorTreeAI` at 16x, and polls the
  lab's own `window.__aiRunnerDebug()` telemetry (now carrying an additive
  `floor4Arena` field — see below) until `phase.kind === 'VICTORY'`. Asserts
  zero page errors and `wavesReleased === 40`, `headlinerSpawned === 5`,
  `headlinerDefeated === 5`, five real `floor4-stair-descend` modal
  confirmations, and deterministic live-wave/victory screenshot checkpoints.
- **Manual real-browser confirmation** (ad hoc, not committed as a script): the
  same fast-restart flow against a live `npm run lab` dev server ran continuously
  from frame 96 to victory at frame 36538 (`gameMs` 608967) with zero page
  errors — versus the pre-fix permanent freeze at frame ~1–16 with an uncaught
  `TypeError`.

### New telemetry field (additive, debug-only)

`AiRunnerDebugSnapshot` (`src/labs/ai-runner-lab/index.ts`) gained an optional
`floor4Arena?: Floor4ArenaRunStats` field, populated from
`getFloor4ArenaRunStats(world)` — the same helper `headless-runner.ts` already
uses for `RunStats.floor4Arena`. Before this change the visual debug snapshot had
**no way to observe Floor 4 phase/wave/Headliner state at all**: `runOutcome`
reads `world.floorScenario.runSummary?.outcome`, and `finalizeRunSummary` (the
only writer of `runSummary`) is called only from Floor-1-specific sites in
`src/game/floorScenario.ts` — never on Floor 4's `isFloor4ArenaVictory` path. So
`runOutcome` would have stayed `null` forever for Floor 4 even after real
victory. This field is a minimal, additive telemetry exposure (no gameplay
change) needed to make the e2e test — and any human watching the lab — able to
observe Floor 4 completion at all.

## First failed criterion

None after slice 4. The previous C5 shortfall was closed by making Floor 4
intermission exits wait for the existing `confirmFloor4StairDescend` scenario
authority and exposing that authority through the real MainGameScene
confirmation modal. The visual AI-runner presses that public modal; the headless
runner, which has no DOM, calls the same scenario hook directly once it becomes
valid.

## Baseline commands (reproducible)

Both commands run the production `BehaviorTreeAI` against canonical seed 404 and
must be runnable from a clean checkout:

```
# Headless half of the contract (C1-C8 + determinism). ~45s.
npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts

# Visual half of the contract (C1-C6, C8 + determinism + zero page errors).
# Boots the real Vite lab server via the e2e global setup and drives the
# shipped ai-runner lab in headless Chromium. Requires `npx playwright install
# chromium` once. ~3-5 min (two full 16x runs).
npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts

# Optional: the same headless pipeline from the CLI, for ad-hoc inspection.
npm run ai:headless -- --seed 404 --floor floor4
```
