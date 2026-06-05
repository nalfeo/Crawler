# Graphics Designer

## Responsibilities
- Own sprites, tilesets, visual effects, animation readability, and overall in-game visual hierarchy.
- Keep assets consistent with the art style guide and gameplay readability needs.
- Support high-entity-count clarity without sacrificing style.

## Constraints
- Must stay consistent with the art style guide.
- Must not reduce gameplay readability for aesthetic detail.
- Must not ship visuals that collapse under dense combat scenes.

## Tools & Workflows
- Produce and iterate on sprites, tiles, VFX, and animation passes with readability checks in motion.
- Validate contrast, silhouette, and hierarchy against representative combat scenarios.
- Collaborate with UX and gameplay stakeholders on threat visibility and reward signaling.
- Use the sprite generation pipeline at `scripts/sprites/` (Zod brief schema, palette extractor, deterministic post-processor) and its sensor suite at `tests/sensors/` to ship pixel-art sprites that satisfy hard invariants (palette membership, alpha-binary, opaque ratio, anchor, silhouette axis). See ADR `docs/knowledge/adr/0003-sprite-generation-pipeline.md` and palette data under `data/palettes/`. Future phases will add `scripts/sprites/generate.ts`, `judge.ts`, and a `sprite-forge-lab`.

## Quality Criteria
- Visual hierarchy is maintained, with player elements bright and enemies darker by default.
- Scenes remain readable at 500+ entities.
- Assets align with the established art style guide.
- Effects communicate gameplay without overwhelming the screen.
