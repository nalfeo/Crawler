# ADR 0049: Floor 1 is spawner-free by empty spawn table

## Status

Accepted

> Follow-on delta to the spawner-arena feature family. The canonical current
> contract lives in
> [`.specify/specs/spawner-battle-arena.md`](../../../.specify/specs/spawner-battle-arena.md).

## Date

2026-07-07

## Estimated Complexity

🍎🍎🍎 x 3 — the config change itself is one line, but the honest, design-owned
consequences fan out across two headless balance gates (a collision-pair-parity
golden rebaseline and a spawner-arena engagement-assertion retirement) and make
the spawner-battle-arena feature (ADR 0044/0045) dormant on Floor 1, so this is
a multi-system, balance-touching decision rather than a trivial edit.

## Context

Floor 1's static spawners (`slime-pool`, `rats-nest` — 2 each, placed by
`spawnFloor1StaticSpawners` in `src/game/floorScenario.ts`) were producing
unreliable behavior on Floor 1. The maintainer directed that Floor 1 simply not
have any spawners, and that the disable be **config-driven** ("remove them from
the spawn table/rules for Floor 1") rather than achieved by gating the runtime
system.

PR #836 first attempted this by branching `spawnerSystem` out of both runtime
pipelines on Floor 1 (`createFloorMainSceneOptions` and `runSimulationStep`).
That is the wrong lever:

- It forks the two hand-maintained pipelines (visual vs. headless, tracked in
  issue #663) on a floor condition, widening the divergence they already carry.
- It risks re-introducing the exact class of bug ADR 0036 fixed — a `*System`
  that is exported but not uniformly wired — because the system becomes
  conditionally referenced.
- It leaves the spawn table itself still "populated," so the source of truth for
  _what Floor 1 spawns_ disagrees with runtime reality.

## Decision

Make Floor 1 spawner-free **at the data layer** and keep the pipelines uniform:

1. **Empty the spawn table.** `FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS` is now
   `const … : readonly string[] = []` (explicit `readonly string[]`, not
   `[] as const`, so `.length === 0` is not statically "always true" and does
   not trip `@typescript-eslint/no-unnecessary-condition`). Repopulate this list
   (e.g. `['slime-pool', 'rats-nest']`) to re-enable Floor 1 static spawners
   without touching any pipeline code.
2. **Config-driven early return.** `spawnFloor1StaticSpawners` bails immediately
   when the table is empty, before deriving the room stream, so it does no
   wasted work and never throws its "not enough rooms" guard.
3. **Keep `spawnerSystem` wired uniformly.** Both pipelines call
   `spawnerArenaSystem` then `spawnerSystem` unconditionally. With zero Spawner
   entities on Floor 1 the system is a harmless no-op, and the ADR 0036 wiring
   guarantee (no conditional/orphaned systems) is preserved.

`spawnFloor1StaticSpawners` uses a dedicated `spawnerRng` for placement, so the
**init-time** map / mob / item placement RNG is unaffected by removing the
spawners. At **runtime**, however, `spawnerSystem`'s spawn rolls draw from the
shared `world.rng` that also feeds ambient enemy picks, room-wave rolls, and
combat crit/dodge — so removing the four spawners also removes those shared-stream
draws and legitimately shifts downstream shared-RNG consumers. That is why the
collision-pair-parity fingerprints move by more than a naive "fewer enemies"
delta (e.g. seed 137's damageDealt jump): the shift is a real, deterministic
consequence of the removed spawn rolls, verified stable across two runs per seed.

## Consequences

### Positive

- Single, obvious config lever; fully reversible by repopulating one array.
- Pipelines stay uniform and byte-for-byte unconditional — no new Floor-1 fork,
  no ADR 0036 orphaned-system regression.
- Spawn-table source of truth now matches runtime reality on Floor 1.

### Negative

- **The spawner-battle-arena feature (ADR 0044) and its AI lock-in priority
  (ADR 0045) are now dormant on Floor 1.** With no Floor 1 spawners, no arena
  can trigger there. The feature is unchanged and still runs on any floor that
  has spawners; its state machine, barrier arming, and AI lock-in remain covered
  end-to-end by `tests/integration/ai-arena-lockin.integration.test.ts` (which
  hand-builds a barrier-armed arena).
- **`tests/headless/collision-pair-parity.test.ts` goldens were rebaselined**
  for the four sampled seeds. Fewer enemies over the 1500-frame slice — plus the
  removed spawner spawn-rolls that no longer draw from the shared `world.rng`
  stream — shift the combat fingerprints. This is a design-owned change (this
  ADR), verified stable across two back-to-back runs per seed. Before → after
  (kills / damageDealt / damageTaken / finalScore):

  | seed | before           | after            |
  | ---- | ---------------- | ---------------- |
  | 7    | 2 / 118 / 9 / 0  | 4 / 156 / 10 / 0 |
  | 13   | 7 / 229 / 10 / 0 | 6 / 236 / 5 / 0  |
  | 42   | 7 / 261 / 25 / 8 | 7 / 264 / 10 / 8 |
  | 137  | 4 / 122 / 5 / 0  | 6 / 230 / 0 / 0  |

  (All seeds remain `outcome: timeout`, `totalFrames: 1500`. Seed 42's kills and
  finalScore are unchanged.)

- **`tests/headless/spawner-arena-win-rate.test.ts` engagement assertion was
  retired.** The old `expect(anyTriggered).toBeGreaterThan(0)` check is now
  impossible on a spawner-free Floor 1, so it is replaced by its honest inverse
  — `expect(anyTriggered).toBe(0)` asserting Floor 1 stays spawner-free. The
  win-rate floor, AI time-budget, and `armed === 0`-guarded lock-in checks are
  unchanged.

### Risks

- If Floor 1 (or another headless floor sampled by the arena gate) later regains
  spawners, the retired engagement assertion (`=== 0`) and the collision-parity
  goldens will fail loudly. That is intentional: the failing test comments and
  this ADR both instruct the future author to restore the `> 0` engagement
  assertion and re-derive the parity goldens under the new behavior.

## Alternatives Considered

- **Pipeline gating (original PR #836).** Rejected: wrong lever — forks the two
  pipelines on a floor condition, risks an ADR 0036 orphaned-system regression,
  and leaves the spawn table disagreeing with runtime reality.
- **Delete the placement machinery entirely.** Rejected: larger, non-reversible
  diff; loses the one-line re-enable path and the archetype-driven placement code
  that is still valid for other floors.
- **Rescue the old goldens by tuning balance.** Rejected outright per
  constitution rule #13 — the behavior legitimately changed, so the goldens are
  rebaselined honestly; balance is not bent to preserve pre-change fingerprints.
