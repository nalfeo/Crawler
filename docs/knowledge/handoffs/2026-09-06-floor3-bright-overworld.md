# Session Handoff: Floor 3 — bright outdoor Companion League overworld

## Date

2026-09-06

## Persona

Producer

## Systems touched

mapgen, lighting, sprite-pipeline

## Apples

2🍎

## What Was Done

Shifted Floor 3 off the inherited industrial-cave palette and onto a dedicated outdoor terrain pack tuned for the Companion League brief:

- `src/shared/data/floors/floor3.manifest.json` now points at a new `companion-overworld` terrain pack, raises the ambient light, and switches the decoration palette from `cave` to `organic` so the floor reads as bright and natural rather than a purple soundstage.
- `src/shared/terrain-pack-types.ts` and `src/shared/terrain-pack-registry.ts` register the new runtime terrain pack and load its authored manifest.
- Added `src/shared/data/terrain-packs/companion-overworld.manifest.json` plus procedurally generated outdoor art under `public/assets/terrain-packs/companion-overworld/` with a grass/dirt/woodland color language and a valid blob47 wall atlas.
- Added a deterministic regression check in `tests/unit/floor-behavior.test.ts` that asserts Floor 3 uses the outdoor terrain pack and organic scene settings.

Runtime/real-artifact observation: the active game artifact is the shipped Floor 3 manifest + terrain-pack registry; no lab-only validation was used as the completion gate. The patch was validated via the repo's fast verify and the targeted Floor 3 unit test.

## Key Decisions Made

- Floor 3 keeps its procedural biome generator and room layout, but swaps the visual identity from subterranean mine-cavern to a bright outdoor Circuit so the world reads as a creature-battling overworld without renaming or reworking the generator.
- The new terrain pack is registered as a first-class runtime pack instead of silently reusing the industrial cave set, which keeps the floor data and art wired through the same deterministic manifest path as every other shipped terrain pack.
- The visual palette stays original and IP-safe: it takes the required bright outdoor cues (grass, dirt, foliage, studio contrast) without copying any existing property-specific designs.

## What's Next / Blockers

- Next step: if a later art pass is approved, replace the generated procedural outdoor pack with a fully hand-authored asset pass while keeping the same manifest ID and runtime wiring.
- No blocker; the implementation lands on the deterministic runtime wiring path and keeps the visual identity in real game data.
