# ADR 0044: Spawner Battle Arena

## Status

Accepted

## Date

2026-07-04

## Estimated Complexity

🍎 x 4 — new system + two mutually-exclusive traversal blockers (door lock vs. tile-flag fence), an XP-intercept protocol in `dropSystem`, a HUD announcement queue, VFX renderer presets, and a headless win-rate gate.

## Context

Spawner mobs (`Spawner` component) drip child enemies into the world but had no notion of a bounded encounter. Every child kill dropped XP like any other enemy, so a player who kited a spawner from range earned the full loot value with none of the risk. The spawner itself was just another target — no fanfare, no commitment, no "boss room" feel — even though the design intent is that walking into a spawner's zone should feel like starting a mini-arena battle.

Six user requirements captured verbatim in `.specify/specs/spawner-battle-arena.md`:

1. Spawner mobs need to have a minimum size spawn around them.
2. When entering the spawn zone, if it's a sealable room — the doors lock until the spawner is dead.
3. If not a sealable room, a circular, impenetrable fence appears around the spawner.
4. Mobs spawned by spawners do NOT drop experience.
5. The spawner drops experience equal to the amount that would have dropped from killing the number of spawned mobs (up to 10).
6. There needs to be a special effect and announcement when starting the spawner battle.

## Decision

### Data — extend the `Spawner` SoA

Five new fields on the existing `spawner` store (all typed-arrays for allocation-free access):

- `arenaRadiusFt: Float32Array` — per-spawner radius (min 4 ft, default 6 ft, RATS_NEST=7, SLIME_POOL=6).
- `arenaKind: Uint8Array` — `0=sealed-room`, `1=open-fence`, `255=unresolved` (decided on first tick with a floorMap).
- `arenaState: Uint8Array` — `0=idle`, `1=locked`, `2=resolved` (terminal).
- `bankedXp: Float32Array` — XP intercepted from spawner-owned child kills.
- `bankedChildren: Uint16Array` — count of intercepted deaths, capped at `SPAWNER_MAX_BANKED_CHILDREN = 10`.

### System — `spawnerArenaSystem` runs BEFORE `spawnerSystem`

A new deterministic system at `src/game/spawners/spawnerArenaSystem.ts` drives the per-tick state machine:

- `idle → locked`: player enters the arena disc (or is in the same sealed room). Push `spawnerArenaStart` VFX + HUD announcement, then either lock all doors of the containing room (sealed path) or mutate a ring of tile-map flags to non-passable (open-fence path).
- `locked → resolved`: `spawner.deathResolved === 1`. Reverse the geometry (unlock doors or restore snapshotted flags), push `spawnerArenaEnd` VFX + announcement, and spawn a single `XpGem` with `bankedXp` at the spawner's death position.

Wiring goes **immediately before `spawnerSystem`** in both pipelines (`src/bootstrap/floor-main-scene-options.ts` preSystems and `src/game/ai/simulation-step.ts`). This preserves the invariant asserted by `tests/game/floor1-main-scene-options.test.ts` that `spawnerSystem` is adjacent to `floor1EnemyDirectorSystem` — an "after spawnerSystem" placement would silently break that test. Running before also means the fence's tile mutation is visible to the same-tick spawner logic when it picks child spawn positions.

### Sealable-room vs. open-fence — the decision rule

A room is considered "sealable" only when all three of these hold:

1. The spawner tile maps to a `RoomData` (`roomGraph.getRoomAt(tx, ty) >= 0`) — it isn't in an open cave or corridor.
2. The room has at least one door — there is actually something to lock.
3. The arena disc fits entirely inside the room's bounding rectangle (1-tile inset for walls).

Any failure falls back to open-fence, which enumerates the ring of currently-passable tiles at `radius ± halfTile` and clears their `PASSABLE` flag (leaving `TRANSPARENT` set so line-of-sight rays still pass — the fence is meant to feel like a shimmering barrier, not a black hole). Original tile flag bytes are snapshotted onto `world.spawnerArenaFence` so restore on resolve is byte-exact.

Door locking uses the existing `setDoorLockConfig` protocol with a goal-flag predicate (`spawner-arena-<eid>-cleared`). Setting the goal flag to `true` on resolve is enough — `doorSystem` observes it and clears `isLocked` on the next tick, keeping the arena system out of the low-level door state loop.

### The 10× banked-XP cap

The intercept lives in `dropSystem`. The RNG order is preserved by calling `rollLootTable` once regardless of ownership; the intercept fires **after** the roll, walks the returned drops, sums the XP-type entries, and:

- If the owner is a live `Spawner` and `bankedChildren < 10`: adds the sum to `spawner.bankedXp[ownerEid]`, increments `bankedChildren`, and passes `interceptSpawnerOwnedXp=true` to `spawnDrops` (which still consumes the per-gem scatter RNG but skips `spawnXpGem`). Non-XP drops (gold, items) still spawn.
- If `bankedChildren === 10`: the intercept falls through — the 11th and later kills roll normally and their XP gems spawn on the map. This is intentional: the cap matches the user's literal "up to 10" wording, and letting subsequent kills spawn XP prevents the pool from being weaponised as an infinite-XP farm.

The XP unit is empirical: it's whatever `rollLootTable` would have produced, so the pool self-anchors to whatever loot table the child is on. This avoids a hardcoded XP number that would drift as loot tables tune.

### Announcement queue

A new `world.announcements: AnnouncementEvent[]` queue lives in `src/shared/announcement-events.ts` with a `pushAnnouncement` helper capped at 32 entries. The engine-layer `HudAnnouncementBanner` (top-center, fade in/out) drains it each frame. The queue is kind-tagged so future banners can reuse the widget (level-up, quest complete, etc.) without adding new state.

### VFX

Three new `VfxEffectKind` values in `src/shared/vfx-events.ts`: `spawnerArenaStart` (radial burst + brief shake), `spawnerArenaEnd` (shrinking ring + flash), and `spawnerArenaFence` (persistent shimmer, re-emitted every ~400 ms while `arenaState === 1` so a scene-reloaded renderer picks it back up). Presets live in `src/engine/EffectsVfx.ts`; render depths in `src/shared/render-depths.ts`.

## Consequences

### Positive

- Every user requirement is testable end-to-end: unit tests cover the arena state machine, geometry, and the XP intercept cap; the integration test drives `idle → locked → resolved` against a live world; the headless win-rate gate proves the feature doesn't regress Floor-1 completion or leave triggered arenas stuck.
- The XP intercept is transparent to the RNG stream — replays with the same seed produce identical drop sequences whether or not spawners are around.
- Sealable-room vs. open-fence is a one-shot decision cached in the SoA; per-tick cost is a same-room check against the room graph (O(1)) plus a distance-squared compare.

### Negative

- The fence path mutates `TileMap.flags` in place. Any system that snapshotted flags before the arena raised is now working against stale data until the arena resolves. No such system exists today, but the risk is real — surface: the fence lives for at most one battle and always restores the original bytes.
- `RunStats.spawnerArenas` had to be added; tests that construct `RunStats` fixtures by hand (`fun-score`, `ai-scoring`) would have broken. The field is `optional?` on the type so those fixtures don't need to change, at the cost of a `?.resolved` at every read site in gates.
- The XP intercept is gated behind `allowFloorDrops && allowEnemyDrops`. Kills that happen during Floor-1 onboarding (before the `floor1-drops-unlocked` goal flag is set) or against archetypes whose `dropsEnabled: false` do NOT bank XP. This preserves the user's verbatim spec ("equal to the amount that would have dropped from killing the number of spawned mobs") — if the mobs would have dropped 0, the spawner drops 0. Consequence: an early-game spawner encounter awards nothing, matching the design of every other early-game drop.

### Risks

- If a spawner is placed on a corridor tile in a large room whose bounds are larger than the arena disc, the disc-fits-in-room check may pass but the sealed-room lock only touches doors known to the `roomGraph` — a corridor doorway that isn't part of the room's `doors[]` array won't lock. Mitigation: the fallback is open-fence, which physically encloses the spawner; if the sealed path can't actually seal, callers will still get a bounded battle from the fence path when the disc-fit check fails. Every room in Floor-1 today has its doors registered correctly.
- The `bankedChildren` cap of 10 is a magic number. If a future spawner archetype spawns radically more or fewer children than RATS_NEST/SLIME_POOL, the cap may under- or over-value the finale reward. This ADR documents the cap and centralises it in `SPAWNER_MAX_BANKED_CHILDREN`; retune by editing that constant.

## Alternatives Considered

- **Put `spawnerArenaSystem` AFTER `spawnerSystem`.** Cleaner narrative ("first the spawn tick, then the arena reacts"), but it breaks the `directorIndex === spawnerIndex + 1` invariant in `tests/game/floor1-main-scene-options.test.ts`. Loosening that invariant was rejected under rule 12 — the arena is the new system, so it moves.
- **Intercept XP at `spawnXpGem` instead of inside `dropSystem`.** Simpler, but bypasses the loot-table roll, which means the pool would grow by whatever we hardcoded rather than by whatever the child's actual table would have produced. Would drift over time.
- **Store the arena kind on the archetype instead of the entity.** Would make the sealable-room check un-runnable at labs/tests without a floorMap. Storing on the entity with a `255 = unresolved` sentinel means the decision can be deferred to first-tick when the floorMap is guaranteed.
- **Use a `Fence` component per fence tile instead of tile-flag mutation.** Would need new movement + projectile + LOS integration points. Tile-flag mutation reuses every existing collision path with zero new integration surface.
