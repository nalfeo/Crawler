# Spec: Floor 4 Playable Completion (seed 404, dual-runner)

> **Status:** **Slices 1, 3, 4 complete** for the narrower "must be beatable" contract
> below; **slice 2 needed no separate fix** (see §Slice 2 finding); the epic's stronger
> "each intermission resolves through its public scenario/UI interaction" criterion
> (slice 5 of `floor4-arena.md`) is **explicitly not closed** by this document — see
> §Known gap.
> **Authored:** 2026-09-02.
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

## Slice 1 — Baseline (reproduce first)

### Headless baseline

Command: `BehaviorTreeAI` + `runHeadless({ seed: 404, floorId: 'floor4', ... })`
(the same pipeline as `npm run ai:headless -- --seed 404 --floor floor4`).

**Observed (pre-session, unchanged by this session):** the run already reaches
`outcome: 'victory'` — physical wave enemies spawn (`waveTelemetry.enemiesSpawned

> 0`), all 5 wave windows release waves, all 5 Headliners spawn and are defeated
in ordinary combat, and `phase.kind`reaches`VICTORY`. Every
`INTERMISSION → next phase`transition is logged with reason`'slice2-auto-green-room-exit'`(acts 1–4) or`'slice2-auto-stairs'`(act 5 →`VICTORY`) — the pre-existing, **already-documented** "empty broadcast rehearsal"
placeholder from `floor4-arena.md`'s "Slice-2 deviation" note, not a new defect.

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

- **Headless** (`tests/headless/floor4-arena-completion.test.ts`, 2 tests,
  passing): seed 404 reaches `outcome: 'victory'`, `waveTelemetry.wavesReleased
  > = 5`, `headlinerTelemetry.spawned === 5 && defeated === 5`, `phase.kind ===
  > 'VICTORY'`, terminates at ~36.5k frames (well under the 60k cap); a repeated
  > seed-404 run produces byte-identical completion telemetry.
- **Visual** (`tests/e2e/floor4-ai-completion.deterministic.test.ts`, passing,
  ~80s wall time): drives the real `ai-runner-lab` / `MainGameScene`, restarts
  **300ms after page load** (deliberately inside the previously-observed 1–16
  frame crash window), runs production `BehaviorTreeAI` at 16x, and polls the
  lab's own `window.__aiRunnerDebug()` telemetry (now carrying an additive
  `floor4Arena` field — see below) until `phase.kind === 'VICTORY'`. Asserts
  zero page errors and `wavesReleased >= 5`, `headlinerSpawned === 5`,
  `headlinerDefeated === 5`.
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

## Known gap (explicitly not closed this session)

The epic's slice 1 defines completion as including "each intermission resolves
through its public scenario/UI interaction," and the epic review gate forbids
"phase skipping." Floor 4's intermission-to-next-act and final-stairs
transitions are still driven purely by `arenaDirectorSystem`'s own phase timer
(`'slice2-auto-green-room-exit'` / `'slice2-auto-stairs'`) — this is the
pre-existing, already-documented "empty broadcast rehearsal" from
`floor4-arena.md`'s "Slice-2 deviation" note, not something this session
introduced or silently accepted without flagging.

Additionally confirmed this session: `confirmFloor4StairDescend`/
`onStairDescend` are **currently dead code** for Floor 4 in both runners —
headless only calls `onStairDescend` when `scenario.autoSelectKeptCompanion` is
set (Floor 4 has none), and the visual stairs-confirmation modal only triggers
when the scenario defines `stairConfirmation` (Floor 4 has none, unlike Floor
3's `FLOOR_3_STAIR_CONFIRMATION`). There is no physical Green Room exit or
stairs prop wired for Floor 4 at all yet.

**This is not a runner-only shortcut** — the timer-driven advance lives in
shared `src/game/floor4Scenario.ts`, executed identically by both runners, so it
does not break headless/visual parity. It does not yet satisfy the stricter
"public interaction" criterion. Closing it is `floor4-arena.md` slice 5 (the real
Green Room transaction) plus new `BehaviorTreeAI` navigate-and-interact logic —
a materially larger feature than "fix the smallest verified defect that blocks
beatability," and out of proportion to the user's literal ask for this session
("must be beatable... balance/win rate out of scope"). Flagged here, in the ADR,
and in the handoff for explicit follow-up planning rather than silently
implied complete.

## Commands used

```
npx vitest run tests/headless/floor4-arena-completion.test.ts
npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts
```
