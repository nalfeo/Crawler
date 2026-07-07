# Session Handoff: Inventory UI Design Language Port

## Date

2026-07-07

## Persona

UX Designer (`src/engine/**`)

## Systems touched

inventory, hud-ux

## Apples

1🍎 exact — single-file cosmetic token swap, no new logic or tests needed.

## What Was Done

Ported the EquipmentUI's design language ("blue-steel" pixel-dungeon aesthetic)
into `InventoryUI.ts`, making both panels visually consistent.

**Changes to `src/engine/InventoryUI.ts`:**

- **`FONT_FAMILY`**: `'Segoe UI, Arial, sans-serif'` → `'"Press Start 2P", "Courier New", monospace'`
- **`COLORS` palette**: replaced dark-navy scheme with equipment's blue-steel:
  - `panelBg 0x2f3f61`, `panelBorder 0x3f5f93`
  - `tabBg 0x394c74`, `tabActive 0x4a6699`, `tabActiveBorder 0xf2c14e` (gold)
  - `searchBg 0x2b3c61`, `searchBorder 0x3f5f93`
  - `cellBg 0x445c89`, `cellHover 0x5472ab`
  - `textPrimary 0xd9e2ef`, `textSecondary 0xaebdd5`
  - Added `accent 0xc2d0e6`, `sectionHeader 0x355180`
- **`hex()` utility**: added shared helper (same as EquipmentUI)
- **`MIN_TEXT_RESOLUTION = 6`**: floors all `textResolution` usage for crisp pixel text
- **Panel alpha**: `0.95` → `1` (fully opaque, matches Equipment)
- **Corner pixel decorations**: four 6×6 `COLORS.panelBorder` accent squares at
  panel corners, mirroring EquipmentUI's `cornerPixels`; positions updated in `applyLayout`
- **Title frame**: rectangle behind "INVENTORY" title (same pattern as EquipmentUI's `titleFrame`);
  position updated in `applyLayout`
- **Title style**: font size `20px` → `16px` to match Equipment's compact pixel header
- **All hardcoded hex strings** replaced with `COLORS` + `hex()` throughout:
  slotFilterLabel, sortBtn, search bar placeholder/active, tab borders/text,
  stack counts, item count footer, `updateSearchDisplay`
- **Sort button and search font sizes** reduced to match pixel-font legibility
  (14px/13px Segoe → 11px/10px Press Start 2P)

## Observed

- `npm run verify:fast` ✅ — 3991/3991 tests pass, typecheck + lint clean
- Zero layout-geometry changes (CELL_SIZE, COLS, CELL_GAP, TAB_HEIGHT,
  SEARCH_HEIGHT, PANEL_PADDING all unchanged); existing e2e probe positions stable

## Key Decisions Made

- Kept panel width/height auto-calculation unchanged to avoid breaking e2e test
  probe coordinates.
- Font sizes slightly reduced (e.g. title 20 → 16, sortBtn 14 → 11, tab labels
  13 → 10) because Press Start 2P is wider per em than Segoe UI; the pixel count
  stays visually balanced.
- Active tab border uses gold (`0xf2c14e`, same as `slotSelectedBorder` in
  EquipmentUI) for visual continuity across both panels.

## What's Next / Blockers

None. Change is cosmetic-only; the full verify gate is deferred to CI as usual.

## Retrospective

### Lessons Learned

- `applyLayout` must be updated for every new static decoration added at
  construction time (cornerPixels, titleFrame) — otherwise a resize call silently
  leaves the decorations at their original positions. EquipmentUI's applyLayout
  is the canonical reference for this pattern.
