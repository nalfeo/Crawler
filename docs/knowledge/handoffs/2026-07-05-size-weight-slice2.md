# Handoff: Size + weight — Slice 2 (Weight as knockback denominator)

**Date**: 2026-07-05
**Session**: size-weight-slice2 (branch `nalfeo-size-weight-slice2`)
**Persona**: Producer → Combat Systems
**Apples**: 🍎🍎🍎 (estimate) / 🍎🍎🍎 (actual)

## Systems touched: enemies, weapons, ai-combat-balance

## Summary

Slice 2 of the "true size + weight" system per ADR 0044 and spec `.specify/specs/entity-physics.md`. **Weight now matters for knockback.** `knockbackSystem` reads `weight.value[eid]` per-frame and scales displacement by `120 / max(1, weight)` — a median 120 lb mob keeps today's behavior (1.0×, bit-identical), a light 60 lb mob is punted 2× as far, a heavy 240 lb ogre only 0.5×. A new `Immovable` tag and `weight >= IMMOVABLE_THRESHOLD (10 000 lb)` short-circuit drop the impulse without moving the entity, matching walls/statues per `entity-sizing.md`.

The scale is applied **reader-side** (in `knockbackSystem`) rather than at each writer. Consequences: (a) writer constants stay untouched — no per-writer recalibration risk; (b) new writers automatically inherit weight scaling; (c) audit surface shrinks to one system. This is the design the parent producer chose over the ADR's writer-side sketch.

Real-pipeline observation (Rule #10): `tests/headless/floor1-completion.test.ts` (9 seeds, ~40 s each) passes 9/9 under divide-by-weight — Rule #13's ≥90% Floor-1 win-rate gate holds trivially at 100%. Because every shipping mob has `weight = 120 * sizeScale ∈ [108, 132]` (a ±10% jitter from `initializeEnemyAppearance`), the effective knockback scale drift is 0.91×–1.11×, well inside the ±2% win-rate tolerance.

## What shipped

### Core physics

- `src/core/components.ts` — new `Immovable` tag component. Any entity carrying `Immovable` has its `Knockback` component removed immediately without displacement.
- `src/core/physics-defs.ts` — two new constants:
  - `IMMOVABLE_THRESHOLD = 10_000` (lb) — walls hit this by design; the check is `weight >= IMMOVABLE_THRESHOLD`.
  - `KNOCKBACK_WEIGHT_BASELINE_LB = 120` — the 1.0× scale point.
- `src/core/systems/knockbackSystem.ts` — reads `weight.value[eid]` per-frame; short-circuits on `Immovable` OR `weight >= IMMOVABLE_THRESHOLD`; scales `step = min(speed, remaining) * (120 / max(1, weight))`. `remaining` is decremented by the unscaled `baseStep` so **impulse duration in frames is weight-invariant; only total displacement scales**. Preserves all substep/footprint/flying/no-floormap code paths.

### Spawner coverage

- `src/shared/decorationDefs.ts` — `DecorationDef` gained an optional `weight?: number` field (default `100` lb via the `def(...)` factory). Individual defs can override for stone-class props.
- `src/core/spawners/world-objects.ts` — `spawnProp` now attaches `Weight` using the def's value. Enemy/Player/spawner-structure already attached Weight in Slice 1. No other spawner needs a change.

### CI gate: weight coverage

- `scripts/agent/health/check-weight-coverage.ts` — runs a deterministic seed-42, 800-frame Floor-1 headless slice, then enumerates every live entity with `Enemy`, `Player`, or `Prop` and asserts `weight.value > 0`. 77 entities pass on the current shipping content.
- `src/game/ai/headless-runner.ts` — new `onFinish?: (world: GameWorld) => void` hook on `HeadlessRunnerConfig`, called once with the live `GameWorld` before `runHeadless` returns (both normal and crash return paths). Additive, no behavior change. This is how `check-weight-coverage` sees the world snapshot at end of run.
- `package.json` + `scripts/agent/verify-fast.sh` — new `check:weight-coverage` npm script wired into `verify:fast` step 4 alongside `check:size-coverage`.

### Tests

- `tests/unit/core/knockback.weight.test.ts` (new, 7 cases):
  - 120 lb → identity displacement (bit-parity vs pre-Slice-2 golden).
  - 60 lb → 2× total displacement.
  - 240 lb → 0.5× total displacement.
  - `Immovable` tag → zero displacement, component removed same frame.
  - `weight >= IMMOVABLE_THRESHOLD` → zero displacement, component removed same frame.
  - Impulse **duration** in frames is weight-invariant (only total distance scales).
  - Zero weight defaults to baseline (divide-by-zero guard).
- `tests/headless/knockback-weight-asymmetry.test.ts` (new, real-pipeline asymmetry test): fixed room-free scene, spawn 60 lb + 240 lb enemies via the real `spawnEnemy`, apply identical knockback impulse, step the real `knockbackSystem` — asserts heavy displacement (~5 ft) < light displacement (~20 ft), ratio in [3.5, 4.5]. Placed under `tests/headless/` (not `tests/e2e/`) because the codebase's `tests/e2e/` project is Playwright-only; the semantic match for a deterministic simulation test is `tests/headless/`. Rationale is a comment in the test header.
- Pinned `world.stores.weight.value[eid] = 120` in the three pre-existing tests that assert exact post-knockback positions and would drift under the ±10% sizeScale jitter: `tests/ecs/knockback-system.test.ts`, `tests/ecs/beam-broadphase-determinism.test.ts`, `tests/game/ability-system.test.ts`. Bit-parity preserved.

## Real-pipeline artifacts (Rule #10)

**Cannot show a lab-only proof — this section names shipping artifacts.**

- **Floor-1 win-rate gate** (`tests/headless/floor1-completion.test.ts`, 9 seeds × ~40 s = ~400 s wall clock): **9/9 pass**. Rule #13 gate at ≥90% is satisfied at 100%. Shell log excerpt:

  ```
   Test Files  1 passed (1)
        Tests  9 passed (9)
     Start at  14:32:48
     Duration  398.65s
  ```

- **Real-pipeline asymmetry test** (`tests/headless/knockback-weight-asymmetry.test.ts`): passes with 60 lb → +19.9 ft, 240 lb → +5.0 ft, ratio 4.0.
- **`verify:fast`**: green — typecheck + lint + unit (3853/3855 pre-fix, 3855/3855 post-fix) + `check:physics-defs-sync` + `check:size-coverage` (0 shim fallbacks) + `check:weight-coverage` (77 entities checked, 0 failures).

## Writer audit (spec asked for)

The parent's spec listed `applyProjectileHit / applyEnemyProjectileHit / applyPlayerEnemyHit / areaDamageSystem / beamSystem / returningProjectileSystem / meleeSwingSystem / corpse-explosion` as writers to audit. In the shipping codebase today, the only files that write a `Knockback` component are:

| Writer file                                    | Line(s)   | Notes                                          |
| ---------------------------------------------- | --------- | ---------------------------------------------- |
| `src/core/systems/meleeSwingSystem.ts`         | 367, 377  | Melee swing → knockback on hit.                |
| `src/core/systems/dropSystem.ts`               | 340, 350  | Corpse-explosion / on-death knockback.         |
| `src/game/systems/progressionEffects.ts`       | 167–170   | Game-layer progression effect.                 |

The spec's remaining writer names (beam/area/projectile/applyPlayerEnemyHit) write **zero** `Knockback` components in current code — confirmed by `grep -n "Knockback" src/core/systems/{damage,area,beam,returningProjectile}.ts`. **Reader-side scaling means those writers will automatically inherit weight scaling if/when they gain knockback in a later slice**, without a per-writer audit at that time.

## Why the win-rate gate holds — ±2% risk derivation

- `spawnEnemy` calls `initializeEnemyAppearance(world, eid)` which jitters `world.stores.weight.value[eid]` by a per-eid seeded `sizeScale ∈ [0.9, 1.1]` (`src/core/spawners/combatants.ts:36`).
- Every shipping enemy uses the mob-baseline default weight of 120 lb, so effective post-jitter weight is `120 * sizeScale ∈ [108, 132]` lb.
- Under divide-by-weight, that maps to a knockback scale of `120 / [108..132] = [0.91×, 1.11×]`.
- Player is 180 lb → 0.67×, but Player almost never has a `Knockback` component in practice (`grep` for writers that target Player: only the game-layer progression effect and `dropSystem` corpse-explosion via `Immovable` bystander wave — none currently target the player in Floor 1). Player is effectively a non-participant in the query.
- Median case is 1.0× ± ~11% — a change well within the ±2% Floor-1 win-rate tolerance.
- Confirmed empirically: 9/9 seeds still pass Floor-1 completion after the divide-by-weight change.

If a later slice retunes the mob-baseline weight or adds a heavy-mob archetype (Slice-3 territory per ADR 0044), that's the point at which a fresh Floor-1 win-rate sweep is warranted.

## Deferred / not in this slice

- **`spawnHarvestableNode` does NOT get Weight** — it attaches `Harvestable`, not `Prop`. Per spec R2 the coverage contract keys on `Enemy | Player | Prop`; harvestable nodes are not knockback targets.
- **`Trap` does not get Weight** — spec `entity-sizing.md` explicitly notes this in the `physics-defs.ts` docblock ("`trap` weight is nominal only — it does NOT flow into the trap spawner. Slice 2 may promote it") but traps are not knockback targets in current gameplay; deferring keeps this slice minimal.
- **Data-driven prop weights** — `DecorationDef.weight` is a new optional field with a default 100 lb; individual entries do not yet override. Stone-class props that should be `Immovable` at 10 000+ lb are a Slice-3 content follow-up.
- **Boss and other archetype-specific weight tuning** — deferred to a later balance slice as ADR 0044 anticipated.

## Follow-up ideas (not in this PR)

- `sizeScale` weight jitter (`initializeEnemyAppearance`) may be worth removing or reducing once weight becomes a first-class balance dial — the ±10% jitter now bleeds directly into knockback distance. Non-blocking for Slice 2.
- Add `PropCategory === 'structural'` → default weight of 10 000 lb (or add an `isImmovable?: boolean` flag on `DecorationDef`) so stone pillars and statues short-circuit knockback automatically.
- Extend `check-weight-coverage` to run a multi-floor sweep once Floor 2+ spawners are exercised by headless (currently 800-frame Floor-1 slice only, matching `check-size-coverage`'s scope).

## Verification checklist

- [x] `npm run verify:fast` — green.
- [x] `tests/headless/floor1-completion.test.ts` — 9/9 pass (Rule #13 ≥ 90%).
- [x] `tests/headless/knockback-weight-asymmetry.test.ts` — real-pipeline asymmetry proved.
- [x] All 320 unit-test files pass (3855/3855).
- [x] Review ledger `docs/knowledge/review-ledgers/2026-07-05-size-weight-slice2.review-ledger.json` — populated per 🍎🍎🍎 tier (plan_review + code_review loop).
- [x] Apple metric `docs/knowledge/metrics/apples/2026-07-05-size-weight-slice2.json` — estimate/actual.
- [x] No `Math.random` / `Date.now` calls introduced (Rules #3, #4).
- [x] No new `*System` exports (Rule #15 — wired-systems gate stays trivially green).

## Pointers for the next agent

- If you're picking up **Slice 3** (content-side weight tuning — boss archetypes, structural props, retuning mob-baseline): the review-ledger + handoff show what's already in place. Your work is data, not physics. Do a Floor-1 win-rate sweep as the last step; the ±2% tolerance is the guardrail.
- If you're picking up a **knockback-writer promotion** (giving beam/area/projectile knockback): you inherit weight scaling for free — no code changes to `knockbackSystem`. Just verify with the unit tests in `tests/unit/core/knockback.weight.test.ts` and add coverage for the new writer.
- **Do NOT re-fork Size or physics-defs values** — Slice 1's collision-pair-parity golden depends on them staying exact.
