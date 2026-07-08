# Session Handoff: Floor 1 spawner-free by config

## Date

2026-07-07

## Persona

Producer

## Systems touched

enemies, ai-combat-balance

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 3
Verdict: 📉 under (the config lever is one line, but the honest golden rebaseline + arena-gate change + ADR fanned it out to 3)

## Summary

Made Floor 1 **spawner-free at the data layer** (config-driven), per the maintainer's
directive, instead of gating `spawnerSystem` in the runtime pipelines (the original
PR #836 approach, reverted here).

- `FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS` emptied to `readonly string[] = []` + an
  early-return in `spawnFloor1StaticSpawners`. Repopulate the array to re-enable.
- `spawnerSystem` is wired **unconditionally** in both pipelines again (harmless
  no-op with zero Floor-1 spawners) — keeps the two hand-maintained pipelines
  uniform and avoids an ADR-0036-style conditionally-wired system.
- Consequences (human-authorized + documented in **ADR 0049**): rebaselined the 4
  collision-pair-parity goldens (seeds 7/13/42/137) and retired the now-impossible
  `anyTriggered > 0` arena-engagement assertion (replaced by its honest inverse
  `=== 0`). The spawner-battle-arena feature (ADR 0044/0045) is now dormant on
  Floor 1, still covered by `tests/integration/ai-arena-lockin.integration.test.ts`.

## Files touched

- `src/game/floorScenario.ts` — empty spawn table + config-driven early-return
- `src/bootstrap/floor-main-scene-options.ts` — `spawnerSystem` wired unconditionally (guard reverted)
- `src/game/ai/simulation-step.ts` — `spawnerSystem` wired unconditionally (guard reverted)
- `tests/game/floor1-scenario.test.ts` — asserts 0 static spawners on Floor 1
- `tests/game/floor1-main-scene-options.test.ts` — asserts `spawnerSystem` wired for Floor 1 after `spawnerArenaSystem`
- `tests/integration/floor1-spawners-pipeline.test.ts` — asserts zero Floor-1 Spawner entities in both pipelines
- `tests/headless/collision-pair-parity.test.ts` — 4 goldens rebaselined + in-file data table + ADR 0049 ref
- `tests/headless/spawner-arena-win-rate.test.ts` — engagement assertion retired (`> 0` → `=== 0`) + docstring note
- `docs/knowledge/adr/0049-floor1-spawner-free-by-config.md` — new ADR
- `docs/knowledge/metrics/apples/2026-07-07-disable-floor1-spawners.json` — apples → 2/3
- `docs/knowledge/review-ledgers/2026-07-07-disable-floor1-spawners.review-ledger.json` — upgraded to 3🍎 tier

## Verification run

Observe-before-done (real headless pipeline, not a lab):

- `tests/headless/collision-pair-parity.test.ts` — 5/5, run **twice** back-to-back, identical (stability protocol). Rebaselined fingerprints match a fresh run.
- `tests/headless/spawner-arena-win-rate.test.ts` — 4/4. Sweep: 7/8 sword victories (seed 2 timeout) = 87.5% ≫ 75% floor; every seed reports `t=0/armed=0` ⇒ Floor 1 confirmed spawner-free.
- `npm run typecheck` ✅
- Plan review (separate model) + code-review loop recorded in the review ledger.
- Canonical `floor1-completion` 306s gate deferred to the CI Headless job (removing spawners only makes Floor 1 easier, so win-rate can only rise).

## Unresolved issues

- None blocking. The canonical Headless Floor-1 gate is the CI decider per the shepherd mandate ("let the Headless gate decide honestly").

## Recommended next steps

- To re-enable Floor 1 spawners later: repopulate `FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS` (e.g. `['slime-pool','rats-nest']`), then restore the collision-parity goldens and the `anyTriggered > 0` arena assertion under the new behavior (both failing tests + ADR 0049 point at this).
