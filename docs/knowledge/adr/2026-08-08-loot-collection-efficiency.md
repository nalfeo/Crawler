# ADR 0083: Loot-collection efficiency — deterministic loot ledger, windowed loot sweep, trivial pickup snap

## Status

Accepted

## Date

2026-08-08

## Estimated Complexity

🍎 x 4 — new cross-layer measurement counter in `src/core/` plus three coordinated
behavior changes in `src/game/ai/` (behavior tree, travel steering, auto-progression
driver); runtime gameplay behavior changes, so the tooling ceremony cap does not apply.

## Context

The headless AI runner visibly "walks right past free XP while adventuring". Three
independent mechanisms produced that behavior:

1. **No collection metric existed.** The only accounting was
   `computeXpOnGroundAtEnd(world)`, an end-of-run ground scan. It cannot see loot
   that was destroyed by a floor transition (descending restarts the scene with a
   fresh entity world), and it ignores gold entirely — so "did this change collect
   more?" was unanswerable, and any tuning was guesswork.
2. **Sweeping was pre-exit only.** `buildPreExitXpSweepBehavior` fired only once the
   staircase was unlocked, and only for XP gems. Drops from a fight in the middle of
   the floor were left on the ground for a sweep that the collapse-panic gate often
   cancels outright.
3. **The corridor loot bias only curves, it never touches.** Pickups are collected by
   body overlap, but `TRAVEL_W_LOOT` / `TRAVEL_LOOT_CORRIDOR_FT` only bias the travel
   arc toward loot. The runner routinely slid a foot past a gem without overlapping
   it.

Project rule #12 makes win-RATE the primary gate, so every candidate change had to be
measured over the 72-run Floor-1 gate matrix (seeds 1–24 × sword/bow/baseball-bat)
rather than on cherry-picked seeds.

## Decision

- **DEC-001**: Add a `LootLedger` to `GameWorld` (`src/core/world.ts`) — purely
  additive `xpSpawned`/`xpCollected`/`goldSpawned`/`goldCollected` counters,
  incremented by `spawnXpGem`/`spawnGold` and `itemPickupSystem`. Counters are never
  decremented or reset mid-floor, so `collected / spawned` is a deterministic
  collection-efficiency ratio that survives pickups being destroyed. Surfaced as
  `RunStats.lootEfficiency` from `runHeadless`. The ledger is the measurement
  instrument the rest of this ADR is judged by.
- **DEC-002**: Generalize the pre-exit XP sweep into a **windowed loot sweep**
  (`buildLootSweepBehavior`) that also targets gold. Two windows share one BT node:
  a **post-combat local** window bounded by `LOOT_SWEEP_RADIUS_FT = 12` ft, and the
  existing **pre-exit unbounded** window once the staircase is unlocked. Only XP and
  gold are swept — both are pure value with no inventory or interaction cost.
- **DEC-003**: Add a **trivial pickup snap** (`TRAVEL_LOOT_SNAP_FT = 5`) to
  `pickSafeTravelHeading`: steer straight at the nearest pickup within the snap
  radius instead of merely biasing the arc. The snap is taken only when the direct
  lane probes passable at 1 ft granularity, the candidate remains predicted-safe, no
  panic beeline is active, **and no threat is perceived at all**.
- **DEC-004**: Let the auto-progression driver **defer the automated stair descend**
  while uncollected loot remains (`shouldDeferStairDescend`), bounded by
  `MAX_STAIR_DESCEND_DEFER_FRAMES = 1800` (30 s at 60 fps) and gated by the same
  `LOOT_SWEEP_PANIC_THRESHOLD` as the sweep itself. Without this the driver confirms
  the descend the instant the boss dies and throws away the boss drops the AI just
  earned. Budget state lives in a per-world, per-floor `WeakMap`, so a fresh world
  starts at 0, no module-level state leaks across runs, and Floor 1 cannot spend
  Floor 2's budget. The budget is charged only while the descend is otherwise
  confirmable (player inside the stair marker), never during the walk there.
- **DEC-005**: Every knob above is gated on a **72-run measurement**, recorded as a
  comment next to the constant it justifies. Changing one requires a fresh 72-run
  measurement, not intuition.

## Consequences

### Positive

- Collection efficiency is now a first-class, deterministic run metric
  (`combinedRatio`), so future loot/AI tuning is measurable instead of anecdotal.
- Measured over the gate matrix: combined collection ratio **0.7795 → 0.7919** with
  win-rate **71/72 → 72/72** and mean floor time 257.3 s → 258.4 s.
- Gold is swept for the first time, which feeds the shop/equipment economy the AI
  already depends on.
- Boss-room drops are no longer destroyed by an instant descend.

### Negative

- The loot sweep and the snap both spend travel time that previously went to the
  objective (~1 s mean floor time). On a floor with a tighter collapse deadline this
  margin is smaller.
- `GameWorld` grows another mutable sub-object, and two more call sites
  (`spawnXpGem`/`spawnGold`, `itemPickupSystem`) must stay in sync for the ratio to
  be meaningful.
- The stair-descend deferral makes the descend timing depend on floor loot state,
  which is one more input to reason about when debugging a stuck run.

### Risks

- **Widening any of these knobs actively loses runs.** Measured: sweep radius 35 ft →
  0.7254 / 70 wins; `TACTICAL_OPPORTUNITY_MAX_DETOUR_FT` 8 → 12 → 0.7854 / 70 wins;
  allowing the snap while threatened cost the bow persona 3 wins. The mitigation is
  DEC-005: no knob moves without a fresh 72-run measurement.
- The snap's short-range wall probe samples every 1 ft; a geometry change that makes
  1 ft too coarse would let the runner grind into a wall. Bounded by the 5 ft radius,
  so the worst case resolves in a few frames.
- The deferral budget is per-world/per-floor. A pathological world reused across _runs_
  would share it; `runHeadless` builds a fresh world per run, so this is currently
  unreachable.

## Alternatives Considered

- **Raise the existing corridor loot weight (`TRAVEL_W_LOOT`) instead of adding a
  snap.** Rejected: the corridor bias curves the arc but never guarantees the body
  overlap that actually collects a pickup, which is the exact failure being fixed.
  Raising it enough to guarantee overlap distorts travel far from the objective.
- **Sweep the whole floor after every fight (large `LOOT_SWEEP_RADIUS_FT`).**
  Measured and rejected: 35 ft dropped collection to 0.7254 and lost two runs — the
  sweep turned into cross-room errands that burned the collapse deadline.
- **Keep pre-exit-only sweeping and rely on the descend deferral alone.** Rejected:
  the pre-exit window is the one most often cancelled by collapse panic, so it is the
  least reliable place to do the collecting.
- **Measure collection with an end-of-run ground scan instead of a ledger.**
  Rejected: the scan cannot see pickups destroyed by a floor transition and misses
  gold, so it systematically overstates efficiency.
