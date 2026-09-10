# Floor 4 playable completion — animation crash fix + dual-runner completion gate (seed 404)

## Date

2026-09-02

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree

## Apples

2🍎 estimated, 2🍎 actual (exact). One confirmed, floor-agnostic engine defect
(generated-sprite animation registration race), two new regression tests
(headless + e2e), one additive debug-telemetry field, one ADR, one acceptance
spec. No gameplay/balance/tuning code changed.

## What Was Done

Implemented the `floor-4-playable-completion` epic's narrower "must be
beatable" contract for canonical seed 404, per explicit user instruction
(balance/win rate out of scope).

**Reproduced first, both runners:**

- **Headless**: seed 404 already reached `outcome: 'victory'` with genuine
  physical wave/Headliner combat — no fix needed here. Every intermission
  advance is logged `'slice2-auto-green-room-exit'`/`'slice2-auto-stairs'`,
  the pre-existing, already-documented `floor4-arena.md` "empty broadcast
  rehearsal" placeholder, not a new defect.
- **Visual**: driving the real `ai-runner-lab`/`MainGameScene` and selecting
  Floor 4 + seed 404 (which calls `phaserScene.scene.restart()`) reliably
  froze the render loop within 1–16 frames on a fast restart, throwing an
  uncaught `TypeError` inside Phaser's `Animation.getFirstTick`. Confirmed
  floor-agnostic (reproduces on Floor 1 too — never a Floor 4 gameplay bug)
  and specific to fast `scene.restart()`. This fully explains the epic
  review's noted "reported windowed behavior is empty": the scene froze
  before the arena director's first tick, so nothing had a chance to spawn —
  not a second, independent spawn-parity defect.

**Root cause** (confirmed against real Phaser source): generated-sprite
animation registration (`registerGeneratedSpriteAnimations`,
`src/engine/generatedAssets/animations.ts`) called
`anims.create({ frames: [], ... })` unconditionally, even when
`generateFrameNumbers` returned `[]` because the texture wasn't registered in
Phaser's `TextureManager` yet — permanently poisoning the walk-cycle animation
key in Phaser's **global, per-game** `AnimationManager` (not reset by scene
restarts). The first `.play()` on that poisoned key crashed. Calling `.play()`
on a key that was never created at all is safe in real Phaser (confirmed via
`AnimationState.startAnimation`'s early-return), which is what makes
"skip creating, retry later" the correct fix.

**Fix**: added `confirmGeneratedSpriteAnimation` (skips `anims.create()`
instead of poisoning the key when the frame list comes back empty) and a
per-frame retry of just the pending texture keys inside `PhaserBridge.sync()`.
Also fixed a fidelity gap in the test harness's `MockAnimationManager`/
`MockAnimationState` (didn't model the "texture not ready" race at all — a
regression test against the un-fixed mock would have false-passed).

**Observed in real pipelines (rule #9/#14):**

- `Observed in npm run lab (ai-runner-lab, live dev server) — before: fast
restart froze the render loop at frame ~1–16 with an uncaught TypeError;
after: continuous frame advancement from load through a full Floor 4
victory (frame 96 → 36538, gameMs 608967), zero page errors.`
- `Observed in tests/headless/floor4-arena-completion.test.ts (production
BehaviorTreeAI + runHeadless) — seed 404 reaches VICTORY with
wavesReleased=40, headliner 5/5 spawned+defeated, deterministic across two
runs of the same seed.`
- `Observed in tests/e2e/floor4-ai-completion.deterministic.test.ts (real
MainGameScene via ai-runner-lab, 300ms fast-restart, production
BehaviorTreeAI at 16x) — reaches VICTORY, wavesReleased=40, headliner 5/5
spawned+defeated, zero page errors, ~80s wall time.`

**Additive telemetry**: `AiRunnerDebugSnapshot` (`src/labs/ai-runner-lab/index.ts`)
gained an optional `floor4Arena?: Floor4ArenaRunStats` field (reusing
`getFloor4ArenaRunStats`, already used by `headless-runner.ts`). Before this,
the visual debug snapshot had **no way to observe Floor 4 phase/wave/Headliner
state at all** — `runOutcome` reads `world.floorScenario.runSummary?.outcome`,
and `finalizeRunSummary` (the only writer) is only called from Floor-1-specific
sites, never on Floor 4's victory path, so `runOutcome` would stay `null`
forever for Floor 4 even after real victory.

**Docs**: wrote `.specify/specs/floor4-playable-completion.md` (the epic's
slice-1 acceptance-contract document) and
`docs/knowledge/adr/2026-09-02-generated-sprite-animation-self-healing.md`.

## Key Decisions Made

- **Scope boundary (flagging for user visibility/possible pushback)**: did
  **not** implement a real Green Room/stairs public-interaction system for
  Floor 4 this session. The epic's slice 1 wants "each intermission resolves
  through its public scenario/UI interaction"; Floor 4 currently has none
  wired (`confirmFloor4StairDescend`/`onStairDescend` are dead code in both
  runners — gated behind `autoSelectKeptCompanion`/`stairConfirmation`, which
  Floor 4's scenario definition lacks). Judged this out of proportion to the
  user's literal, narrower ask ("must be beatable... balance/win rate out of
  scope") and consistent with the pre-existing, already-documented
  `floor4-arena.md` "Slice-2 deviation" rehearsal placeholder — the
  timer-driven advance is **shared** code (`src/game/floor4Scenario.ts`),
  executed identically by both runners, so it does not break headless/visual
  parity; it just doesn't yet satisfy the stricter "public interaction"
  criterion. Documented honestly in the new spec doc rather than silently
  glossed over or falsely claimed complete.
- Chose an additive-only telemetry fix (`floor4Arena` field on the debug
  snapshot) rather than trying to retrofit Floor 4 onto the Floor-1-specific
  `finalizeRunSummary`/`runOutcome` path, since Floor 4's real completion
  signal (`isFloor4ArenaVictory`) is already a first-class, well-tested
  concept — reusing it directly is smaller and safer than making Floor 1's
  run-summary code branch for Floor 4.
- Kept the `Array.isArray(frames) && frames.length === 0` guard (not a bare
  `length === 0`) in `confirmGeneratedSpriteAnimation` deliberately, so
  existing non-array test stubs keep their prior "trust it, create" behavior
  and all 7 pre-existing tests in `generated-asset-animations.test.ts` stay
  green unchanged.

## What's Next / Blockers

- The real Green Room transaction and a physical Floor 4 stairs
  prop/confirmation modal (`floor4-arena.md` slice 5, plus new
  `BehaviorTreeAI` navigate-and-interact decision logic for both runners) are
  the remaining work to satisfy the epic's stricter "public interaction"
  completion criterion. Not started this session; scoped out per the reasons
  above.
- No further headless runtime fix is needed for beatability — only the
  visual-runner crash was blocking observability.

## Retrospective

### Lessons Learned

- Phaser's `AnimationManager#generateFrameNumbers` fails **silently**
  (`console.warn`, no throw, returns `[]`) when the texture isn't loaded yet —
  any code that unconditionally calls `anims.create()` on that result
  poisons a **global, per-game** (not per-scene) animation key forever. Any
  future generated-content registration against Phaser's animation/texture
  APIs should check for this "silently degraded, not thrown" failure mode
  before assuming "no exception" means "succeeded."
- A `.play()` call on a _never-created_ animation key is safe in real Phaser
  (early-return, no crash) — but a mock harness that doesn't model this can
  produce false test passes. Always cross-check a new mock behavior against
  the real library's source before trusting a regression test built on it.
- Reproducing an in-browser Phaser bug reliably required a Playwright script
  living **inside the repo** (not `/tmp`), because Node's ESM resolver
  can't follow relative TS imports from outside the project root.

### Mistakes Made

- Initially assumed (from the epic review body's phrasing, "reported
  windowed behavior is empty") that there might be a _second_, independent
  Floor-4-specific spawn-parity defect beyond the animation crash. Spent time
  tracing `onStairDescend`/`confirmFloor4StairDescend` wiring before
  confirming (by comparing headless vs. post-fix visual telemetry directly)
  that the "empty" report was fully explained by the crash happening before
  the arena director's first tick — there was no second defect. Should have
  established the post-crash-fix visual telemetry baseline _before_ digging
  further into stairs/intermission wiring, since that comparison would have
  settled the question immediately.

### Opportunities for Future Improvement

- Consider giving `PhaserBridge`'s pending-animation retry a bounded attempt
  cap with a one-time diagnostic log, so a permanently-missing texture (an
  asset-pipeline regression, not a load-order race) doesn't retry silently
  forever with zero operator visibility.
- The `docs/knowledge/adr/README.md` hand-maintained thematic index has
  fallen behind for several recent date-prefixed ADRs (none of the
  2026-08-27 through 2026-08-30 batch appear in it). Worth a dedicated
  docs-hygiene pass to reconcile it against the actual `adr/` directory
  listing.
