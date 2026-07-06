# Session Handoff: Guard GoreVfx blood pool against scenes without add.graphics

## Date

2026-07-06

## Persona

Producer

## Systems touched

vfx

## Apples

1🍎 estimated, 1🍎 actual (exact — single-file defensive guard + one focused regression test, no design decisions)

## What Was Done

Follow-up defensive fix to already-merged PR #812 (persistent blood pools),
addressing a valid post-merge Copilot code-review nit on `src/engine/GoreVfx.ts`:

> `spawnBloodPool()` unconditionally calls `scene.add.graphics(...)`. If
> `createGoreVfx()` is used with a minimal Scene stub that provides
> `add.rectangle` (so GoreVfx is enabled) but not `add.graphics`, this throws.

Root cause: `PhaserBridge.ts` enables GoreVfx when `typeof scene.add.rectangle === 'function'`,
but does NOT also require `add.graphics`. The death path (`spawnBloodPool`) calls
`scene.add.graphics(...)` unconditionally. Today this is **unreachable** in the
suite (the bridge harness never supplies `add.rectangle`, so gore is disabled
there; the only other caller is a real-scene lab; production scenes have both) —
a latent future-stub hazard, not a live bug, but `createGoreVfx` is exported.

Fix (guard only, no behavior change for real scenes): in `spawnBloodPool`,
immediately after `if (cfg.intensity <= 0) return;`, added
`if (typeof scene.add.graphics !== 'function') return;`. Real Phaser scenes
always have `add.graphics`, so this is a no-op for them; a rectangle-only stub
now still gets hit/death particle gore (rectangles) without throwing.

Added regression test `tests/unit/gore-vfx-partial-scene.test.ts`: a scene stub
that provides `add.rectangle` but deliberately NOT `add.graphics`, asserting a
`death` event through `vfx.update(...)` (1) does not throw and (2) still calls
`add.rectangle` (gore is not silently fully disabled).

**Observe-before-done (real behavior of the guard):** ran the new test both ways.

- **Before (guard removed):** test FAILED —
  `AssertionError: expected [Function] to not throw ... 'TypeError: scene.add.graphics is not a function'`.
- **After (guard in place):** test PASSED (1 passed), and `add.rectangle` was
  still called (death particles spawn).

Note on rule #10 real-artifact wiring: this is a pure defensive guard inside an
already-wired renderer (`GoreVfx` is created by `PhaserBridge.ts`, exercised by
`vfx-world-coords.test.ts` and the real game scene). No new system was added, so
there is no new pipeline wiring to observe — the observable change is exactly the
throw→no-throw behavior pinned by the deterministic unit test above.

## Key Decisions Made

- **Guard at the draw site, not the PhaserBridge gate.** The review nit's
  surface is `spawnBloodPool`; guarding there keeps particle gore working on a
  partial stub while only skipping the pool that needs `graphics`. Tightening
  the PhaserBridge gate to also require `add.graphics` would have disabled ALL
  gore for such stubs — a larger behavior change than the nit warranted.
- **Type-guard via `typeof … !== 'function'`** rather than a truthiness check,
  matching the existing enablement pattern in `PhaserBridge.ts`.

## What's Next / Blockers

- None for this change. The original PR #812 review thread is owned by the
  creator session — this session does NOT touch PR #812 or its threads.

## Retrospective

### Lessons Learned

- The existing `vfx-world-coords.test.ts` was the ideal reference for the mock
  shapes (chainable `setX/setY/setDepth/...` rect stub, `cameras.getCamera`
  returning null). Reusing its shape kept the new test small and consistent.
- `handleDeathEvent` spawns particles BEFORE the pool, so `add.rectangle` is
  called even in the pre-guard throwing path — which is exactly why the
  "rectangles still called" assertion is meaningful only alongside the
  "does not throw" assertion.

### Mistakes Made

- Forgot to run Prettier on the new test before `npm run verify`; the format
  step flagged it. Fixed with `npx prettier --write` and re-verified. Next time,
  format new files immediately after `create`.

### Opportunities for Future Improvement

- Consider promoting a shared "partial/minimal scene stub" fixture into
  `tests/fixtures/` so future renderer guards can reuse a rectangle-only or
  graphics-only scene without re-declaring the chainable mock each time.
- A lightweight lint could assert that every `scene.add.<method>(...)` call in
  `src/engine/*Vfx.ts` is either covered by the PhaserBridge enablement gate or
  guarded at the call site, catching this class of latent stub hazard earlier.
