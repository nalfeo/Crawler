# Handoff: Art Placeholder Manifests by Theme

**Date:** 2026-06-29
**Persona:** Producer / Art
**Branch:** nalfeo-art-placeholder-manifests
**Scope:** docs/data + 1 devtools glob fix (no generation run)

## Problem

Two gaps in art-backlog tracking:

1. **Workflow tool only loaded one manifest.** The devtools Sprite Generation
   Workflow globbed `../plans/floor-art/*.art.yaml`, so only the rat-themed
   floor plan ever appeared — item-icons, props, etc. were invisible.
2. **Enemies & cast were untracked.** Every `MOB_DEFS` mob points at a `mob-*`
   sprite with no generated art, and player/guide/slime/goblin/orc/boss render
   from temp CC0 frames. None were in any plan, so no theme manifest tracked
   them for generation.

## What shipped (data + 1 fix)

- Broadened the glob to `../plans/**/*.art.yaml` (+ empty-state text) so the
  workflow tool now lists **11** plans instead of 1.
- 3 new theme manifests:
  - `plans/bestiary/core-bestiary.art.yaml` — 9 MOB_DEFS mobs (no integration;
    `mob-*` ids aren't in SPRITES). All `needs-art-placeholder`.
  - `plans/bestiary/stand-in-enemies.art.yaml` — 6 registry CC0 enemies
    (slime/goblin/orc/boss/brigand/ghost), `integration: sprite-registry`.
  - `plans/characters/contestants-cast.art.yaml` — player + guide, `character`.
- `briefs/README.md` documents the new theme dirs and `plans/**` discovery.

## Validation

- `sprites:asset-plan` per file: 9 + 6 + 2 = 17 unresolved `needs-art-placeholder`.
- Deterministic observe: parsed exact `plans/**/*.art.yaml` glob via
  `parseFloorArtPlans` → 1 plan before, 11 after (dropdown set).
- `npm run verify` green (2538 unit, integration, headless, build).
- `scripts/agent/lab-gate-check.sh` passes (no ECS systems touched).
- No `files/guard-telemetry.jsonl` — no guard-telemetry section.

## Next

Generate per theme when provider access allows:
`npm run sprites:plan-drafts -- --plan plans/bestiary/core-bestiary.art.yaml`.

## Apples

**Estimate:** 🍎🍎🍎 · **Actual:** 🍎🍎🍎 — on. **Hello kitties:** 0.6
