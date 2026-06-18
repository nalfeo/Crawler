# Handoff: Playwright E2E Visual Regression Tests + HudMinimap Depth Fix

**Date:** 2026-06-17  
**Complexity:** 🍎🍎🍎 (investigation + fix + new infra)  
**Verdict:** Completed — 5/5 e2e tests green

---

## What Was Done

### Problem

The user reported "the full screen map doesn't render any rooms/walls" and demanded real Playwright visual regression tests (not the existing source-code string inspection tests).

### Root Cause Found

`HudMinimap.ts` had a **depth ordering bug**:

| Object          | Depth                  | Role                                                 |
| --------------- | ---------------------- | ---------------------------------------------------- |
| `viewportFrame` | `HUD_DEPTH + 2` = 1002 | Opaque dark background rect for the map viewport     |
| `terrainRt`     | `HUD_DEPTH + 1` = 1001 | **Terrain RenderTexture (was BELOW viewportFrame!)** |
| `dotGraphics`   | `HUD_DEPTH + 2` = 1002 | Room/entity blip markers                             |

The opaque `viewportFrame` rectangle (fill `0x0a0e18`, alpha 1.0) was drawn **on top of** the terrain texture, making all rooms and walls invisible. Entity dots appeared because `dotGraphics` at the same depth (1002) was inserted into the scene _after_ `viewportFrame`, so it rendered on top.

### Fix Applied (`src/engine/HudMinimap.ts`)

- `terrainRt` depth: `HUD_DEPTH + 1` → `HUD_DEPTH + 3` (above viewportFrame)
- `dotGraphics` depth: `HUD_DEPTH + 2` → `HUD_DEPTH + 4` (above terrainRt)

### New E2E Test Infrastructure

Files added:

- `tests/e2e/e2e-constants.ts` — shared port/URL/dimension constants
- `tests/e2e/global-setup.ts` — vitest globalSetup; spawns Vite lab server on port 5299
- `tests/e2e/helpers/pixels.ts` — pngjs pixel utilities (`parsePng`, `readPixel`, `regionContainsColor`, `countNonVoidPoints`)
- `tests/e2e/minimap-overlay.test.ts` — 5 Playwright (chromium) tests

Tests cover:

1. Full-screen overlay renders safe-room floor tiles (teal `0x0f766e`)
2. Full-screen overlay renders stone-wall tiles around room perimeter
3. Map shows mix of terrain colours (at least 7 of 9 sample points non-void)
4. Overlay closes cleanly on second M press
5. Docked radar dial contains non-void terrain pixels

### Other Changes

- `vitest.config.ts`: added `globalSetup: ['tests/e2e/global-setup.ts']` to e2e project
- `.github/workflows/ci.yml`: added `test-e2e` job (advisory, `continue-on-error: true`)
- `tests/unit/hud-minimap.test.ts`: renamed "visual regression" describe blocks to "architectural guards" to accurately reflect they are source-string tests, not pixel tests

### Key Technical Detail: IPv6 on Linux

On the GitHub Actions / dev sandbox Linux environment, Vite's dev server binds to `::1` (IPv6 localhost) rather than `127.0.0.1` (IPv4). The global-setup port-wait function now tries `::1` first, then falls back to `127.0.0.1`.

---

## Apple Score

| Phase                        | Estimate   | Actual     |
| ---------------------------- | ---------- | ---------- |
| Investigation (find the bug) | 🍎         | 🍎🍎       |
| e2e infrastructure           | 🍎🍎       | 🍎🍎       |
| Fix + validation             | 🍎         | 🍎         |
| **Total**                    | **🍎🍎🍎** | **🍎🍎🍎** |

Verdict: **On-target.** The IPv6 discovery added one apple of unexpected investigation.

---

## Next Steps (if needed)

- The e2e tests run against `ux-snapshot-lab` specifically. If that lab changes significantly (layout, tile types), thresholds may need adjustment.
- Pixel color thresholds in tests use `colorDist ≤ 30`. This tolerates minor WebGL rendering variation.
- The `test-e2e` CI job is `continue-on-error: true` because Playwright/Vite startup is slower than unit tests and has CI infrastructure variance. Once the job is stable over several runs, consider removing `continue-on-error`.
