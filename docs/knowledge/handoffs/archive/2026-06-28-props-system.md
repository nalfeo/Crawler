# Handoff — Props System

**Date:** 2026-06-28  
**Session branch:** `copilot/design-system-add-props-to-floors`  
**PR:** feat(props): add full props system — PlacementZone, Prop/PropLight ECS, propPlacer, multi-source lighting, prop-lab

---

## What Was Delivered

Full 4-phase props system as described in the plan, implemented directly (not delegated to a subagent — previous session lost work by delegating):

### Phase 1 — Core system (all shipped)

- `PlacementZone` + `PropCategory` + `LightEmission` on `DecorationDef`
- All 18 existing defs updated with `placementZone`+`category`
- 2 new defs: `junk-pile` (rubbish, anywhere) + `wall-sconce` (light-source, wall-adjacent, amber lightEmission)
- `DECORATION_DEF_INDEX` stable int map + `DECORATION_INDEX_TO_ID` reverse lookup
- `Prop` + `PropLight` ECS components + stores wired in `createGameWorld`
- `spawnProp(world, x, y, defId)` helper in `helpers.ts`
- `placePropsForFloor(world, floorMap, config, rng)` in `src/game/systems/propPlacer.ts`
- Floor manifest `props` section; floor1 sets dungeon/rubbish/light-source
- `initializeFloor1Scenario` calls `placePropsForFloor` after terrain seal

### Phase 2 — Engine rendering

- `PROP_DEPTH = { back:2, mid:3, front:4 }` in `render-depths.ts`
- Prop render pass in `PhaserBridge.ts` — coloured placeholder rects (amber=light, brown=rubbish, grey=structural)

### Phase 3 — Multi-source lighting

- `ComputeLightFieldParams.sources: LightSource[]` (backward-compat with `source`)
- `computeLightField` accumulates all sources, clamps to 1
- `MainGameScene.updateLightingOverlay` queries PropLight entities and appends to sources

### Lab

- `src/labs/prop-lab/index.ts` — canvas-only, registered as `prop-lab`
- Renders terrain + cave tint overlay + prop dots by category + light radii

### Art

- `plans/props/floor1-props.art.yaml` — 6 sprite briefs

---

## What Remains (deferred)

- **Phase 4 — Destructible props**: `isDestructible` flag is stored in the `Prop` component but the Health+loot pipeline is not wired. When a prop is destroyed, nothing happens yet.
- **Real sprites**: Wall sconce, junk piles etc. are all placeholder-coloured rects. Need art pipeline run.
- **Corridor-only and cave-only defs for BASIC_UNDERGROUND**: vine/pustule/moss-patch are `biomeTag: organic` so they don't appear on floor1 (which uses `biomeTag: dungeon`). If cave-only dungeon props are wanted, add new dungeon defs.

---

## Known Design Choices

- `PlacementZone` and `biomeTag` are orthogonal: a def can be `cave-only` but `biomeTag: 'organic'` — the cave-only zone applies wherever that biome tag is used.
- `DECORATION_DEF_INDEX` is explicitly stable — new entries must be appended at the end (next available: 20).
- `radiusPx` is stored in the ECS so the engine layer can read it directly without unit conversion.

---

## Apple Metrics

Estimated: 🍎🍎🍎🍎🍎  
Actual: 🍎🍎🍎🍎🍎 (spans 16 files, 4 architectural layers, new ECS system + lab)  
Verdict: exact
