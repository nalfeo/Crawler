# ADR 0055: Decouple a door's logical-open latch from its physical tile state

## Status

Accepted

## Date

2026-07-10

## Estimated Complexity

🍎 x 3 — touches door mechanics (`src/core`) and the AI pathfinding revision memo
(`src/game`); a full bitecs component-field migration (`isOpen` → `logicalOpen` +
new stored `effectiveOpen`) plus a seeded regression test. Scoped at 5🍎 pre-work;
actual substantive logic is ~50 lines, the rest a mechanical rename.

## Context

Floor-1 seeds 64 & 80 timed out with the floor boss never spawning; the bow AI stalled
one tile short of an open boss room. Root cause was an **edge-vs-level authority conflict
on a dual-role door**:

- The Floor-1 map generator can place `bossStairRoom` adjacent to `safeRoom`, so the two
  rooms **share a single connector door entity** that is simultaneously a boss-room gate
  and a safe-room door.
- The one-shot safe-room unlock **edge** fires only while `wasLocked === true`
  (`doorState.isLocked[eid] === 1` on the prior frame).
- On the same frame the edge fired (`isOpen=1`, `isLocked=0`), the ambient safe-room
  **force-close** clobbered the door-open field back to `0` while leaving `isLocked=0`.
- The reconcile pass then also drove the tile closed. End-of-frame the door was
  `isLocked=0`, open-field `0`, tile impassable — a **permanent unlocked-but-closed wall**.
  The unlock edge could never re-fire (it requires `wasLocked`), so the boss room stayed
  unreachable and the floor boss never spawned.

The single `doorState.isOpen` field was overloaded to mean both "this door is intended to
be open" (a logical latch owned by the lock/unlock state machine) and "this door's tile is
physically passable right now" (a per-frame derived fact). The force-close authority mutated
the **latch** to achieve a **physical** effect, corrupting the state machine's invariant.

## Decision

Split the two meanings into two fields on the `doorState` bitecs store and make the physical
truth a **derived, stored** value:

- **`logicalOpen`** (renamed from `isOpen`) — the intended-open **latch**. Written **only**
  by lock/unlock authorities. Never mutated for a physical effect.
- **`isLocked`** — unchanged; the lock state.
- **`effectiveOpen`** (new `Uint8Array`) — the physical/tile truth, **derived and stored by
  `doorSystem` reconcile every frame** as
  `effectiveOpen = logicalOpen && !isLocked && !isForcedClosed`. The tile is driven from
  `effectiveOpen`.

Force-close now closes only the **tile** for that frame; it never clobbers the latch. So a
forced-closed shared door keeps `logicalOpen = 1`, and when the seal lifts `effectiveOpen`
recomputes to `true` and the door reopens — no edge re-fire needed.

The AI pathfinding revision memo (`getDoorRevision` in `enemyAISystem.ts`) hashes the **live
tile passability** (`tileMap.isPassable(tx, ty)`), not the stored `effectiveOpen` mirror. A floor
objective authority — `floor1ObjectiveTick`, invoked by `floorObjectiveSystem` **after**
`doorSystem` — can call `tileMap.openDoor(...)` and set `logicalOpen` on boss / mini-boss defeat.
Because `effectiveOpen` is only reconciled inside `doorSystem` (which already ran earlier that
frame), the stored mirror stays stale until the **next** frame's `doorSystem` pass — one AI tick
after the tile is already passable. Hashing the live tile picks the opening up immediately, matches
the pre-migration `isOpen` timing exactly, and is what A\* / flow-fields actually read.

This is the full-migration option the maintainer selected over a narrower fix.

## Consequences

### Positive

- The authority conflict is structurally resolved: force-close can no longer corrupt the
  lock state machine's latch, so the permanent-seal class of bug is eliminated (not just the
  two known seeds). Real-headless proof: seeds 64 & 80 flip timeout → victory with the floor
  boss spawning; the byte-identity golden (`collision-pair-parity`) stays 5/5.
- The door contract is now self-describing: latch vs lock vs physical truth are three named
  fields with a single explicit derivation formula in one place (reconcile).
- The AI memo is more correct — it tracks what the pathfinder reads (live passability) rather
  than a lagging mirror.

### Negative

- A wide mechanical rename: every `doorState.isOpen` read/write across source, labs, and tests
  became `logicalOpen`, and the new `effectiveOpen` field must be kept in sync.

### Risks

- **bitecs payload footgun (mitigated):** `set(DoorState, { isOpen: 1 })` payload keys are
  loosely typed, so a stale `isOpen:` key would silently stop populating without a compiler
  error. Direct-store access (`doorState.logicalOpen[eid]`) is TS-typed and compiler-checked.
  Both confirming code reviews grepped the whole tree for stray `isOpen` payloads → zero.
- **Latent, pre-existing (out of scope, flagged):** Floor-2+ `spawnerArenaSystem.unlockRoomDoors`
  sets `isLocked = 0` but not `logicalOpen = 1` on arena end. This is unchanged by this ADR
  (the old code never set `isOpen = 1` there either) and is not a regression; a follow-up may
  address it.

## Alternatives Considered

The adversarial plan review (gpt-5.4, high effort) enumerated four fixes and argued against
each non-chosen one:

- **F1 — semantic skip in force-close:** safe-room force-close skips a door that is an
  unlocked progression gate (`wasUnlocked && !isLocked`). Smallest change, but leaves `isOpen`
  overloaded and only patches the one code path.
- **F2 — level-derived reopen:** reconcile re-opens when `(wasUnlocked && !isLocked)` even
  after a clobber. Broader door-model change with more surface to test, still keeps the
  overloaded field.
- **F3 — map-gen constraint:** forbid `bossStairRoom` sharing a door with `safeRoom`. Changes
  generated geometry broadly and does not fix the underlying `doorSystem` fragility.
- **F4 (bare) — decouple in reconcile only:** force-close closes only the tile; drop the
  latch clobber. Correct direction but changes what `isOpen` means without auditing consumers
  or naming the physical truth.
- **Strengthened-F4 (chosen direction, then extended to full migration):** the maintainer
  chose the full field rename + stored `effectiveOpen` + migrate all writers, so the latch /
  lock / physical-truth contract is explicit in the schema itself rather than left as a
  documented convention on an overloaded field.
