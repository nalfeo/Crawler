# ADR 0099: Floor 6 Slice 3 — wave director authority, route-following AI seam, and component contract

## Status

Accepted

## Date

2026-09-01

## Estimated Complexity

🍎 x 4 — cross-layer coordination: new ECS component, director state extension, route AI seam, manifest validation, terminal precedence.

## Context

Slice 3 adds the single-authority wave director, immutable seeded wave manifests, bounded live-cap/debt, terminal-loss precedence, and route-following raider AI to Floor 6. This involves:

- A new ECS component (`BroadcastRelayRaider`) in `src/core/` — a cross-layer decision.
- The director (`floor6DefenseDirectorSystem`) running in `game/` but writing mutable fields on `Floor6DefenseState` (owned by `world.floorExtendedState`).
- The route AI (`floor6RaiderSystem`) driving entity velocity directly using authored geometry waypoints rather than A\* pathfinding.
- An enemy pack registered in `src/shared/enemy-packs.ts` for archetype validation.
- Manifest/tuning values in the floor manifest JSON rather than hard-coded constants.

The living requirements are [the Floor 6 spec](../../../.specify/specs/floor6-hold-for-renovation.md). The architecture baseline is [ADR 0097](0097-floor6-hold-for-renovation.md).

## Decisions

### D1 — `BroadcastRelayRaider` lives in `src/core/components.ts`

The component is a pure ECS identity tag with a typed-array store. `src/core/` imports nothing from `game/` or `engine/`; the component needs no Floor 6 business logic. Placing it in `core/` allows the raider system (in `game/`) and future systems (e.g. towers in Slice 5) to query raiders without circular imports.

### D2 — Director and raider systems both live in `src/game/floor6Scenario.ts`

The director writes `world.floorExtendedState.floor6Defense` (mutable phase/manifest state); the raider reads the same state for route lookups. Both belong in `game/` because they reference floor-specific state and the shared enemy-pack registry. Neither imports from `engine/` or `labs/`.

### D3 — Wave manifest is authored data, not seeded RNG selection

The `floor6.manifest.json` carries the full authored wave schedule (wave groups, archetype IDs, route indices, release ticks). The `waves` and `routes` RNG streams are reserved for future Slice 3+ extensions (randomized sub-phases, procedural adds) but are not consumed by the Slice 3 director. This keeps the manifest byte-identical across seeds (only stream keys vary) and makes replay determinism trivially provable.

### D4 — Relay HP lives in `Floor6DefenseState`, not an ECS entity

In Slice 3 the Relay has no ECS entity; its HP is an integer in the director state decremented when raiders reach the relay target tile. Slice 5 (tower construction) may promote the Relay to a full entity when towers need to target it — this ADR records the intent so the promotion doesn't silently change the authoritative writer.

### D5 — Raider movement uses authored waypoints, not A\*

Routes have authored waypoints computed by `computeBroadcastRelaySetLayout`. The raider system steps toward each waypoint in order and advances the waypoint index on arrival. This avoids A\* re-invocation per raider per tick, keeps movement deterministic, and makes stall detection straightforward (stillFrames counter on the component store).

### D6 — Terminal precedence is checked in the director, not in core damage/death systems

The director owns the ONLY phase-write path. It checks player death, relay HP, and stall backstop in that order at the start of each DEFEND tick, before wave release (FR2.2). This guarantees that a same-tick relay-destruction event always produces DEFEAT even if a wave entry also became due on the same tick.

### D7 — Numeric tuning values are manifest-driven

All values (`relayMaxHp`, `liveCap`, `spawnDebtCap`, `stallBackstopFrames`, `raiderSpeedFtPerFrame`, etc.) live in `floor6.manifest.json` under `floor6.tuning`. The S9 balancer can change any value without editing source. The schema validates types; the director reads them through `getFloor6Config().tuning`.

## Consequences

### Positive

- Single authority for all phase/manifest writes; UI, AI, and combat systems cannot silently become directors.
- Manifest is byte-identical for the same authored schedule regardless of seed — only stream keys carry the seed.
- Terminal precedence is in one place, auditable, and covered by a focused test.
- Raider waypoint following is O(n) per tick without pathfinding overhead.
- Relay HP is fully under director control with no ECS query needed.

### Negative

- Relay is not an ECS entity in Slice 3, so towers (Slice 5) cannot target it yet. Promotion to entity is a defined follow-up.
- Enemy pack schema requires ambient-spawner fields (`enemyCap`, `spawnIntervalMs`, etc.) even for packs that never use the ambient director; floor6 pack sets them to inert values (0/1).
- Authored waypoints tie movement to the fixed geometry contract; procedural routes (not planned) would require a design change.

### Risks

- **Component store allocation**: `BroadcastRelayRaider` adds four typed arrays to every world. Entity count for Floor 6 is low; no budget risk in Slice 3.
- **Future stall false-positives**: The backstop fires only when all raiders are stalled AND all entries are released. A future wave that produces only stall-immune entities (e.g., flying raiders) must set `stillFrames` = 0 explicitly.
- **Relay HP authority promotion**: If Slice 5 creates a relay ECS entity with a `Health` component, a second writer (damage system) will compete with the director's `relayHp` field. ADR 0097 D5 requires one authoritative path; the promotion must explicitly deprecate `state.relayHp` and migrate the director to read entity health instead.

## Alternatives Considered

1. **Store relay HP on an ECS entity now.** Rejected: premature — towers don't exist yet. Adding an entity adds teardown responsibility and a new query without gameplay value in Slice 3.
2. **Use A\* for raider movement.** Rejected: authored waypoints are already available in the geometry, are deterministic by construction, and do not depend on the tile map's passability state at runtime (which can change via door locks in later slices).
3. **Put wave schedule as RNG-seeded selection.** Rejected: authored schedules are simpler to prove, easier to balance-tune in S9, and allow the spec's "same seed = same manifest" requirement to be trivially satisfied without stream isolation.
4. **Inline archetype constants instead of the enemy-pack registry.** Rejected: the registry provides schema validation and the same append-only, stable-ID contract required by FR3.4.
