# Engine manifest loader — pipeline closed end-to-end

**Date:** 2026-06-08
**Persona:** graphics-designer
**Scope:** Bridge the approved-sprite manifest into the Phaser engine and
prove it end-to-end with a real game-side consumer.

## What landed

The sprite-generation pipeline is now **walk-away** from a single command:

```
crawler-art-batch names.txt
  → synth (brief)
  → generate-one (variants)
  → judge (LLM gate)
  → gallery approve  ──► public/assets/generated/manifest.json
                                │
                                ▼
                        BootScene preload pass
                                │
                                ▼
                  scene.game.registry [GENERATED_SPRITE_REGISTRY_KEY]
                                │
                                ▼
                       InventoryUI.renderItems
```

A human approves once in the gallery; on next boot, the engine loads the
PNG and the inventory cell renders the generated sprite instead of the
2-character placeholder. No additional wiring per item — `itemDef.id`
must equal the manifest `briefId`, which is already the convention.

## Files

**New (engine-portable)**

- `src/shared/generated-assets.ts` — Zod schema mirroring
  `scripts/sprites/approve.ts`'s `ManifestEntry`. Exports
  `parseGeneratedManifest`, `loadGeneratedManifest`,
  `buildGeneratedSpriteRegistry`, `emptyGeneratedSpriteRegistry`,
  `DEFAULT_GENERATED_ANCHOR = {x:8, y:8}`. Pure: no Phaser, no IO.
- `src/engine/generatedAssets/preload.ts` — `fetchGeneratedSpriteRegistry`
  (soft-fail fetch + parse) and `preloadGeneratedSprites` (Phaser loader
  glue). Both take injected dependencies so tests run without a real
  scene or network.
- `src/engine/generatedAssets/index.ts` — barrel + the
  `GENERATED_SPRITE_REGISTRY_KEY` constant shared between BootScene and
  InventoryUI.

**Modified**

- `src/engine/scenes/BootScene.ts` — seeds an empty registry into
  `scene.game.registry` from `preload`, then in `create` performs a
  second loader pass for any manifest entries before starting
  `MainGameScene`. Failures soft-fail to "no generated sprites".
- `src/engine/InventoryUI.ts` — on render, looks up
  `registry.lookup(itemDef.id)`. When the registry returns an entry and
  Phaser has the texture loaded, renders a scaled `add.image()` instead
  of the 2-char placeholder text. Existing rarity border + count badges
  unchanged.

**Tests**

- `tests/unit/generated-asset-registry.test.ts` — 14 cases covering
  schema validation (version, missing fields, malformed top-level),
  registry lookup, anchor fallback for `anchor: null`, derived-anchor
  preservation, multi-entry registries, empty registry.
- `tests/unit/generated-asset-preload.test.ts` — 10 cases for
  `fetchGeneratedSpriteRegistry` (404 / fetch error / non-JSON /
  schema-invalid / no-fetch / happy path) and `preloadGeneratedSprites`
  (empty registry, queue per entry, custom base URL, dup texture-key
  skip).
- `tests/integration/generated-manifest-engine.test.ts` — 4 cases that
  write a real fixture manifest + PNGs to a temp dir, fetch through a
  file-backed `fetcher`, queue via `preloadGeneratedSprites`, and assert
  the queued URL resolves back to the on-disk file. Also validates the
  checked-in repo manifest parses successfully.

## Design decisions

**Boot-time vs lazy-per-floor load.** Boot-time wins today. The manifest
is small (single-digit entries after this PR; tens later). Phaser scenes
expect textures preloaded. When the manifest reaches ~100s, the
migration is local: change `BootScene.create` to skip the second load
pass and have `MainGameScene` pull per-floor subsets. Documented inline
in `preload.ts`.

**Null-anchor fallback.** A `null` anchor in the manifest means anchor
derivation failed during approval but the human approved the variant
anyway. The engine falls back to `DEFAULT_GENERATED_ANCHOR = {x:8, y:8}`
— sprite center of the canonical 16×16 frame. We deliberately do _not_
reuse `DEFAULT_HANDHELD_SPRITE_ANCHOR` (bottom-center) because the
manifest covers all sprite types, not only hand-held weapons. The
registry exposes `anchorIsDefault: boolean` so downstream consumers that
care (e.g. hand-held weapon positioning) can override.

**Missing asset file.** Phaser's loader emits `loaderror` for any failed
image; we already log + fall back to procedural textures (existing
BootScene `loaderror` listener). The registry-time soft-fail path covers
the _manifest_ being missing or invalid; the _file_ missing while the
manifest references it is handled at Phaser load time.

**Two-pass loader.** `preload` queues Kenney sheets; the auto-start
hands off to `create`, which awaits the manifest fetch, queues approved
sprites, and triggers a second `load.start()`. `MainGameScene` is
deferred to the second `COMPLETE` event. This avoids the race where an
async fetch from `preload` may or may not finish before the loader
auto-starts.

**Layer boundaries.** ESLint forbids `src/game → src/engine`, so the
consumer for this PR is `InventoryUI` (already in `src/engine/`).
Items in `src/shared/items.ts` already use IDs that match the briefId
convention (`iron-sword`, `throwing-star`, `baseball-bat`), so the
lookup works without any item-data changes.

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — 896 / 896 pass (24 new tests)
- `npm run test:integration` — generated-manifest-engine: 4 / 4 pass
- `bash scripts/agent/lab-gate-check.sh` — pass
- `npx prettier --write .` (whole tree) — applied

## Open follow-ups (not blocking)

- Other consumers (EquipmentVfx, dropped-item icons in PhaserBridge,
  enemy sprites on the floor) still use placeholder textures. Each gets
  migrated one PR at a time as briefs are approved for those asset
  types.
- The on-disk `public/assets/generated/manifest.json` currently has
  `entries: {}` in this worktree. The first real entries appear once
  `npm run sprites:approve` runs against any seeded run in
  `generated/runs/`.
- Lab visualisation: didn't extend `src/labs/sprite-gallery-lab/`
  because the integration test already proves the chain. A lab page
  that boots a `BootScene` and dumps the loaded registry would be a
  nice next-PR debug aid; deferred.

## Pipeline status

**End-to-end as of this PR.** A user can:

1. Write `briefs/weapons/foo.yaml` (or let `synth` generate it)
2. Run `crawler-art-batch names.txt`
3. Open the gallery, click **Approve** on the best variant
4. `npm run dev`
5. Open the inventory in-game; the generated sprite renders in the
   matching item's cell.

No further engine wiring required for new weapon/item asset types whose
`itemDef.id` matches their `briefId`.
