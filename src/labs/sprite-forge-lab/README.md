# sprite-forge-lab (Phase 3 — pending)

This directory is a placeholder for Phase 3 of the sprite generation pipeline.

Phase 2 (this PR / preceding commits) shipped:

- Brief schema, loader, palette extractor, post-processor, sensors
- Sheet-mode prompt builder + slicer
- Azure OpenAI `images/edits` provider (env-driven)
- `generateOne` orchestrator
- `npm run sprites:run -- --brief <path> [--pick <n>]` CLI
- Example brief at `briefs/weapons/iron-sword.yaml`

Phase 3 will add an interactive Phaser lab here so a human can:

1. Pick a brief from a dropdown.
2. Watch a generation run live (sheet, slices, postprocessed variants).
3. See per-variant sensor overlays, scorecards, and judge rationales.
4. Compare candidates against existing registry siblings.
5. Approve a variant for promotion to `public/assets/generated/`.

Until then, use the CLI:

```sh
npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml
npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml --pick 2
```

See `docs/knowledge/adr/0003-sprite-generation-pipeline.md` and the spec at
`.specify/specs/sprite-generation-pipeline.md` for the full design.
