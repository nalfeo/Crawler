# Session Handoff: Generic VFX Effects ("juice") Pipeline

## Date

2026-06-26

## Persona(s) adopted

**Graphics Designer (VFX)** — the task was "add more particle effects to spice up
the game visuals and satisfaction," a pure visual-feedback/juice request that maps
directly to the Graphics Designer persona's remit.

## Routing verdict

✅ right persona — the work was entirely render-side juice plus the minimal data
plumbing to feed it; no gameplay/balance/AI decisions were involved.

## Apples

Estimated: 🍎 x 5 <!-- declared before work began -->
Actual: 🍎 x 5
Verdict: 🎯 Exact — a new data-only event queue spanning core/game/engine, a new
engine renderer with a six-preset library, a preview lab, an ADR, emit sites, and
three test suites landed as one cohesive PR, matching the "Massive" estimate.

Hello kitties: 5/5 = 1.00 🎀

## Systems touched

enemies, vfx

## What Was Done

Implemented Phase 0 (foundation pipeline) + Phase 1 (high-impact effects) of the
particle-effects investigation as a single PR.

**New generic VFX pipeline** (mirrors the existing `combatEvents → CombatVfx/GoreVfx`
pattern):

- `src/shared/vfx-events.ts` (NEW) — data-only `VfxEvent { kind, x, y, color?,
intensity? }`, `VfxEffectKind` union, `PICKUP_SPARKLE_COLORS`, and
  `pushVfxEvent` with a `VFX_EVENT_CAP` (512, drops oldest) so headless/AI runs
  with no renderer can't grow the queue unbounded.
- `src/core/world.ts` — added `world.vfxEvents: VfxEvent[]` field + init.
- `src/engine/EffectsVfx.ts` (NEW) — the sole consumer. Drains `vfxEvents` and
  reads `combatEvents` **without draining** (must run after GoreVfx, before
  CombatVfx) to synthesise combat juice. Self-animating Phaser tweens that destroy
  their own GameObjects (same pattern as `triggerBossSpawnFx`). Capability-guarded
  so it no-ops (but still drains) in mocked/headless scenes. Render-only LCG RNG —
  never `Math.random`/`SeededRandom`, so it can never touch the simulation.
- `src/engine/PhaserBridge.ts` — constructs `effectsVfx`, calls `.update()` between
  goreVfx and combatVfx in `sync()`, and `.destroy()` on teardown.
- `src/engine/index.ts` — export `createEffectsVfx`.
- `src/shared/render-depths.ts` — added `WORLD_VFX_DEPTH` entries (deathPop,
  hitSpark, pickupSparkle, levelUpBurst), all below `UI_DEPTH_CUTOFF`.

**Effects (Phase 1):** pickupSparkle (gem/gold/item), levelUpBurst, hitSpark,
critBurst, deathPop (overkill-scaled, blood-tinted), playerHurt (throttled camera
flash + shake).

**Emit sites:**

- `src/core/systems/itemPickupSystem.ts` — pushes `pickupSparkle` (correct tint per
  gold/gem/item) at the pickup position **before** `removeEntity`.
- `src/game/systems/levelSystem.ts` — pushes `levelUpBurst` at the player on
  level-up. (Hit/crit/death/player-hurt need no core changes — derived from
  existing `combatEvents`.)

**Preview lab:** `src/labs/juice-lab/` (NEW, + README) with per-effect trigger
buttons and an auto-fire density stress test; registered in `src/lab-main.ts`
(`?lab=juice-lab`).

**Tests:** extended `tests/ecs/itemPickupSystem.test.ts` (sparkle tint/position per
kind + no-emit-on-miss) and `tests/game/level-system.test.ts` (burst at player +
no-emit-without-levelup); new `tests/unit/vfx-events.test.ts` (cap helper +
colours). All green.

**ADR:** `docs/knowledge/adr/0025-vfx-effects-pipeline.md` — pipeline design,
ordering invariant, and the build-vs-buy verdict (lightweight tweens now; Phaser
`ParticleEmitter` recommended for a future high-density ambient pass).

## What's Next

- **Phase 2 (deferred):** high-density ambient/atmosphere via Phaser
  `ParticleEmitter` (dust, embers, floor mood), per the ADR's build-vs-buy note.
- More emit sites are now cheap to add (casting, dust on dash, projectile trails,
  shop/quest celebrations) — just `pushVfxEvent` + (optionally) a new preset.
- Consider a `critBurst`/`hitSpark` intensity tie to weapon gore factor for variety.

## Blockers

None functional. One **pre-existing, machine-specific** test failure is noted below
under Test Results — it is unrelated to this change and was proven so.

## Branch State

- Branch: `nalfeo-particle-effects-investigation`
- All tests passing: yes, except one pre-existing wall-clock perf guard (see below)
- PR created: yes (opened from this branch)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no guard-telemetry
section to paste.

## Test Results

- `npm run verify:fast` — ✅ pass (typecheck + lint + 759 unit tests across 74 files).
- `npm run verify` (full) — all gates green **except** Step 7 (headless Floor 1
  gate): `seed 3 · bow > stays within the wall-time budget` failed at ~37s vs the
  30s `HEADLESS_WALL_TIME_BUDGET_MS`.
  - **Proven pre-existing & not caused by this change.** I stashed all VFX work and
    re-ran the same run on the clean baseline: **36.2s** over the **identical 15804
    frames** (with my changes: 37.6s — wall-clock noise). The frame count is
    byte-identical, so the deterministic simulation is unchanged; my only per-frame
    addition is a bounded array push on pickup/level-up.
  - This guard is explicitly "a coarse blowup guard, not a precise SLA" tuned for
    ubuntu CI; the test file documents Windows dev boxes run 2–3× slower in wall
    time. The deterministic **game-time** budget (the real correctness gate) passes
    for seed 3·bow. Per the test author's explicit warning, the budget was **not**
    bumped — profiling the BT-AI bow run is a separate task outside this PR's scope.
- `bash scripts/agent/lab-gate-check.sh` — ✅ pass (every core system has a lab;
  `itemPickupSystem` already covered; `juice-lab` added for the new renderer).
- `npx vite build` (verify Step 8) — ✅ pass.

## Key Decisions Made

- **Reuse the proven event-queue + non-draining-reader pattern** rather than invent
  a new one: combat juice is synthesised from existing `combatEvents` (zero core
  plumbing); only non-combat signals (pickups, level-ups) push to `vfxEvents`.
- **Lightweight self-animating tweens over GPU `ParticleEmitter` for Phase 1** —
  CI-safe and mock-friendly; ADR 0025 recommends `ParticleEmitter` for a future
  high-density pass.
- **Render-only LCG RNG inside `EffectsVfx`** so cosmetic randomness can never
  couple to the deterministic simulation (no `Math.random`, no `SeededRandom`).
- **Bounded `vfxEvents` queue** (`VFX_EVENT_CAP`) so headless/AI runs with no
  renderer stay memory-safe.
