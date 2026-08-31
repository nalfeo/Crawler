# ADR 0045: AI arena lock-in priority

## Status

Accepted

> Follow-on delta to the spawner-arena feature family. The canonical current
> contract lives in
> [`.specify/specs/spawner-battle-arena.md`](../../../.specify/specs/spawner-battle-arena.md).

## Date

2026-07-04

## Estimated Complexity

🍎 x 2 — pure detector plus one new BT priority slot; no new systems, but
must not regress the existing headless win-rate floor.

## Context

PR #764 introduced spawner **battle arenas**: when the player enters a
spawner's arena radius, the spawner "locks" — a fence-tile ring or a
sealed room seals the player in until the spawner (or its post-death
monarch pool) dies. That PR shipped the arena mechanic itself but noted
a caveat: on natural Floor-1 runs the BT AI sometimes walked _past_ a
triggered arena without engaging it. Boss rooms (Slime Rat mid-floor
boss, Rat Slime staircase boss) exhibit the same class of problem when
door locks close behind the player.

The user's requirement is verbatim:

> AI needs to know when it is stuck in an arena, like a spawner nest or
> a boss room, and prioritize the objective.

## Decision

We add a new BT Track A priority slot — **1.5 (Arena lock-in)** —
between Retreat (priority 1) and Interact (priority 2). It is driven by
a pure detector `detectArenaLockin(world, px, py)` living at
`src/game/ai/arena-lockin.ts`.

### Priority slot placement

```
1.   Retreat            (low HP — life-critical, still trumps arena lock-in)
1.5  Arena lock-in      (NEW: physical cage → prioritize the objective)
2.   Interact           (NPCs — irrelevant if we can't leave)
3.   Progress           (progression objective — same reason)
3.5  Leave Safe Room
4.   Engage
5.   Collect
6.   Hunt
7.   Explore
```

Retreat still outranks lock-in because losing all HP is worse than
letting the arena drag on. Everything else is preempted: interact,
progression, wander/explore are all reachable _after_ the objective
dies and the fence lowers, so we owe the player a decisive fight, not a
tour of the sealed room.

### Two lock-in sources

1. **Spawner arena.** Iterate `[Spawner, Position, Health]`; for each
   locked spawner (`arenaState[eid] === 1`, `deathResolved === 0`, HP >
   0), a **barrier-verified** check ensures a real cage exists — either
   `world.spawnerArenaFence.get(eid)?.length > 0` (open-fence ring) or
   `world.spawnerArenaDoors.get(eid)?.length > 0` (sealed room). If yes,
   the player must be _inside_ the cage:
   - Open fence: `distance(player, spawner) ≤ arenaRadiusFt + 0.5`.
   - Sealed room: player's tile is in the same room as the spawner.
2. **Boss room.** Iterate `world.floor1?.objective?.bossBattles`; the
   boss must be alive and the player's tile must be inside the boss
   room.

The barrier-verified rule is important: `spawnerArenaSystem` sets
`arenaState=1` optimistically, but on natural Floor-1 the fence and
door snapshots often come back empty (spawner placement outside a room,
ring band with no passable tiles to convert). In those cases the
"arena" doesn't actually trap the player and the AI should be free to
walk on. Requiring at least one snapshot entry keeps the detector
faithful to _physical_ lock-in.

### Tie-breakers

If both a spawner and a boss lock-in are active, the **spawner wins**:
it's the more localized cage (fence ring ≤ ~8 ft radius vs a whole
boss room). Between multiple locked spawners, the lowest `eid` wins.
Both rules are deterministic — no RNG in the detector.

## Consequences

### Positive

- Users no longer see the AI "walk past" a triggered spawner arena.
  Both halves of the observable contract are exercised in tests:
  1. **Synthetic sweep** (`tests/headless/ai-arena-lockin-resolution.test.ts`):
     hand-armed rats-nest arenas across 8 seeds. Result: **100 %
     (8/8) resolved** within a 60 s budget.
  2. **Natural sweep** (`tests/headless/spawner-arena-win-rate.test.ts`):
     Floor-1 seed sweep, unchanged win-rate floor. The new
     `resolved / barrierArmed ≥ 0.95` gate is vacuous on the current
     Floor-1 fixture (0 barrier-armed arenas) — the synthetic sweep
     covers that half of the contract.
- Boss rooms benefit from the same detector at no extra cost: the two
  code paths converge on the same "set target + return SUCCESS"
  behavior.
- Detector is a pure function; unit-testable and cheap to call every
  BT tick (single small loop over spawner slots + boss-battle map).

### Negative

- Adds one more per-frame allocation-free scan of the spawner store.
  Bounded by the number of live spawners on the floor (≤ ~20) so the
  cost is negligible.
- The "spawner wins over boss" tie-breaker is a call we might revisit
  if a future boss room legitimately overlaps a spawner arena. Today
  no such overlap exists.

### Risks

- If a future spawner archetype installs a _symbolic_ lock (sets
  `arenaState=1` but no fence/doors), the AI will silently ignore it.
  This is by design — the detector's whole point is "am I _physically_
  stuck?" — but the coupling should be noted.
- If Retreat is too eager, we might see the AI break lock-in on chip
  damage and never re-commit. The synthetic sweep would catch that
  regression as the resolved rate would drop below 95 %.

## Alternatives Considered

1. **Rely on Progress or Engage to notice the arena.** Rejected — those
   priorities operate on a run-plan target or the nearest enemy, both
   of which can point _outside_ the arena and pull the AI toward a
   locked-out fence tile.
2. **Insert lock-in above Retreat.** Rejected — surviving matters
   more than fighting on principle; a corpse doesn't resolve the arena
   either. Retreat still wins.
3. **Drop the barrier-verified check.** Rejected — that regressed the
   existing natural-Floor-1 win rate because the AI committed to
   spawners whose "arena" never actually trapped it, incurring
   avoidable engagements.

## Acceptance Metric

`resolved / triggered ≥ 0.95` across a synthetic 8-seed barrier-armed
sweep. Currently **100 %** (8/8). The same ratio on the natural
Floor-1 sweep is reported but currently vacuous because that fixture
produces zero barrier-armed arenas; if a future Floor-1 change starts
producing real barriers, the gate becomes active automatically.

## Related

- PR #764 (parent) — the arena mechanic itself.
- `src/game/ai/arena-lockin.ts` — the detector.
- `src/game/ai/bt-ai-provider.ts` — `buildArenaLockinBehavior` and the
  priority slot wiring.
- Review ledger: `docs/knowledge/review-ledgers/2026-07-04-ai-arena-lockin-priority.review-ledger.json`.
