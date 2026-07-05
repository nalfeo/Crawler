# Spec: Spawner Battle Arena

> **Status:** Proposed
> **Last reconciled:** 2026-07-04
> **Estimated complexity:** 🍎🍎🍎🍎 (touches core spawner AI, room graph, XP
> economy, VFX, and HUD announcements; multi-system by definition — see
> `docs/agent-os/policies/complexity-policy.md`)
> **Related ADRs (existing):** 0012 (multi-safe-room / role pattern),
> 0013 (safe-room runtime system), 0022 (BT kernels), 0025 (spawner
> archetype + on-death finale), 0027 (corpse shatter VFX), 0039 (orphaned
> systems), 0042 (durable player-hit signal). **New ADR to author:**
> `NNNN-spawner-battle-arena.md` covering the arena-lifecycle state machine
> and the sealable-vs-fence fallback decision.
> **Code source-of-truth (planned):**
> `src/game/spawners/spawnerSystem.ts`,
> `src/game/spawners/registry.ts`,
> `src/core/spawner-arena.ts` **(new)** — arena geometry + lifecycle,
> `src/core/systems/spawnerArenaSystem.ts` **(new)** — per-tick trigger &
> resolution, `src/core/systems/dropSystem.ts` (XP redirect),
> `src/core/systems/doorSystem.ts` (arena lock hook),
> `src/engine/EffectsVfx.ts` (new VFX kinds), `src/engine/hud/*`
> (announcement banner), `src/shared/vfx-events.ts` (new `kind`s).
> **Labs:** `src/labs/spawner-lab/` (extend), new
> `src/labs/spawner-arena-lab/` covering both sealable-room and
> open-arena fallbacks.
> **Test suites:** `tests/unit/spawner-arena.test.ts`,
> `tests/unit/dropSystem.spawner-xp.test.ts`,
> `tests/integration/spawner-arena.integration.test.ts`,
> `tests/headless/spawner-arena-win-rate.test.ts` (must remain within the
> global ≥90% Floor 1 win-rate target — Constitution rule 13).
> **Known implementation gaps:**
>
> - No arena/lock concept for spawners today; spawners can be
>   kited outside their spawn zone and cheesed with ranged.
> - Spawned children drop XP the same as normal mobs, so a spawner
>   effectively grants unbounded XP.
> - No "encounter start" banner or dedicated VFX; VFX today is only the
>   per-pulse ripple in `spawnerSystem.ts:emitSpawnerPulse`.

## Context

Spawners (`src/game/spawners/spawnerSystem.ts`, ADR 0025) exist to create
mini-boss encounters (Rat King/Queen, Mama/Papa Slime, etc.) that produce
their own trash mobs. Today the encounter has no shape:

- The player can pull the spawner out of its intended room, or snipe it
  through the door.
- Every child spawned is an independent XP faucet, so a well-timed spawner
  fight is the highest gp/xp-per-minute farm in the game.
- There is no telegraphed start, so the player often does not realize a
  spawner battle is happening until three waves are already alive.

This spec turns each spawner into a bounded, telegraphed **arena
encounter** with an XP-neutral child pool, so spawners become a design
tool for tension instead of a hole in the loot economy.

## Requirements

1. **Every spawner declares a minimum arena radius.** Each entry in the
   spawner registry (`src/game/spawners/registry.ts`) MUST specify
   `arenaRadiusFt: number` (minimum 4 ft, default 6 ft). The arena is the
   closed disc of that radius centered on the spawner at map-generation
   time, projected to walkable tiles.
2. **Sealable-room detection is deterministic and comes from the room
   graph.** At spawner placement, look up the containing room via
   `roomGraph.getRoomAt(spawnerTile)`. A room is _sealable_ iff:
   - it exists in the room graph (i.e. spawner is not in an open corridor
     or cave),
   - every doorway connecting it to another room has a controllable
     `Door` entity (i.e. no wide-open archways),
   - **and** the room's bounding rectangle fully contains the arena disc.
     The result is cached on the spawner as `spawner.arenaKind`
     (`'sealed-room' | 'open-fence'`) and, when sealed, the set of door
     entity IDs is cached as `spawner.arenaDoors`. This decision is made
     once, deterministically, so it is stable across saves and headless
     replays.
3. **Arena triggers when the player enters the zone.** The trigger
   predicate MUST be
   `distance(player, spawner) ≤ arenaRadiusFt` OR
   `roomOf(player) === roomOf(spawner)` when sealable. Trigger is
   idempotent per spawner — a spawner cannot re-lock after it has been
   resolved.
4. **Sealed-room lock.** On trigger for a `sealed-room` arena, each
   cached door entity is set to `locked` via the door system and stays
   locked until the spawner's `deathResolved` flag is set (i.e. the
   on-death finale has fired and the spawner corpse has despawned). No
   entity — player, child, or NPC — may traverse a locked arena door.
5. **Open-fence fallback.** On trigger for an `open-fence` arena, a
   circular impassable barrier is instantiated on the arena disc. The
   fence:
   - blocks player and enemy movement (movement/pathfinding treat the
     ring tiles as `Blocked`),
   - blocks projectiles from crossing in either direction (weapon system
     terminates projectiles on fence intersection the same way it
     terminates on `SAFE_ROOM_FLOOR` boundaries today),
   - is impervious to all damage sources,
   - renders as a shimmering ring (new VFX kind, see §Design).
6. **Spawned mobs drop no experience.** Any enemy whose `Owner.eid` is a
   `Spawner` entity MUST NOT contribute XP on death. This is enforced in
   `dropSystem.ts` at the single choke point — no other system may award
   XP for a spawner-linked kill. Non-XP drops (gold, items) follow the
   normal drop table.
7. **The spawner banks its children's XP and drops it on its own death,
   capped at 10.**
   - Every time the spawner's interval spawner emits a child, add
     `child.xpValue` to `spawner.bankedXp`, up to a **cumulative cap of
     the XP value of 10 average children of the active mode's pool**
     (`bankedXpCap = 10 * poolAverageXp`). The on-death finale wave does
     _not_ contribute to the bank.
   - On spawner death, the drop system awards `bankedXp` in addition to
     the spawner's own `xpValue`, as a single XP orb (or the existing
     drop mechanism — no new drop type).
   - The cap protects the economy from indefinite-kite farming without
     nerfing a legitimate quick kill.
8. **Encounter-start VFX + announcement.** On trigger, exactly one
   `spawnerArenaStart` event is emitted:
   - a new VFX kind `spawnerArenaStart` pushed to `world.vfxEvents`
     (screen-shake ≤200 ms, radial pulse from the spawner in the
     archetype's signature color, plus the fence-ring materialization
     when applicable),
   - an HUD announcement (`world.announcements.push({ kind:
     'spawnerArenaStart', archetypeId, durationMs: 2500 })`) rendered
     by the existing HUD banner slot. The banner reads
     `"<Archetype display name> — Battle begins!"` (e.g. "Rat King —
     Battle begins!").
   - Both effects fire from the same tick as the lock/fence
     instantiation so audio, VFX, HUD, and gameplay stay frame-aligned.
9. **Encounter-end handshake.** When the spawner's `deathResolved` flag
   flips to 1 (finale wave emitted), the arena system MUST, on the same
   tick: unlock cached doors OR despawn the fence, push a
   `spawnerArenaEnd` VFX event, and push a
   `{ kind: 'spawnerArenaEnd', archetypeId }` announcement
   (`"<Archetype> — Cleared!"`). The banked XP is awarded in this same
   step so the player sees "Cleared" and the XP pop simultaneously.
10. **Determinism.** All arena geometry, sealable/open decisions, banked
    XP, and VFX/announcement events derive from `world.rng`, the map,
    and the spawner's own state. No `Math.random()`, no `Date.now()`,
    no wall-clock reads (Constitution rules 3–4).
11. **Wiring.** `spawnerArenaSystem` MUST be referenced from both the
    engine simulation step (`src/engine/sim/simulation-step.ts`) and
    the AI headless runner (`src/game/ai/simulation-step.ts`,
    `src/game/ai/headless-runner.ts`), and added to the wired-systems
    guard, per AGENTS.md rule 15 (orphaned-system guard, ADR 0039). It
    runs after `spawnerSystem` so cached-state reads see the latest
    child counts and death-finale state.

## Design

### Components (new / changed)

- `Spawner` gains four fields (via `bitecs` SoA extension):
  - `arenaRadiusFt: number` — declared at construction from registry.
  - `arenaKind: 0 (sealed-room) | 1 (open-fence)` — resolved once at
    placement.
  - `arenaState: 0 (idle) | 1 (locked) | 2 (resolved)`.
  - `bankedXp: number`.
- `Spawner.arenaDoors` — array of door entity IDs. Because `bitecs` SoA
  cannot store variable-length arrays directly, doors are stored in a
  side map `world.spawnerArenaDoors: Map<number, number[]>` keyed by
  spawner eid, populated at placement and cleared on `arenaState = 2`.
- New singleton `ArenaFence` component (or per-fence entities on the
  ring) representing the impassable, damage-immune barrier. Ring
  segments are tile-aligned so pathfinding sees them via the existing
  blocked-tile mask.

### Systems (new / changed)

- **`spawnerArenaSystem`** (new, `src/core/systems/spawnerArenaSystem.ts`):
  - Iterates `[Spawner, Position]`.
  - `idle → locked`: fires when the trigger predicate (Requirement 3) is
    true. Locks doors OR spawns fence tiles, pushes VFX + announcement.
  - `locked → resolved`: fires when
    `spawner.deathResolved[eid] === 1`. Unlocks/despawns, pushes
    end-of-encounter VFX + announcement, and asks `dropSystem` to grant
    banked XP by emitting a `bankedXpAward` intent on the spawner
    corpse.
- **`dropSystem` change**: on any enemy death, if
  `Owner.eid[eid]` references an entity carrying `Spawner`, skip the
  normal XP award and add `xpValue` to that spawner's
  `bankedXp` (clamped at `bankedXpCap`). On spawner death, grant
  `bankedXp + xpValue` as XP.
- **`spawnerSystem` change**: on interval spawn, publish
  `child.xpValue` to the drop system via the same
  `Owner`-linkage; no direct XP writes.
- **Movement / pathfinding**: `ArenaFence` ring tiles register as
  blocked in the existing tile-blocking mask; no new pathfinder branch.

### VFX / HUD

- New `VfxEffectKind`s in `src/shared/vfx-events.ts`:
  - `spawnerArenaStart` — screen-shake + radial pulse + fence
    materialize (renderer decides which sub-effects apply based on
    `arenaKind`).
  - `spawnerArenaEnd` — muted counterpart; fence dematerializes.
  - `spawnerArenaFence` — persistent shimmering ring while
    `arenaState === locked` (renderer treats this as an owned effect
    keyed by spawner eid).
- HUD announcement: reuse the existing banner slot; add
  `spawnerArenaStart` / `spawnerArenaEnd` announcement kinds with an
  archetype-driven display name lookup.
- All VFX go through `world.vfxEvents`; no engine-layer imports from
  `core` (layer rules).

### Failure modes / edge cases

- **Spawner placed in a corridor/cave** — always `open-fence`.
- **Spawner placed inside a `RoomRole.SAFE` room** — placement is
  rejected at map-generation time (assert); `spawnerArenaSystem` never
  runs on such a spawner.
- **Player dies inside arena** — arena stays locked until the spawner
  is resolved on level respawn or the run ends. If the run continues on
  the same seeded floor, the encounter must be re-triggerable only if
  `arenaState !== resolved`.
- **Headless runner** — must reach `arenaState = resolved` for all
  spawners on a winning seed. Add a headless assertion:
  `assert(spawner.arenaState === 2 for every reachable spawner)`.

## Test Plan

- **Unit** (`tests/unit/spawner-arena.test.ts`):
  - Sealable-vs-open detection given a room graph fixture.
  - Trigger predicate — distance and same-room cases.
  - Banked-XP cap arithmetic (0, 1, 10, 11, mixed pool).
  - Determinism: identical `(seed, floor)` yields identical arena
    kinds, banked totals, and event ordering.
- **Unit** (`tests/unit/dropSystem.spawner-xp.test.ts`):
  - `Owner.eid → Spawner` kills award zero XP to the player and add to
    the bank instead.
  - Spawner death awards `bankedXp + xpValue` in one grant.
- **Integration** (`tests/integration/spawner-arena.integration.test.ts`):
  - Full loop with `spawnerSystem` + `spawnerArenaSystem` +
    `dropSystem` + `doorSystem`.
  - Sealed door blocks player traversal; unlocks on resolve.
  - Fence blocks player, enemies, and projectiles.
- **Headless** (`tests/headless/spawner-arena-win-rate.test.ts`):
  - Full Floor-1 sweep must sustain ≥90% win rate (Constitution rule
    13). Ledger the sweep; do NOT tune down the arena to rescue seeds.
- **Lab** (`src/labs/spawner-arena-lab/`):
  - Manual observation of the sealed-room and open-fence variants +
    banner + VFX. Lab-only validation is **INSUFFICIENT** for shipping
    (AGENTS.md rule 10); the real-artifact proof is the headless suite
    above plus a `npm run dev` capture.

## Constitutional Compliance

| Principle                                                     | How this spec complies                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 — Deterministic core (no `Math.random`)                     | All arena state derives from `world.rng` + map/state; Requirement 10.                                                                                                         |
| 4 — Deterministic timing                                      | No `Date.now()`; system runs per fixed step with `world.elapsedMs`.                                                                                                           |
| 6 — LLM only at floor-load                                    | No LLM at runtime; announcements are template-driven from registry data.                                                                                                      |
| 13 — Observe before done + 90% win rate                       | Headless sweep gate + `npm run dev` capture required before merge. No seed cherry-picking.                                                                                    |
| 14 — Apple-scaled review harness                              | 🍎🍎🍎🍎 → dual-plan synthesis + multi-model review + code-review loop until no concerns; review ledger under `docs/knowledge/review-ledgers/`.                               |
| 15 — Wired-systems guard (ADR 0039)                           | `spawnerArenaSystem` added to `simulation-step.ts` + AI headless runner + wired-systems allowlist NOT permitted — must be genuinely wired. Verified by `check:wired-systems`. |
| Layer rules (core / engine / game)                            | New system lives in `src/core/systems/`; VFX flows via `world.vfxEvents`; HUD is engine-layer only.                                                                           |
| Rule 12 — Never quietly weaken explicit human requirements    | The 10-child XP cap, the fence's total impassability, and the "sealed until spawner dead" rule are load-bearing user requirements. If a gate fails, ask — do not soften.      |

## Docs / index updates required

- `.specify/specs/README.md` — add row to the Current-specs table.
- `docs/systems/04-enemy-ai.md` — cross-reference the new arena system.
- New ADR under `docs/knowledge/adr/NNNN-spawner-battle-arena.md`
  capturing the sealable-vs-fence decision and the banked-XP-cap
  economy call.
- `docs/knowledge/adr/README.md` — index the new ADR.
- `docs/knowledge/memory/` + `docs/knowledge/agent-memory.jsonl` — add
  a durable memory node once shipped ("Spawners are arena
  encounters — do not add per-child XP outside `dropSystem`.").
- Session handoff at
  `docs/knowledge/handoffs/YYYY-MM-DD-spawner-battle-arena.md` with
  `## Systems touched: spawners, drops-loot, doors, vfx, hud, enemy-ai`.
