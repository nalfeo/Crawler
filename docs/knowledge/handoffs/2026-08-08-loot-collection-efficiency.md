# Session Handoff: AI loot-collection efficiency (A/B arm A3)

## Date

2026-08-08

## Persona

Game AI Engineer → Producer (PR publication)

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-headless-runner, loot-and-drops, floor-progression

## Apples

4🍎 estimated, 4🍎 actual (🎯 exact) — cross-layer measurement counter in `src/core/`
plus three coordinated `src/game/ai/` behavior changes, ADR required.

## What Was Done

Closed the "the AI walks right past free XP/gold while adventuring" gap, measured on
the 72-run Floor-1 gate matrix (seeds 1–24 × sword/bow/baseball-bat).

1. **Loot ledger** (`src/core/world.ts`, `spawnXpGem`/`spawnGold`, `itemPickupSystem`):
   additive `xpSpawned`/`xpCollected`/`goldSpawned`/`goldCollected` counters, surfaced
   as `RunStats.lootEfficiency` from `runHeadless`. This is the instrument — before it
   existed, the only signal was an end-of-run ground scan that cannot see pickups
   destroyed by a floor transition and ignores gold entirely.
2. **Windowed loot sweep**: `buildPreExitXpSweepBehavior` → `buildLootSweepBehavior`,
   now also targeting gold, with a post-combat local window (`LOOT_SWEEP_RADIUS_FT = 12`)
   in addition to the pre-exit unbounded window.
3. **Trivial pickup snap** (`TRAVEL_LOOT_SNAP_FT = 5`) in `pickSafeTravelHeading`:
   the corridor loot bias only _curves_ the arc, so the runner slid past gems without
   overlapping them. The snap steers straight at a pickup within 5 ft when the lane
   probes passable, the candidate is predicted-safe, no threat is perceived, and no
   panic beeline is active.
4. **Loot-aware stair-descend deferral** (`shouldDeferStairDescend`): the driver used
   to confirm the descend the instant the boss died, destroying the boss drops. Now it
   holds while loot remains, bounded by `MAX_STAIR_DESCEND_DEFER_FRAMES = 1800` and
   gated by `LOOT_SWEEP_PANIC_THRESHOLD`.

**Observed in the real artifact** (`npm run ai:headless`, the 72-run gate matrix — not a
lab): before — combined collection ratio 0.7795 with 71/72 wins; after — **0.7919 with
72/72 wins**, mean floor time 257.3 s → 258.4 s.

## Key Decisions Made

See [ADR 2026-08-08 loot-collection-efficiency](../adr/2026-08-08-loot-collection-efficiency.md).

- Every knob is justified by a recorded 72-run measurement sitting next to the constant.
  Rejected arms are recorded too, because each of them **lost runs**: sweep radius 35 ft
  → 0.7254 / 70 wins; `TACTICAL_OPPORTUNITY_MAX_DETOUR_FT` 8→12 (arm A5) → 0.7854 /
  70 wins; allowing the snap while threatened cost the bow persona 3 wins.
- Rule 12 is the ordering rule throughout: **win-rate first**, collection ratio second.
  Every arm that raised mean level but lost a run was rejected.
- The deferral budget is charged only while the descend is otherwise confirmable
  (i.e. standing inside the stair marker), never during the walk there.
- `combinedRatio` mixes XP points and gold units and is cumulative across floors, so it
  is documented as a **same-seed-matrix comparison metric**, not an economic quantity.

## What's Next / Blockers

- **Floor 2 is unmeasured.** The sweep and the descend deferral apply there too
  (symmetrically, and Floor 2 has no collapse timer so nothing can be lost to a
  deadline), but there is no Floor-2 win-rate matrix backing it. Worth its own sweep.
- The sweep's 12 ft window is Euclidean, not path-cost. A path-relative budget (like
  `TACTICAL_OPPORTUNITY_MAX_DETOUR_FT` uses) is the principled version; the narrow
  radius makes the difference small in practice, but it is the next refinement if the
  window is ever widened.
- `auto-progression.ts` imports collapse-panic helpers from the concrete
  `bt-ai-provider`. Same layer, so no lint violation, but extracting a provider-neutral
  urgency policy would decouple the driver from one AI implementation.

## Retrospective

### Lessons Learned

- **Build the metric before tuning the behavior.** Every earlier attempt at this was
  guesswork because no collection metric existed. The ledger took an hour and made five
  subsequent arms decidable in one 72-run run each.
- **Widening a loot knob reliably makes collection worse, not better.** Three separate
  arms (35 ft sweep, 12 ft detour, snap-while-threatened) all traded on-path pickups for
  longer errands: mean level went _up_ while wins went _down_. Narrow windows won every
  time.
- The adversarial plan review caught a real bug that all the sweeps missed: the descend
  deferral drained its whole 1800-frame budget during the walk to the stairs, so by the
  time the AI arrived there was no budget left to actually defer with. A behavioral
  measurement can be green while the mechanism it measures is half-broken.

### Mistakes Made

- Ordered the deferral check before the stair-proximity check, which silently made the
  frame budget a wall clock. Early signal: a bounded "budget" that is decremented on a
  code path where the guarded action _cannot_ happen is always wrong — charge the budget
  at the point of the action, not at the point of intent.
- Shipped `combinedRatio` as a single headline number without documenting that it sums
  two different units across floors. It is fine as an A/B comparator and misleading as
  anything else; the caveat now lives on the type.
- Equidistant snap targets were resolved by caller scan order rather than entity id — a
  latent determinism hole that no test would have caught until a replay diverged.

### Opportunities for Future Improvement

- Promote `lootEfficiency.combinedRatio` into a deterministic headless gate with a
  ratchet (like the perf fingerprint), so a future change cannot silently regress
  collection back toward 0.78.
- Give the sweep a path-time budget instead of a Euclidean radius, then re-measure
  whether a wider window becomes affordable.
- Attribute the ledger per floor id so Floor 2 can be measured independently without
  cross-floor contamination of the ratio.
