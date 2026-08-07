# Session Handoff: Equip Items From Inventory + Placeholder Gear for Every Slot

## Date

2026-07-06

## Persona

Producer → Systems/UX (equipment + inventory)

## Systems touched

inventory, weapons, hud-ux

## Apples

5🍎 exact — multi-layer interaction (shared items/defs + core orchestration + engine gesture/wiring), new content for every slot, and a non-conflicting equip gesture layered onto the existing tooltip-pin contract.

## What Was Done

Made equipment **equippable directly from the inventory bag** and gave every
paper-doll slot equippable content so the character screen is finally actionable.

- **15 placeholder gear items** (`src/shared/items.ts`) + matching equipment defs
  (`src/shared/equipmentDefs.ts` — `GEAR_EQUIPMENT_DEFS`, `GEAR_ITEM_IDS`) covering
  every non-weapon/non-neck slot: head, face, shoulders, chest, back, belt, legs,
  feet, gloves, both arms, both wrists, both rings. With weapons (hand slots) +
  charm (neck) this fills all 18 `SLOT_REGISTRY` slots. Catalog is now 123 items.
- **`equipFromBag(world, entity, itemId, options?)`** in
  `src/core/systems/equipmentSystem.ts`: Diablo-style atomic swap — force-unequip
  every occupied target slot back to the bag, remove the item, `equip`; on any
  failure, roll back fully. Honors the same `isInSafeContext` gate as
  `equip`/`unequip` unless `force`. Returns `swappedOut` ids for UI feedback.
- **Double-click equip gesture** in `src/engine/InventoryUI.ts` (`onEquipItem`
  callback + `pointerdown`-based `DOUBLE_CLICK_MS` window). Single click/tap still
  pins the tooltip (existing e2e contract untouched). Added a tooltip footer hint
  advertising the gesture (`src/engine/item-tooltip.ts`).
- **Wired into the real game**: `MainGameScene` passes `onEquipItem` →
  `equipFromBag(this.world, this.playerEid, itemId)` and refreshes both panes on
  success. Also wired into `ui-probe-lab` (seed-all-gear button + probe methods).
- **Art-plan** `plans/item-icons/equipment-gear.art.yaml` gives all 15 gear ids a
  catalog entry (text-fallback placeholders today; sprite pipeline authors icons
  later). ADR `2026-07-06-equip-from-inventory-orchestration.md`.
- **ESLint fix**: the untracked `scripts/agent/review/setup/*.js` visual-review
  injection scripts failed `no-undef` on `window`/`document`/`Event`; added a
  scoped browser+node globals config block for `scripts/agent/review/setup/**/*.js`.

**Observed in the real path** (chrome-devtools against MainGameScene equip flow):
before — 3 fillable slots; after — equipped all 15 gear + charm and reached
`equippedCount: 18` (all 18 slots filled, 0 failures), stats aggregated
(ARMOR 15, primaries raised). Screenshot: `files/equip-all-slots-filled.png`.

## Key Decisions Made

- **Double-click, not single-click, to equip.** Single click already pins the
  tooltip (e2e-locked). Overloading it would make inspect vs. equip ambiguous.
- **`equipFromBag` owns the swap + rollback in core**, not the callers. Panes stay
  intent-only; the scene is the sole mutator. Mirrors the weapon hand-slot ADR's
  "one seam for equip bookkeeping" lesson.
- **Ship placeholder gear + art-plan entries now, author sprites later.** Unblocks
  the interaction and full-grid validation without waiting on the async art pipe.

## What's Next / Blockers

- **No blockers.** Full `npm run verify` is green: typecheck, lint, format, guards,
  unit (1109), integration (84), pr-prereqs (ADR + valid 5🍎 ledger), build. The
  ~306s headless Floor-1 gate is deferred to its required CI job (unaffected by
  this UI/content change).
- **No PR opened** — user has not asked. When they do: PR title/description must
  synthesize the whole branch (equipment UI overhaul + inventory integration +
  equip-from-inventory + placeholder gear), not just this segment.
- Future: author real gear sprites via the pipeline (art-plan entries exist);
  consider surfacing the `swappedOut` ids as an on-screen "Unequipped X" toast.

## Retrospective

### Lessons Learned

- `tests/unit/sprites/art-plan-catalog.test.ts` hard-requires every `ITEM_CATALOG`
  id to appear in exactly one `plans/**/*.art.yaml` with the right `type` (gear →
  `item`). Adding catalog items without an art-plan entry fails `verify:fast`.
  Mirror `plans/item-icons/misc.art.yaml`; no guard cross-checks `integration.id`
  against the live sprite registry, so text-fallback placeholders are fine.
- `pr-prereq-check.mjs` counts **untracked** files (`git ls-files --others`), so a
  new untracked ADR satisfies the cross-layer ADR gate without staging.
- The lab-gate inside `pr-preflight` (triggered because the diff touches
  `src/core/systems/**` + `src/labs/**`) is pathologically slow on Windows Git
  Bash (~8 min here). Known quirk — run on CI/WSL; don't re-flag it.

### Mistakes Made

- First e2e attempt drove the equip via `probe.openEquipment` (combined screen);
  the equipment layer's z-order intercepted the inventory-cell click and it
  failed. **Early signal:** the click resolved but no slot filled. Fix: use
  `probe.openInventory` (matches the working tooltip-pin test path).
- Ran full `npm run verify` before running the formatter, so it failed at the
  format step on 7 files. Run `npm run format` before the final `verify` when
  new/edited files are in play.

### Opportunities for Future Improvement

- The art-plan-catalog coverage gate could emit the expected YAML skeleton for
  missing ids to remove the copy-from-misc.art.yaml step.
- Consider a tiny deterministic e2e that asserts "all 18 slots fillable via
  `equipFromBag`" against the real scene so slot-coverage regressions are caught
  headlessly rather than by manual chrome-devtools observation.
