# Handoff — Distance-from-spawn mob level scaling

## Summary

Implemented a gentle difficulty ramp for ambient mobs on Floor 1: enemies that
spawn farther from the player's starting tile receive scaled HP and speed. The
scaling is linear and capped so non-boss mobs are always beatable even at the
far edge of the dungeon.

## Systems touched

enemies, ai-combat-balance

## What was done

- **`src/shared/mob-scaling.ts`** (new) — pure `computeMobLevelScale(distFt)`
  returning `{hpMult, speedMult}`. Linear ramp from 1.0× at spawn to **1.25× HP /
  1.05× speed** at ≥250 ft (see the shepherd-tuning note below for why these
  endpoints, not the initial 1.5×/1.1×). No RNG, fully deterministic.
- **`src/game/floorScenario.ts`** — `spawnAmbientArchetype` computes the
  Euclidean distance from `world.floorMap.playerSpawn` to the spawn position and
  applies the scale before calling `spawnBehaviorEnemy`. The applied math is
  extracted into an exported pure helper **`scaleAmbientSpawnStats`** so the
  spawn wiring (distant spawn → boosted, rounded HP/speed) has assertion-level
  coverage. Room wave spawns via `prepopulateEnteredRoom` inherit this
  automatically (they call `spawnAmbientArchetype`).
- **`tests/unit/mob-scaling.test.ts`** — unit tests covering boundary clamping,
  midpoint linearity, monotonicity, ceiling enforcement, plus a calibration-pin
  test locking the tuned endpoints (1.25/1.05/250) with a "re-run
  `npm run test:headless`" tripwire comment.
- **`tests/game/ambient-spawn-scaling.test.ts`** (new) — 7 assertion-level tests
  for the `scaleAmbientSpawnStats` wiring against the real Floor-1 archetype
  bases (rat/slime): unchanged at spawn tile, max multipliers beyond the
  reference distance, distant > spawn-adjacent, midpoint linearity, Euclidean
  diagonal, HP floor of 1.

## Shepherd tuning (Floor-1 gate fix)

- **Symptom:** the only failing check was the **Headless Floor 1 Gate**. Root
  cause was a single assertion in
  `tests/headless/spawner-arena-win-rate.test.ts` — _"every winning run stays
  inside the Floor-1 AI time budget"_. Seed 2 (sword + arena) **won** but at
  **378.7 s deterministic gameTimeMs**, over the 360 s `FLOOR1_TIME_BUDGET_MS`.
  It was **not** a win-rate collapse — all per-weapon floors (sword 75 %, bow
  50 %, bat 75 %) and arena win-rate always passed. The extra HP from the ramp
  simply lengthened fights past the budget.
- **Legitimate lever (rules #12/#13):** tuned the exported curve constants down
  — **HP 1.5×→1.25×, speed 1.1×→1.05×** at 250 ft — keeping a real +25 % HP /
  +5 % speed ramp (NOT a no-op). The gate itself was never weakened.
- **Empirical, per-seed:** per-seed clear time is chaotic/non-monotonic w.r.t.
  the curve (HP/speed changes shift combat duration → AI timing → pathing), so
  the full 8-seed sweep was re-measured at the final curve, not extrapolated
  from seed 2.

## Verification (observe-before-done)

- **Authoritative artifact:** `npm run test:headless` (the real CI Floor-1 gate,
  `tests/headless/**`) — **10 files / 41 tests pass**, ~373 s.
- **Before → after (deterministic gameTimeMs, sword+arena sweep):** seed 2
  **378.7 s → 317.3 s** (~43 s under the 360 s budget). Full 8-seed clear times
  at the final 1.25/1.05 curve: s1 196.6, s2 317.3, s3 282.7, s4 249.1, s5
  254.9, s6 269.6, s7 304.2, s8 239.1 — all victory, all < 360 s.
- `npm run verify:fast` — 339 unit tests pass ✅
- `npm run check:wired-systems` — green ✅ (mob-scaling is a pure fn, correctly
  not a tracked system).

## Design notes

- `MOB_SCALING_REFERENCE_DIST_FT = 250` — at this distance multipliers peak.
  Ambient mobs spawn 20–160 ft from the roaming player, while the scaling signal
  is distance from the fixed floor spawn tile, so the ramp engages as the run
  pushes deeper.
- HP 1.25× / speed 1.05× max — calibrated to keep mobs meaningfully tougher deep
  in the floor while every winning headless seed clears within the AI-time
  budget. Speed is intentionally the gentler ramp (faster enemies
  disproportionately raise difficulty for ranged/kiting play).

## Unresolved issues

None. Constants remain tunable via the exported `MOB_SCALING_*` constants; the
calibration-pin unit test forces a headless re-run if they change.

## Recommended next steps

- Spawner children + room-graph hop-distance depth metric remain explicitly
  deferred (tracked as TODOs in `mob-scaling.ts`).
- Consider a `MobLevel` ECS component in a future session if the level needs to
  be surfaced in the HUD (e.g. level indicator above health bar).

## Apples

Estimated: 🍎🍎🍎 (Medium)
Actual: 🍎🍎🍎 (Medium)
Verdict: exact — shepherd tuning stayed within the medium tier (curve retune +
2 review-thread fixes + coverage; no new systems). Initial shepherd estimate was
4🍎; resolved to the branch's committed 3🍎.
