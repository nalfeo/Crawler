# Handoff: war-pick weapon icon (Floor 2 equipment)

**Date:** 2026-07-19
**Branch:** `copilot/asset-request-war-pick-again`
**Issue:** nalfeo/Crawler#1313
**Apple estimate:** 1🍎 — pure art, no engine code changes

## Summary

Produced and shipped a hand-authored 64×64 pixel-art war-pick weapon icon for the Floor 2
equipment system. The sprite is registered under the stable runtime key
`equipment/weapon/war-pick` and resolves automatically via `resolveItemSprite` (ADR 0051).

## Systems touched

- `public/assets/generated/equipment/weapon/war-pick.png` — new PNG (427 bytes)
- `public/assets/generated/manifest.json` — new entry at `entries["equipment/weapon/war-pick"]`
- `src/shared/data/sprite-catalog.json` — new catalog entry `generated:equipment/weapon/war-pick`
- `tests/integration/generated-manifest-engine.test.ts` — new integration test (tower-spear pattern)

## Pipeline steps

### Azure blocker (same as bone-saw, tower-spear, boarding-axe)

`setup:azure:env` detects `GITHUB_ACTIONS=true` / `CI=true` and exits without writing
`.env.local`. No Azure OpenAI credentials in CI agent. The brief
(`briefs/weapons/war-pick.yaml`) remains on `main` for AI regeneration via the
`asset-request.yml` workflow when credentials are available.

### Hand-authored canary PNG approach

Created a 64×64 RGBA PNG entirely in Python/Pillow. Design:

- **Head:** 10×10px main body (iron greys `#494949`–`#878787`) + asymmetric pick spike (6 pixels, bright highlight on striking edge `#959595`) + short blunt poll stub on left side
- **Neck/socket:** 7×3px, dark iron shadow
- **Haft:** 7×28px wooden handle (`#563826` / `#67442e` / `#6b5434`)
- **Grip wrap:** 10×5px leather binding (alternating dark/mid for wrap pattern)
- **Ferrule/pommel cap:** 12×3px iron cap

### Sensor results (8/8 PASS)

| Sensor                        | Result                                               |
| ----------------------------- | ---------------------------------------------------- |
| `dimensions-exact`            | ✓ 64×64                                              |
| `alpha-binary`                | ✓ all pixels 0 or 255                                |
| `palette-membership`          | ✓ all 438 opaque pixels use kenney-roguelike palette |
| `opaque-ratio`                | ✓ 10.7% (438/4096 pixels)                            |
| `opaque-bbox-fits`            | ✓ bbox 15×54 at x=[23,37] y=[7,60]                   |
| `silhouette-orientation-axis` | ✓ vertical (54H > 15W)                               |
| `interior-transparency-holes` | ✓ 0 interior holes                                   |
| `anchor-derivable`            | ✓ 107 pixels in grip zone (y=50-62)                  |

### Manifest entry

```json
"equipment/weapon/war-pick": {
  "briefId": "equipment/weapon/war-pick",
  "spriteName": "equipment/weapon/war-pick",
  "assetPath": "generated/equipment/weapon/war-pick.png",
  "approvedAt": "2026-07-19T12:00:00.000Z",
  "sourceRun": "generated/runs/war-pick/2026-07-19T12-00-00-manual",
  "variantIndex": 0,
  "sensorScore": "8/8",
  "judgeScore": null,
  "type": "weapon",
  "contentHash": "0c6c331e01fd4578d495e0b045ea8b0a85996d5c4ef9a20fcfa48cdb62978271",
  "equipment": {
    "stableId": "weapon.war-pick",
    "runtimeKey": "equipment/weapon/war-pick",
    "category": "weapon",
    "family": "axe",
    "slot": "weapon",
    "productionWaveId": "floor2-equipment-weapon-axe"
  }
}
```

### Verification

`npm run verify:fast` — 1295 tests, 89 test files, all pass. Including new integration test
`loads and preloads the shipped Floor 2 war-pick runtime key from the real manifest`.

## Wiring status

No additional wiring code needed. `resolveItemSprite` reads the manifest by runtime key
(`equipment/weapon/war-pick`). The entry is now in the manifest with the correct key, so
item icon resolution works automatically. `floor2-equipment-art.ts` already maps
`weapon.war-pick` → `equipment/weapon/war-pick`.

## Before / after

|                  | Before                               | After                                                                |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Manifest         | No `equipment/weapon/war-pick` entry | Real art entry (8/8 sensors, non-placeholder)                        |
| PNG              | Missing                              | `public/assets/generated/equipment/weapon/war-pick.png`              |
| Catalog          | No entry                             | `generated:equipment/weapon/war-pick`                                |
| Integration test | No assertion                         | Passes for runtime key, assetPath, sourceRun, preloader, file exists |

## Precedent

Follows the exact same approach as:

- `docs/knowledge/handoffs/2026-07-18-tower-spear-sprite.md`
- `docs/knowledge/handoffs/assets/bone-saw-canary.md` (if exists)
- `docs/knowledge/handoffs/assets/boarding-axe-canary.md` (if exists)
