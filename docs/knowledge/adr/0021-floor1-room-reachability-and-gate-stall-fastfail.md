# ADR 0021: Floor 1 room-reachability guarantee and headless gate stall fast-fail

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — touches map generation (`src/core/map`) and the headless AI gate
(`src/game/ai`), two layers, with a new pure module, a lab extension, and
synthetic + integration tests. No new ECS system (no lab-gate obligation), but the
reachability invariant and the gate's stall semantics each affect multiple systems,
so an ADR is warranted.

## Context

ITEM #3 began as "improve BT exploration (prefer unexplored tiles, navigate to
POIs, remember locked doors, reduce wiggle)." Investigating it empirically — per
the steer "examine where it gets stuck… it can't actually reach something" — a
seed sweep (weapons × seeds, 5-minute budget) showed a hard cluster of seeds that
**no weapon and no amount of AI tuning** could beat. The character was not making a
_decision_ error; the floor was physically unwinnable.

Two distinct root causes, at two layers:

1. **Sealed objective rooms (map generation).** rot-js's Uniform generator
   occasionally emits a room whose only corridor link fails to reach the spawn
   component. `cullIsolatedFloorTiles` (which floods from spawn and walls off any
   unreached passable tile) then seals that room's _entire interior_ in solid rock.
   On Floor 1 the affected room is usually the farthest one — exactly the room
   `preAssignRoles` tags `BOSS_STAIR` — so the descent staircase (the floor exit)
   is stranded behind solid wall. `preAssignRoles`' connectivity guard only checks
   the door _tile_ and runs before room-variety post-processing, so it misses this
   case. Result: the floor cannot be completed by any means on those seeds.

2. **No quest-level stall signal in the headless gate.** The in-AI watchdog from
   ADR 0020 tries to _recover_ from a quest-progress stall (relocate at ~100s). But
   when recovery is impossible (e.g. a sealed room, or a weapon too weak to clear a
   seed's starting swarm), the headless runner had no quest-aware termination: it
   spun to the full ~5-minute frame cap and reported a bare `timeout`, telling a
   maintainer _nothing_ about why the seed failed. The runner's only early-out was
   `game_over`; everything else burned the whole budget.

Both read as "stuck in a loop, can't reach the thing it needs" — the unifying
symptom. The exploration directives (frontier BFS, locked-door memory, dwell
re-anchoring) were already present and were not the bottleneck; the structural
reachability bug was.

## Decision

### 1. Guarantee every room is reachable before the cull (`ensureRoomsReachable`)

Insert a deterministic, RNG-free pass in `DungeonGenerator.generate()` between
`paintRoomFloor` and `cullIsolatedFloorTiles`. For each room whose passable
interior is unreachable from the spawn, it carves a minimal corridor connecting the
room (via its door tiles, so door gating is preserved) to the spawn-reachable
component. It runs in two phases so locked-door gating stays intact:

- **Phase 1 — non-boss rooms, routed _around_ the locked boss room.** A flood that
  treats the boss room's bounds + doors as impassable (`buildRoomBlockMask`)
  decides reachability, and carved connectors are forbidden from traversing that
  mask. So a gate-quest room (shop, fetch item) is never linked _through_ the boss
  room — which would deadlock the floor behind the boss lock. Only rooms that are
  **truly** isolated (sealed even with every door treated as open) are carved;
  rooms legitimately reachable only through the boss room are left byte-identical.

- **Phase 2 — the boss-stair room itself,** routed to its own door so the lock
  still governs entry.

Determinism & safety: the pass consumes **no RNG** (fixed neighbour order, BFS by
insertion order), so all downstream procedural placement is unshifted, and it is a
**strict no-op** for already-connected seeds — a well-formed floor's tile flags and
terrain are unchanged. `ensureRoomsReachable` is exported purely for unit testing.

### 2. Reframe the headless gate's stall detection around quest progress

Add a small pure module `src/game/ai/quest-stall.ts` and wire it into
`headless-runner.ts` as a **gate-level fast-fail** (distinct from ADR 0020's in-AI
_recovery_ watchdog):

- `QuestProgressStallTracker` keys on the same `computeFloorProgressScore(quests,
gold)` fingerprint ADR 0020 introduced — quest-objective ticks/completions
  weighted far above gold — rather than on movement goals or position. It reports a
  stall when the running-max score has been frozen for `questStallFrames`
  (default 9000 ≈ 150s).
- 150s sits deliberately _above_ the in-AI watchdog's ~100s relocate, so the AI
  gets a full recovery cycle before the gate gives up. Measured max inter-progress
  gap on healthy winning runs is ~50s, so it never false-fires a legitimate run.
- On a stall the run ends with a new `'stalled'` outcome and a
  `formatQuestStallReason` diagnostic — e.g. `completed: [floor1-find-welcome],
stalled on: [floor1-tutorial]` — surfaced by the CLI. A maintainer learns _which
  quest_ wedged instead of reading a bare timeout.

`'stalled'` is a non-victory outcome, so the completion gate still fails (correctly)
on a stuck seed — just faster and with a reason. Only `'victory'` is special-cased
elsewhere, so the new outcome is safe to add.

### 3. Lab coverage

Extend `map-gen-lab` with a **reachability overlay** (unreachable passable tiles and
sealed-room outlines render red — always empty after the fix) and a **Seed Sweep**
button that regenerates seeds 1–60 for the current biome and reports any sealed
rooms. A regression in the guarantee is then immediately visible in the lab.

## Consequences

### Positive

- Floor 1 is structurally completable on every seed: no objective or boss-stair
  room can be sealed in rock. The formerly-unwinnable seed cluster now wins.
- The headless gate fast-fails a genuinely stuck seed in ~150s with a quest-level
  reason instead of burning the full ~5-minute budget on an opaque timeout.
- The reachability invariant is guarded three ways: synthetic unit tests on
  `ensureRoomsReachable`, an integration test that regenerates the real Floor 1
  across seeds (incl. the four that reproduced the sealed boss room) and asserts no
  room is sealed, and a visual lab sweep.

### Negative

- `generate()` runs up to a few extra spawn-floods on affected seeds. Negligible
  versus rot-js generation, and skipped entirely (single flood, no carve) for
  well-formed seeds.

### Risks

- The carver assumes a room's door tiles are the intended entry. Door-less rooms
  fall back to carving from the interior perimeter, which can produce a slightly
  unnatural corridor — acceptable, since the alternative is an unwinnable floor.
- A mis-set `questStallFrames` could fast-fail a legitimately slow run. It is set
  ~3× the measured healthy max gap and above the in-AI relocate window; every gated
  weapon × seed combo passes with the watchdog active, confirming no false-fire.

## Alternatives Considered

- **Fix `preAssignRoles`' connectivity guard instead.** It runs before room-variety
  post-processing and only inspects the door tile, so hardening it there is fragile
  and order-dependent. A dedicated reachability pass immediately before the cull is
  the single, authoritative chokepoint and is provably a no-op otherwise.
- **Re-roll the seed when a room is unreachable.** Re-rolling consumes RNG and
  shifts all downstream placement, breaking determinism and the seed → layout
  contract that the gate and saved runs depend on. Carving is deterministic and
  local.
- **Open the boss door / merge the boss room into the spawn component.** That
  removes the lock gating the floor's climax. Phase 2 routes to the door instead,
  preserving the lock.
- **Keep the in-AI watchdog as the only stall signal.** It is a _recovery_
  mechanism; it cannot terminate or explain an unrecoverable run. The gate needs an
  independent fast-fail, which is what this adds.

## Related

- ADR 0020 — projectile leading + the in-AI quest-progress recovery watchdog and
  the `computeFloorProgressScore` fingerprint this builds on.
