# ADR 0054 — Floor 2 Settlement NPC Appearance-Key and Dialogue-Override Threading

## Status

Accepted

## Date

2026-07-09

## Systems touched

floor2-settlement, npc-spawn, phaser-bridge, dialogue

---

## Context

Floor 2's settlement contains a defected family member NPC whose visual appearance
must come from that family's _elite_ archetype sprite (vs the plain `FLOOR2_DEFECTOR_NPC_ID`
def art), and whose dialogue lines are family-specific and vary per seed. Implementing
this required wiring two new data channels — an **appearance-key** and a
**dialogue-override** — across three architecture layers:

1. **`src/game/`** (`floor2Settlement.ts`) — decides which family/archetype to use.
2. **`src/core/`** (`world-objects.ts` / `NpcInstance`) — stores the per-entity data.
3. **`src/engine/`** (`PhaserBridge.ts`, `main-game-scene-helpers.ts`) — reads the data
   at render/conversation time.

The challenge is that `src/core/` must not import from `src/engine/`, and `src/game/`
must not import from `src/engine/` — the bridge pattern requires all engine-side reads
to flow through the world's data stores rather than direct coupling.

---

## Decision

### Appearance key

- `SpawnNpcOptions` in `src/core/spawners/world-objects.ts` accepts an optional
  `appearanceKey` (archetype id) and `appearanceFallbackKey`.
- `spawnNpc()` writes `appearanceKey` to `world.enemyAppearanceKeys` (the existing map
  used by the renderer for enemy textures) and `appearanceFallbackKey` to the
  `NpcInstance` in `world.npcs`.
- `PhaserBridge.resolveNpcTexture()` is extended to accept `appearanceFallbackKey`:
  it first tries `${appearanceKey}-v1` in the generated sprite registry (elite art),
  falls back to the `appearanceFallbackKey`, then falls back to the plain `appearanceKey`.
  Both the creation path and the late-load-reconcile path thread the fallback key.

This reuses the `world.enemyAppearanceKeys` channel already used for enemy rendering
rather than adding a new map, keeping the renderer's lookup path uniform.

### Dialogue override

- `NpcInstance` gains an optional `dialogueOverride: string[]` field (set via
  `SpawnNpcOptions`).
- `resolveDialogueLines()` in `main-game-scene-helpers.ts` accepts an optional
  `npcEid`; when present, it checks `world.npcs.get(npcEid)?.dialogueOverride` first
  and returns it immediately if populated, bypassing the def-ID lookup.
- Both conversation paths in `MainGameScene.ts` (active-conversation tick +
  new-conversation start) pass the NPC eid to `resolveDialogueLines`.

The override wins over the def registry, which means any NPC can carry custom
per-instance dialogue without needing a dedicated def entry.

---

## Consequences

**Positive**

- Zero new inter-layer imports: the data flows core → engine via existing maps/stores.
- The pattern is reusable: any future per-instance appearance or dialogue variation
  can use the same channels without new plumbing.
- All randomness for defector selection and placement uses a derived `SeededRandom`
  so the existing shop-roll seed stream is stable.

**Negative / Risks**

- `world.enemyAppearanceKeys` is nominally for enemies; reusing it for NPCs is a
  semantic stretch. If future code assumes that key-present → enemy entity, it will
  need updating. The risk is low because the renderer already guards on `hasComponent(eid, Npc)`.
- The fallback chain (`elite-v1` → fallbackKey → appearanceKey) adds a third branch
  in `resolveNpcTexture`. It is well-tested but slightly increases visual branching
  complexity.

---

## Alternatives Considered

1. **Separate NPC appearance map in world** — add `world.npcAppearanceKeys` parallel
   to `world.enemyAppearanceKeys`. Cleaner semantics but requires a new store field
   and more boilerplate; deferred unless the enemy-key reuse causes real bugs.
2. **Store dialogue lines as a per-eid component** — model dialogue as a bitecs
   component rather than a `Map`. Would require a string-array component which bitecs
   does not support natively (SoA only handles numeric types); rejected.
3. **Separate NPC def per family** — register 18 family-specific defector defs
   in `NPC_REGISTRY`. Bloats the registry, and the def content differs only by
   dialogue/appearance — the override approach is strictly simpler for this use case.
