# ADR 0034: Config-Driven Sprite Wiring

**Date:** 2026-06-30  
**Affected Systems:** src/core (dropSystem), src/engine (PhaserBridge, InventoryUI), src/game (spawners)

## Status

Accepted (2026-06-30).

## Context

Sprite wiring was scattered across multiple files:

- Hardcoded texture keys in `PhaserBridge.ts`
- Hardcoded textureIds in spawner templates
- Hardcoded brief lookups in `InventoryUI.ts`
- Wiring automation targeting code instead of config

That coupling meant approved art could be checked in and still fail to render because game code had not been updated everywhere that knew about sprite names or texture IDs.

## Decision

Move sprite wiring out of bridge code and into `src/shared/data/entity-sprite-mappings.json`.

Specifically:

1. `entity-sprite-mappings.json` is the single source of truth for render kinds, texture IDs, Kenney fallbacks, procedural fallbacks, and generated-art pins.
2. `PhaserBridge.ts` reads config and resolves textures instead of owning hardcoded maps.
3. Spawner templates read their texture IDs from config at module load.
4. Baby slimes use their own configured texture ID instead of inheriting the parent slime's art.
5. Inventory icons resolve generated art from `def.icon ?? def.id`.

## Consequences

### Positive

- Art hookup is now primarily a config change instead of a code change.
- Texture strategy for each entity type lives in one place.
- Generated -> Kenney -> procedural fallback behavior is explicit and testable.
- Approved art can hot-upgrade a live sprite once the better texture is loaded.

### Negative

- `entity-sprite-mappings.json` is more complex and now carries more rendering policy.
- Misconfigured render kinds or duplicate texture IDs can silently route to the wrong art.
- The hot-upgrade path needs care to avoid per-frame re-resolution overhead.

### Risks

- Config drift if new entity types ship without matching render-kind entries.
- Silent fallback to placeholder art if a generated key is mistyped or missing.

## Alternatives Considered

### 1. Keep hardcoded bridge maps

Rejected: this was the source of the slime regression and keeps art delivery coupled to code edits.

### 2. Add a separate sprite-config file

Rejected: it would duplicate entity identity data that already belongs with the shared sprite mappings.

### 3. Infer everything from the generated-art manifest

Rejected: the manifest is art output, not authoritative gameplay/rendering config.

## Implementation Notes

1. Texture resolution priority is:
   - generated pinned texture key
   - generated brief family lookup
   - Kenney sprite
   - procedural fallback
2. Baby slimes keep their scale behavior from the `slime-mini` archetype while using their own configured texture ID.
3. The bridge now caches preferred enemy textures per sync pass so the hot-upgrade reconcile does not rescan texture keys for every enemy each frame.

## Verification

- Unit coverage exercises config-driven resolution, hot-upgrade behavior, brief-family fallback, and baby slime texture IDs.
- Playwright visual verification confirmed slimes render with generated slime art instead of Kenney placeholders.
- Approved wired assets render correctly for rats, slimes, baby slimes, the rat-slime boss, and the baseball bat icon.

## Future Work

1. Add config validation for duplicate texture IDs and invalid procedural tokens.
2. Document the asset wiring workflow for future generated-art check-ins.
