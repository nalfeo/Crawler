# ADR: Floor 1 Welcome-Bar NPC Consolidation and Shared-Room Interaction

## Status

Accepted

## Date

2026-07-05

## Estimated Complexity

🍎 x 3 — spans three layers (`src/shared` floor data, `src/game` scenario +
combat AI, `src/engine` interaction picker); no new ECS system or lab, but two
placement bugs and a hot-path allocation had to be fixed alongside the layout
change.

## Context

Floor 1's opening moments previously scattered the three quest-giving NPCs
(spell-quest-giver, shopkeeper, tutorial goon) across separate rooms, forcing
the player through empty corridors before any objective could start. The design
goal for this branch was to consolidate them into a single "welcome bar" hub
room so the intro reads clearly and the tutorial quest can begin immediately.

Consolidating three NPCs into one room surfaced problems that only appear when
NPCs share a room, and touched more than one architectural layer:

- **Placement (`src/game/floorScenario.ts`).** The manifest
  (`src/shared/data/floors/floor1.manifest.json`) gives all three NPCs the same
  `spawn` room role, so their preferred tiles collide. The generic
  `resolveNpcSpawnPosition` de-duplication (an `occupiedTiles` set + a per-room
  free-tile search) is what keeps them on distinct tiles, and it had two gaps
  that could still stack NPCs.
- **Interaction (`src/engine/scenes/MainGameScene.ts`,
  `src/engine/scenes/main-game-scene-helpers.ts`).** With several NPCs in
  interaction range at once, the scene must pick the nearest _nearby_ NPC every
  frame. The picker ran in the per-frame interaction update.
- **Combat AI (`src/game/ai/bt-ai-provider.ts`).** The headless win-rate runner
  drives the same behavior tree, so the shared-room layout is validated by the
  Headless Floor 1 Gate. Tuning that keeps the 90%+ win rate honest (ranged
  engagement preemption, retreat hysteresis + a threat-ignore latch, and the
  leave-safe-room detour) is part of this branch's behavior surface and must be
  documented rather than presented as a pure layout tweak.

This decision affects 2+ systems (floor scenario, engine scene, combat AI), so
an ADR is required per the cross-system memory policy.

## Decision

1. **Keep the shared-room hub, harden placement.** Retain the manifest's shared
   `spawn` role for the welcome-bar NPCs and rely on `resolveNpcSpawnPosition`
   for distinct tiles. Close two stacking gaps in
   `resolveFreeNpcTileInRoom`/`resolveNpcSpawnPosition`:
   - When a room enumerates `interiorCells` but every free interior cell is
     taken, fall through to the bounds/radius spiral scan instead of returning
     `null` early (which pushed the caller onto its preferred-tile fallback).
   - Make the preferred-tile fallback respect `occupiedTiles`, so it never hands
     back a tile another NPC already claimed.

   The absolute last-resort return (a genuinely full room) is left as-is; with
   three NPCs in the welcome room it is unreachable, and the 10-seed
   distinct-tile assertion in `tests/game/floor1-scenario.test.ts` covers the
   real scenario.

2. **Nearest-nearby interaction picker, allocation-free.** `findNearestNearbyNpc`
   iterates the npc map and reads positions from the entity-store arrays
   directly, rather than materializing a candidate array each frame. This keeps
   the shared-room "which NPC do I talk to" pick correct without per-frame
   garbage in a hot path.

3. **Validate combat changes on win rate, not seeds.** The behavior-tree
   adjustments are gated by the Headless Floor 1 Gate (win-rate sweep), never by
   rescuing individual seeds. A deterministic test in
   `tests/game/behavior-tree-ai.test.ts` pins the retreat threat-ignore latch so
   the disengage-at-low-health path stays covered.

## Consequences

### Positive

- Clear, immediate Floor 1 intro: all quest NPCs in one hub, on distinct tiles.
- Two real NPC-stacking bugs fixed and covered by a multi-seed test.
- Per-frame interaction pick no longer allocates.
- Combat-AI behavior is documented and win-rate validated, not seed-tuned.

### Negative

- The floor-scenario placement path is now slightly more branchy (interior-cell
  fall-through), marginally harder to read.
- Combat-AI surface for Floor 1 grew, so future balance work must keep re-running
  the Headless Floor 1 Gate rather than reasoning locally.

### Risks

- A pathologically full room could still return the preferred (occupied) tile.
  Mitigation: unreachable for Floor 1's NPC count; guarded by the distinct-tile
  test. If future floors pack rooms tighter, extend the search beyond the room
  or add an explicit "no free tile" diagnostic.
- Behavior-tree tuning could regress the win rate on unseen seeds. Mitigation:
  the win-rate gate runs a broad sweep; regressions fail CI rather than shipping.

## Alternatives Considered

- **Distinct manifest roles/anchors per NPC.** Give each NPC its own room role or
  explicit anchor tile instead of a shared `spawn` role. Rejected: it hard-codes
  the layout, defeats the generic de-duplication that other floors reuse, and
  would need re-authoring for every future shared-room hub.
- **Fixed pixel offsets per NPC.** Nudge each NPC by a constant offset. Rejected:
  offsets can land in walls or other rooms and don't compose when NPC counts
  change; a tile-aware free search is robust.
- **Rebuild the candidate array but memoize it.** Cache the per-frame candidate
  list and invalidate on NPC movement. Rejected: more state and invalidation
  bugs than simply iterating the map + store arrays in place.
