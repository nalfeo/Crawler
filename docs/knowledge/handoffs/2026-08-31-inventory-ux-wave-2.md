# Session Handoff: Inventory UX Wave 2

## Date

2026-08-31

## Persona

UX Designer

## Systems touched

inventory, devtools

## Apples

3🍎 estimated, 4🍎 actual. The final scope exceeded the original estimate after
expanding from two to five meaningful inventory states, adding mixed-loot and
overflow probes, fixing shared status presentation, and consolidating tooltip
formatting across InventoryUI and EquipmentUI.

## What Was Done

- Recovered archived Phase 1 commit `46bf575cd` as `cf1cae162`, preserving its
  three completed build → review → revise loops and the approved Pixel UI
  slate/gold treatment.
- Added five registered real-Phaser inventory scenarios with mixed equipment,
  materials, and other loot:
  - `inventory-no-tooltip-or-filters`
  - `inventory-tooltip`
  - `inventory-tab-filtering`
  - `inventory-text-filtering`
  - `inventory-lots-of-items`
- Added deterministic automation for mixed and overflow bag seeds, category and
  text filters, direct tooltip preview through the production renderer, filter
  state, inventory composition, and all relevant screen-space bounds.
- Declared stable visual-review regions for the panel, tabs, search/sort
  controls, grid, visible cells, tooltip, count footer, overflow range, and
  scroll controls. E2E assertions cover containment, mixed composition,
  filtering behavior, overflow behavior, and tooltip/source-cell
  non-occlusion.
- Fixed the cross-state status defect once in InventoryUI: sort is now a
  high-contrast gold control, item counts are emphasized, and overflow range
  text plus controls remain readable without changing rarity-colored borders.
- Consolidated stat label/value and DPS formatting in shared
  `item-tooltip.ts`, removing duplicated EquipmentUI formatting and ensuring
  inventory/equipment tooltip precision cannot drift.
- Follow-up independent review also aligned EquipmentUI with the same
  accuracy/stat-aware theoretical DPS model used by InventoryUI, added DPS to
  empty-slot candidate cards, sized standard tooltips for all five rendered
  stat rows, and cleared/gated hidden inventory interaction state.
- Corrected two stale test fixtures without loosening assertions: the shared
  tooltip border now expects deliberate Pixel UI gold (`0xfcd34d`), and the
  integration Phaser Text stub preserves text and measured-width behavior.
- Observed the revised inventory in the real `MainGameScene` at 1280×720.
  Before: live gameplay had no inventory panel open. After: `[I]` opened the
  revised panel in an unlocked safe context without clipping or HUD-critical
  overlap. Evidence: `files/real-game-after-select.png` and
  `files/real-game-inventory-final.png`.

## Visual Evidence

All final captures have zero deterministic blockers and zero evidence-backed
blockers:

| Scenario              | Final lineage artifact                                                 | Score |
| --------------------- | ---------------------------------------------------------------------- | ----: |
| No tooltip or filters | `files/visual-review/after/v1.1.4/inventory-no-tooltip-or-filters.png` |  80.0 |
| Tooltip               | `files/visual-review/after/v1.1.4/inventory-tooltip.png`               |  80.0 |
| Tab filtering         | `files/visual-review/after/v1.1.4/inventory-tab-filtering.png`         |  80.0 |
| Text filtering        | `files/visual-review/after/v1.1.4/inventory-text-filtering.png`        |  80.0 |
| Lots of items         | `files/visual-review/after/v1.1.6/inventory-lots-of-items.png`         |  80.0 |

Each image has a matching `.review.json`. Baselines are under
`files/visual-review/before/live-dev/`. Final task-specific feedback is in
`files/visual-review/feedback/before-after-feedback.jsonl`.

## Shared File Changes

`src/engine/item-tooltip.ts` changed explicitly:

- tooltip chrome uses `PIXEL_UI.panelFill` and `PIXEL_UI.gold`;
- `formatStatLabel` and `formatStatValue` are the canonical shared formatters;
- `formatDpsValue` now provides one precision contract for InventoryUI and
  EquipmentUI.

The equipment replacement DPS assertion deliberately changed from raw
`22.2 (-2.8)` to accuracy/stat-aware `20.6 (-3.90)` because both inventory and
equipment now use the same theoretical display model and below-10 deltas retain
two decimals.

## Verification

- `npm run typecheck` — passed.
- touched-file Prettier check and ESLint — passed.
- targeted tooltip unit/integration tests — 11/11 passed.
- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts` — 32/32
  passed.
- `npm run review:visual:deterministic` — 38/38 passed.
- `npm run verify:fast` — passed.

## Review

The first review round found duplicated/residual stat formatting, inconsistent
equipment DPS, a five-row tooltip sizing mismatch, hidden-panel state leakage,
and a non-representative generated-weapon fixture. Those root causes were fixed
with shared formatters/model use, lifecycle gating, matched render/layout caps,
and a canonical rare two-affix generated weapon. Two independent reviewers then
rechecked the final 4🍎 change set.

## Key Decisions

- The work is presentation-only: no capacity, slot count, stack size, item
  stat, weight, encumbrance, drop, economy, item-data, or tuning changes.
- Rarity-colored borders remain unchanged as a functional scanning affordance.
- Equipment received no separate Phase 2 scenario because the five new states
  exercise inventory behavior; EquipmentUI changed only where the recovered
  styling and shared tooltip formatter already crossed this slice.
- LLM blocker identities moved between byte-identical structural states, so
  every actual revision was checked against deterministic regions. Iteration
  continued until each persisted final scenario also met the requested
  80/zero-blocker subjective gate.

## Caveats

The visual-review runner persists complete screenshots and reports on Windows,
then may terminate with a libuv handle-closing assertion. Two of five highly
parallel captures also timed out once and passed when retried with lower
concurrency. These are tooling teardown/concurrency defects; the final artifacts
and deterministic gates are complete.
