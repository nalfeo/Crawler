# Handoff: Light/Shadow Now Affects Mobs, NPCs, and Props

**Date:** 2026-06-28  
**Session:** lighting-mobs-props  
**Persona:** Producer  
**Apples:** 🍎🍎 estimated → 🍎🍎 actual (exact)

## Systems touched

enemies, lighting

## What Was Done

Fixed the dynamic light/shadow overlay only darkening floor tiles. Mobs, NPCs, and props now dim with the torch falloff like the floor.

### Root cause

The darkness overlay (`lightOverlayRt`) rendered at depth **-18** — above terrain (-20) and doors (-19) but **below every gameplay sprite**: entities (default depth 0), props (`PROP_DEPTH` 2–4), VFX/objective markers (5–50). Those drew on top, so the torch falloff only dimmed the floor.

### Changes

**`src/shared/render-depths.ts`** — added documented `LIGHTING_OVERLAY_DEPTH = 800`: above all world gameplay sprites, below boss-spawn telegraph FX (879–881) and `UI_DEPTH_CUTOFF` (900).

**`src/engine/scenes/MainGameScene.ts`** — overlay render-texture now `.setDepth(LIGHTING_OVERLAY_DEPTH)` instead of `-18`.

**`tests/unit/main-game-scene-lighting-overlay.test.ts`** — guards: overlay depth > `PROP_DEPTH.front` and > max `WORLD_VFX_DEPTH`, < `UI_DEPTH_CUTOFF`; overlay uses the constant.

## Verification

- `verify:fast` ✅; full `verify` ✅ for typecheck/lint/format/unit/integration/build; lighting overlay unit test 7/7.
- Before/after in dev game (Floor 1): before — mob + WELCOME prop fully bright in shadow; after — both dim with torch distance. Screenshots in session `files/light-before.png`, `light-play1..3.png`.

## Known Issues / Caveats

- Headless Floor 1 _completion_ passes; the wall-time perf guards (~50s vs 30s budget, 6 seeds) trip on this slow local box only — frame counts unchanged, and a render-depth constant has no path into the headless ECS sim. Budget intentionally not weakened. Expect green on CI hardware.
- Objective markers / quest "!" indicators (depth 20–45) now also dim in shadow; acceptable, they only show when discovered/near.

## Recommended Next Steps

- Optional: promote the before/after into a deterministic e2e pixel guard sampling a known prop in shadow.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": { "pr-preflight": { "deny": 1 } },
  "tools": { "create_pull_request": 1 }
}
```
