# Session Handoff: Inventory UI Design Language Port

## Date

2026-07-07

## Persona

UX Designer (`src/engine/**`)

## Systems touched

inventory, hud-ux

## Apples

1🍎 exact — the core work is a cosmetic design-language port. The PR-shepherd
visual-polish pass then added layout/clip fixes (sort-label padding, title-chip
proportion, grid centering), a shared `src/engine/ui-theme.ts` extraction (also
touches `EquipmentUI.ts`), and an e2e blue-steel discriminator. Still scored 1🍎:
no gameplay/sim logic, and the geometry tweaks are visual-only (per maintainer
ruling that geometry changes here are cosmetic).

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
- **Sort button and search font sizes** reduced to match pixel-font legibility,
  then re-tuned to 12px in the UX-judge polish pass (see section below)

## PR-Shepherd UX-Judge Polish Pass (2026-07-07)

During PR shepherding the maintainer required a 10-round `visual-review` LLM
"UX judge" loop (dev-only, never CI-gating) and ruled that geometry changes
count as cosmetic. Each round I ground-truthed every finding against the
captured screenshot (the LLM oscillates/contradicts itself and emits two
probe-noise findings about empty-slot tooltips — the empty cells are decorative
and have no hover), and made only genuine, non-thrash fixes.

**Additional `src/engine/InventoryUI.ts` changes from the polish pass:**

- `SEARCH_HEIGHT` 36 → 48, `CELL_GAP` 4 → 10 (generous per-slot breathing room)
- Removed non-pixel `🔍` emoji and `⇅` glyph (both rendered from a taller
  fallback face, off-theme and clip-prone)
- Search + footer text bumped to 12px with a `+3px` visual-center nudge
- **Centered the fixed-width grid** (`gridLeft`/`gridPixelWidth`) so L/R padding
  is symmetric — the panel width is header-driven and wider than the grid needs
- **Empty-slot cells**: trailing cells of the final row filled with recessed
  `emptyCell` backgrounds + inset inner frame so the grid always reads as a
  complete rectangle. Decorative only — never pushed to
  `cellBackgrounds`/`cellItemIds`, so automation item indices stay stable
- **Footer divider** + count footer aligned to the centered grid
- Icon fill `CELL_SIZE * 0.75` → `0.72`

**User-reported "Rarity cut off at the top" clip — FIXED (rule #10 before/after):**

- **Cause**: the sort button used a bare `scene.add.text(...)` with no top
  padding; Press Start 2P glyphs sit high, so the text canvas cropped their tops
  flat. The `⇅` fallback glyph made it worse. The **title** renders fine because
  it uses `crispText` + `padding: { top: 4, bottom: 2 }`.
- **Fix**: mirrored the title's proven recipe — `crispText` + `padding {top:4}`,
  `Sort: Rarity` label (no `⇅`), 12px, `+2px` y-nudge; aligned the `applyLayout`
  relayout to match.
- **Observed (deterministic crop, 4× zoom)**:
  - Before (round 9 attempt, `⇅` removed but no padding): reads **"Sort: Karity"**,
    glyph tops flat-clipped — `files/visual-review/inventory-panel-2026-07-07T05-37-40-577Z-sortcrop.png`
  - After (round 10, title-recipe padding): reads **"Sort: Rarity"**, full R bowl,
    no clipping — `files/visual-review/inventory-panel-2026-07-07T05-41-32-005Z-sortcrop.png`

**UX-judge trajectory** (verdict stayed "needs-work" — the judge plateaued at
~3–3.4/5 with oscillating/contradictory findings; I did not chase it into worse
UX per rule #12): baseline 7 blockers → rounds 1-10 hovered at 4-6 blockers,
the recurring real signals (palette/font port, emoji/glyph removal, spacing,
grid centering, and the Rarity clip) all addressed. Artifacts:
`files/visual-review/inventory-panel-*.{png,review.json}`; setup at
`scripts/agent/review/setup/ui-probe-inventory.js`.

**Title chip proportion fix (Copilot review follow-up):** the header chip
originally reused EquipmentUI's absolute `296px` width / `+146` center verbatim.
That was tuned for Equipment's 1240px panel; on the inventory's 520px panel it
spanned ~57% and left a ~150px dead gap right of "INVENTORY". Replaced with a
deterministic chip sized from the fixed title string
(`titleChipTextW = round('INVENTORY'.length * 16.5) ≈ 149`, width `+24`, centered
on `titleChipTextW / 2`), applied at both construction and in `applyLayout`. Kept
deterministic (not a runtime `title.width` read) because no `fonts.ready` await
exists in `src/`, so a width read can measure the fallback font before Press
Start 2P loads. Observed after fix: chip now hugs the title with a small even
margin, no dead gap — `files/visual-review/inventory-panel-2026-07-07T05-56-20-476Z-titlecrop.png`.

## Observed

- `npm run verify:fast` ✅ — typecheck + lint + guards + changed unit tests clean
- Layout geometry WAS adjusted in the UX-judge polish pass (SEARCH_HEIGHT,
  CELL_GAP, grid centering, empty cells, footer divider — see section above).
  The e2e probe queries live cell bounds, so it adapts; **16/16 e2e still pass**
  after the geometry changes.
- **Deterministic before/after (rule #10, PR-shepherd pass):** added an e2e pixel
  assertion in `tests/e2e/inventory-flow.test.ts`
  (`renders the panel with the blue-steel equipment design language`). It renders
  the real Phaser `InventoryUI` in headless chromium, samples the panel's left
  `PANEL_PADDING` gutter (pure `panelBg`, left of column 0 — no cells/icons/rarity
  borders/corner pixels), and asserts `regionContainsColor(..., 0x2f3f61, 30)`.
  - **New palette → PASS**; **base `InventoryUI.ts` (old dark-navy `0x0d0d1a`) → FAIL**
    with the exact assertion message → proves a genuine discriminator, not a tautology.
  - Full `inventory-flow.test.ts` e2e file: **16/16 pass** (new test + 15 siblings).

## Key Decisions Made

- Kept panel width/height auto-calculation unchanged to avoid breaking e2e test
  probe coordinates.
- Font sizes slightly reduced (e.g. title 20 → 16, sortBtn 14 → 12, tab labels
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

### Mistakes Made

- I initially trusted the visual-review loop too literally and spent several
  rounds chasing oscillating cosmetic feedback before re-grounding every claim
  against the deterministic screenshots. The early signal was contradictory
  advice across adjacent rounds (for example, simultaneously asking for tighter
  density and larger breathing room).

### Opportunities for Future Improvement

- The inventory and equipment panels now share a design language but still carry
  duplicated layout / crisp-text / chip-sizing patterns. A small shared HUD
  theming helper layer would reduce future polish diffs and make visual reviews
  less sensitive to drift between the two panels.
