# Handoff: Floor 6 Slice 3 — Wave Director, Route AI, Bounded Cap/Debt

**Date:** 2026-09-01  
**Author:** Systems Engineer  
**Branch:** copilot/floor-6-slice-3-immutable-wave-schedule  
**Apples:** 🍎🍎🍎🍎 (4)  
**ADR:** 0099

---

## Summary

Implemented the full Slice 3 defense machinery for Floor 6 ("Hold for Renovation"):

- `floor6DefenseDirectorSystem` — sole writer of phase/trace/manifests/transitions
- `floor6RaiderSystem` — deterministic waypoint-following route AI (no renderer/quest inference)
- `BroadcastRelayRaider` ECS component + store for raider identity
- Authored `waves` manifest in `floor6.manifest.json` (3 waves, 12 entries)
- Live cap + spawn debt bounded and cleared at terminal events
- Missing/dead entity reconciliation (FR3.3)
- Terminal precedence: player death → relay HP ≤ 0 → stall backstop → progress

---

## Systems Touched

| System                           | Layer       | Role                                                             |
| -------------------------------- | ----------- | ---------------------------------------------------------------- |
| `floor6DefenseDirectorSystem`    | `src/game/` | Phase authority, wave release, terminal transitions              |
| `floor6RaiderSystem`             | `src/game/` | Waypoint-following movement, stall detection, relay attack       |
| `BroadcastRelayRaider` component | `src/core/` | Tags raider entities; holds per-raider manifold index + progress |

## Wiring

Both systems are registered in `src/game/scenarioDefinitions.ts` under the Floor 6 scenario:

- `beforeEnemyAISystems: [floor6RaiderSystem]` — runs before `enemyAISystem` (Raiders excluded from normal AI by absence of `EnemyBehavior`)
- `afterSpawnerSystems: [floor6DefenseDirectorSystem]` — runs after spawner systems, sees current-tick deaths

## Files Changed

```
src/core/components.ts            — BroadcastRelayRaider tag + store
src/core/world.ts                 — wireStore for BroadcastRelayRaider
src/shared/floor-types.ts         — Floor6WaveManifestEntry, Floor6LiveEnemyRecord, Floor6DefenseRunStats, extended Floor6DefenseState
src/shared/floor-manifest.ts      — Zod schema extended with .tuning and .waves optional fields
src/shared/data/floors/floor6.manifest.json  — tuning block + waves schedule
src/shared/data/enemies.floor6.json          — 3 demolition-crew archetypes (NEW)
src/shared/enemy-packs.ts         — floor6-renovation-crew registered
src/game/floor6Scenario.ts        — full Slice 3 implementation (~300 lines added)
src/game/scenarioDefinitions.ts   — floor6 scenario wired with new systems
src/labs/floor6-defense-parity-lab/index.ts  — wave director stats + tick slider
tests/unit/floor6-wave-director.test.ts      — 24 unit tests (NEW)
tests/headless/floor6-wave-director-obs.test.ts — 2 observation tests (NEW)
docs/knowledge/adr/0099-floor6-slice3-wave-director.md  — ADR (NEW)
```

## Test Coverage

- 24 unit tests: manifest determinism, stable ordering, phase transitions, terminal precedence, cap/debt, missing entity recovery, run stats telemetry
- 2 headless observation tests: 2000-frame run — `phase=DEFEND relay=100/100 released=6 live=6 debt=6 manifest=12`; deterministic replay

## Known Deferrals (for Slice 5)

- Relay HP lives in `Floor6DefenseState` (not ECS entity). Slice 5 may promote Relay to a first-class ECS entity; see ADR 0099 D4.
- VICTORY/wave-clear transitions deferred to Slice 4+ (DEFEND phase persists indefinitely in current slice).
- `waves`/`routes` RNG stream keys are reserved but not consumed — authored manifest is used directly.
