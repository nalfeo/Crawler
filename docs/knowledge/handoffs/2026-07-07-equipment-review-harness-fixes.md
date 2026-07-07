# Session Handoff: Equipment Overhaul — Review-Harness Fixes + PR

## Date

2026-07-07

## Persona

Producer → Systems/UX (equipment + inventory), review-harness driver

## Systems touched

inventory, weapons, hud-ux

## Apples

5🍎 (whole-branch estimate unchanged). This segment itself was ~2🍎: two real
bug fixes surfaced by the review-harness code-review agents (equipFromBag swap
atomicity + integrated-bag wheel-scroll), regression + deterministic e2e
coverage, and recording the 5🍎 review ledger to unblock the PR.

## What Was Done

Closed out the equipment paper-doll overhaul branch by fixing the two VALID
concerns the review-harness code-review agents raised, then recording an
honest 5🍎 review ledger and opening the PR.

- **equipFromBag swap atomicity (real item-loss bug)** in
  `src/core/systems/equipmentSystem.ts`: the old rollback re-equipped displaced
  items one-by-one and ignored the `equip` result, so an item whose stat
  requirement was met only by another not-yet-restored displaced item would fail
  `canEquip` and be **permanently deleted**. `force:true` bypasses only the
  safe-context gate, not `canEquip`→`evaluateRequirements`. Fix: a
  `swapEquipFailureReasons(world, entity, def)` **pre-gate** evaluates the def's
  requirements against the post-unequip basis (base + core + retained equipped
  defs, WITHOUT the new item, EXCLUDING freed slots) via
  `computeEffectiveStatsFromLoadout` — exactly what the forward `equip()` sees
  after freeing slots — and refuses an infeasible swap **before** mutating.
  `previewEquipDelta` now uses the same helper so its verdict can never disagree
  with the real equip. Rollback path additionally hardened.
- **Integrated-bag wheel-scroll (unusable overflow)** in
  `src/engine/EquipmentUI.ts`: the integrated bag column had no wheel listener,
  so once the equippable list overflowed ~6 visible rows the extra cells were
  unreachable. Added `bagMaxScroll` tracking, a clamped `scrollBag(rows)`, a
  `handleWheel` listener (`scene.input.on('wheel', …)`) that acts only while
  visible with the pointer inside the bag bounds, and `scene.input.off` cleanup
  in `destroy()`. Exposed `getBagColumnScreenBounds` / `scrollBag` /
  `getBagScrollRow` / `getBagMaxScrollRow` (added to the inline return type).
- **Test seam** in `src/shared/equipmentDefs.ts`: `TEST_EQUIPMENT_OVERRIDES` +
  `_registerEquipmentDefForTest` / `_clearEquipmentDefsForTest` so the
  atomicity unit test can register synthetic multi-slot defs; overlay is inert
  in production (consulted first, cleared in `afterEach`). Sanctioned `_…ForTest`
  precedent (`_resetCorpseStepTrackingForTest`).
- **Regression + deterministic coverage**:
  - `tests/ecs/equip-delta-preview.test.ts` (2 preview-basis tests) and the
    atomicity + feasible-swap tests in `tests/ecs/equipment.test.ts` (seed via
    `addItem(bag, id, 1, TEST_CATALOG)` — `addItem` validates against the item
    catalog, a separate registry from the equipment-def overlay).
  - A deterministic bag-scroll e2e in `tests/e2e/inventory-flow.test.ts`: seeds
    an overflowing bag, fires a **real** `page.mouse.wheel` over the
    DOM-converted bag center, and asserts the scroll row advances + head/tail
    cell visibility flips. Wired through `ui-probe-lab` (`seedOverflowBag`,
    scroll probes) and `tests/e2e/helpers/ui-probe.ts`.

## Observed (before/after, real artifacts)

- **equipFromBag atomicity** — unit-proven against the real core system: base
  STR 8 (`initializeBaseStats`), a girdle grants +5 (live 13 clears a blade's
  STR≥10 req); unequipping the girdle first drops STR to 8 < 10. On the OLD
  rollback the blade would be silently deleted; the new pre-gate refuses the
  infeasible swap and leaves the loadout intact. `tests/ecs/equipment.test.ts`
  atomicity + feasible-swap tests PASS (would fail on pre-fix rollback).
- **bag wheel-scroll** — the deterministic e2e fires a real DOM wheel event and
  observes `getEquipmentBagScrollRow()` advance from 0 and the head cell go
  `null` / tail cell become non-null (the listener is genuinely wired, not
  just the programmatic path). Deterministic gate now **17/17**.
- Prior branch UX observations remain valid (see
  `2026-07-06-equip-from-inventory-placeholder-gear.md` and `plan.md`):
  all-18-slots-filled real paper-doll, real gear icons via the boot preload
  path, HUD-hide-while-modal (minimap no longer punches through the panel).

## Key Decisions Made

- **Pre-gate infeasible swaps rather than "best-effort rollback".** The only
  correct fix for the item-loss bug is to refuse a swap that cannot succeed
  _before_ removing anything from the bag, using the same stat basis the
  forward equip will see. Sharing that basis with `previewEquipDelta` guarantees
  preview and execution never disagree.
- **Real wheel event in the e2e, not just programmatic scroll.** Asserting
  `scrollBag()` alone would pass even if the listener were never registered; the
  real `page.mouse.wheel` is what proves the wiring. Programmatic assertions are
  the reliable core if the real-wheel block ever flakes on CI.
- **Recorded the review ledger honestly.** `code_review` round 1 found the
  equipFromBag concern (resolved) → round 2 clean; `multi_model_review`
  adjudicated equipFromBag=valid/resolved, bag-scroll=valid/resolved,
  gemini renderSlots-leak=invalid (already fixed). Never weakened a stage to go
  green (rules #12/#14).

## What's Next / Blockers

- **No blockers.** `VERIFY_FULL=1 npm run verify` green; deterministic e2e gate
  17/17; review ledger validates (exit 0); PR opened with a holistic
  whole-branch title/description and `gh pr merge --auto --squash` armed.
- The ~306s headless Floor-1 gate runs in its required CI job (this is a
  UI/content + core-swap-guard change; win-rate unaffected).
- Future: surface `swappedOut` ids as an on-screen "Unequipped X" toast; author
  final gear sprites via the pipeline (art-plan entries exist).

## Retrospective

### Lessons Learned

- **`addItem` and the equipment-def overlay are separate registries.**
  `addItem`/`search`/`filterByTag` validate against the **item catalog**
  (`items.ts` `getItemById`) and throw `Unknown itemId`; the equipment
  filters/`getEquipmentDefForItem` use the **equipment-def registry**. Seeding a
  synthetic id needs a `catalog` passed to `addItem`; `removeItem`/`hasItem`
  don't validate.
- **`createEquipmentUI` has an inline explicit return type** — every new public
  method must be added there too or TS2561 fires.
- **A green lab never proves real-game wiring.** The bag-scroll listener is only
  trustworthy because a real DOM wheel event exercises it end-to-end; the
  atomicity fix is only trustworthy because the unit test drives the real core
  system with a basis that reproduces the deletion.

### Mistakes Made

- Initially seeded the atomicity test with bare `addItem(bag, id)` and hit
  `Unknown itemId` — the overlay seam only covers equipment defs, not the item
  catalog. Fixed by passing a small `TEST_CATALOG`.

### Opportunities for Future Improvement

- A guard that asserts every `get*ScreenBounds`/public probe method on
  `createEquipmentUI` is present in the inline return type would remove the
  TS2561 foot-gun.
- Consider a deterministic "swap that would delete an item is refused" headless
  assertion at the scene level, complementing the unit test.
