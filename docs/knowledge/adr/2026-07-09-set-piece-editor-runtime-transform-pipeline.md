# ADR: Set-piece editor runtime transform pipeline for NPC and prop fidelity

## Status

Accepted

## Date

2026-07-09

## Estimated Complexity

🍎 x 4 - multi-layer editor/runtime threading across shared/core/game/engine with required adversarial + multi-model review stages.

## Context

The set-piece editor canvas now supports drag/drop placement, free or snapped positioning, resize, rotate, mirror, and sprite overrides. Before this change, several authored fields from set-piece data were either constrained to tile-only placement or dropped before runtime, especially for NPCs. That caused editor-authored layouts to regress on save/reload and prevented parity between canvas edits and real scene rendering.

The change spans shared schemas, stamping, spawning, and Phaser rendering, plus the set-piece data pack itself. Because this touches `src/shared`, `src/core`, `src/game`, and `src/engine`, we need an explicit architectural record of how authored transform metadata flows end-to-end.

## Decision

Keep a single data-driven pipeline from authored set-piece JSON to runtime visuals:

1. Extend set-piece schemas/types to allow sub-tile coordinates, scene-layer metadata, and NPC visual metadata (`widthFt`, `heightFt`, `flipX`, `flipY`, `rotationDeg`, `spriteOverride`) with validation for paired size fields.
2. Preserve authored sub-tile NPC world coordinates during stamping while retaining integer tile bookkeeping for occupancy/objective logic.
3. Thread optional NPC visual metadata through `spawnNpc` and store it on `NpcInstance`.
4. Resolve NPC sprite overrides in `PhaserBridge` before fallback texture selection, and apply per-instance flip/rotation transforms each sync.
5. Keep the editor-authoritative set-piece pack (`src/shared/data/set-pieces.json`) as the durable source of floors/walls/layout updates.
6. Add targeted unit tests at schema, stamp, and bridge layers to lock this behavior.

## Consequences

### Positive

- Canvas edits now persist with closer WYSIWYG parity in runtime scenes.
- NPC visual controls now have the same effective transform path as props.
- Sub-tile positioning survives save/reload without breaking tile-based objective/occupancy logic.
- Regression coverage now guards the compile -> stamp -> render chain.

### Negative

- Set-piece schema and render/stamp plumbing are more complex due to additional optional fields.
- The set-piece data file becomes larger and more frequently edited by editor-driven updates.

### Risks

- Future editor fields can drift if they are added to the extension but not threaded through shared/core/engine paths.
- Large data-pack edits increase merge-conflict pressure across parallel branches.

## Alternatives Considered

- Keep tile-only NPC placement and avoid sub-tile support. Rejected because it breaks free/quarter/half-grid authoring requirements.
- Support transforms only in the editor preview and discard at runtime. Rejected because it violates apply/reload fidelity.
- Add a separate "editor-only NPC" rendering path. Rejected because it duplicates logic and diverges from real game behavior.
