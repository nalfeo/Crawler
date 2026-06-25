# UI Probe Lab

Automation harness for the inventory + mobile **e2e / visual-regression** tests.
It mounts the **real** canvas UI components over one synthetic safe-room world
and exposes a typed `window.__uiProbe` API the Playwright suites drive:

- `InventoryUI` — bag grid, item sprites, hover/pin tooltips
- `EquipmentUI` — the "Gear" paper-doll
- `HudMinimap` — docked radar + fullscreen overlay (with its close button)
- `LevelUpUI` — the −/+ stat allocation controls

## Why a probe lab?

All four surfaces render to the Phaser WebGL canvas — there is **no DOM** to
query with `data-testid`. This lab is the instrumentation seam: it opens each
surface on demand and reports the **world-space hit-rects** of the controls a
mobile user taps, plus small pieces of observable state (open flags, tooltip
visible/pinned, effective Charisma). The scene runs in `Phaser.Scale.FIT` mode (mirroring the shipped game) so the
scene keeps its 1280×720 design space: the probe reports stable design-space
hit-rects while the canvas is letterbox-scaled to the viewport. Tests convert
those design rects to CSS pixels via the live canvas bounding rect and
`getGameSize()`, then tap real positions and pixel-sample the result. This lets
the mobile suite exercise genuine **portrait vs landscape** viewports.

## Usage

```
npm run lab   # then open ?lab=ui-probe-lab
```

Use the **UI Surfaces** folder in the lil-gui panel to open each surface and
equip the charm by hand. Programmatically, everything is on `window.__uiProbe`:

| Method                                                                                                 | Purpose                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `ready()` / `getGameSize()`                                                                            | readiness + scene coordinate space   |
| `openInventory()` / `isInventoryOpen()`                                                                | open the bag grid                    |
| `getInventoryCellBounds(i)`                                                                            | world-space rect of the i-th cell    |
| `isTooltipVisible()` / `isTooltipPinned()`                                                             | hover vs click-pin tooltip state     |
| `openEquipment()` / `isEquipmentOpen()`                                                                | open the Gear paper-doll             |
| `getCharisma()` / `equipCharm()`                                                                       | effective Charisma + equip the charm |
| `openMinimapOverlay()` / `isMinimapOverlayOpen()` / `getMinimapCloseBounds()`                          | fullscreen minimap + close button    |
| `openLevelUp(points)` / `getStatControlBounds()` / `getDraftAllocation(stat)` / `getRemainingPoints()` | level-up −/+ controls                |

## Determinism

Seeded with `SeededRandom` (`seed = 4242`). The merchant's charm icon is baked
from a synthetic generated-sprite registry, so a sprite always renders without
depending on the real (out-of-band) sprite manifest.

## Driven by

- `tests/e2e/inventory-flow.test.ts`
- `tests/e2e/mobile-hit-targets.test.ts`
