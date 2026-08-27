# ADR 0052: Ten-slot equipment UX with generalized N-item comparison tooltips

## Status

Accepted

## Date

2026-08-28

## Estimated Complexity

🍎🍎🍎 x 1 — touches 2 systems (`src/core`, `src/engine`) with new visual-review
scenarios and focused e2e/unit coverage, but no new lab required and no
gameplay-rule changes.

## Context

The real-game equipment UI needed to be redesigned around exactly ten player
slots (Head, Neck, Main Hand, Chest, Off Hand, Gloves, Legs, Ring 1, Feet,
Ring 2) with clear selection/preview/unequip behavior. Once the paper doll was
reduced to ten slots, several tooltip/preview edge cases became visible that
the previous single-item tooltip renderer could not express correctly:

- Two equipped rings ("ring ambiguity") need independent comparisons against
  whichever ring slot a candidate would replace, not a single shared delta.
- Equipping a two-handed weapon while both hands are occupied ("multi-hand
  replacement") displaces two items at once; the candidate's stat delta must
  be computed against the _combined_ stats of both displaced items, and the
  UI must show the candidate alongside both displaced items in one row.
- Weapon tooltips had no visible DPS or effect (knockback/AoE) stats, so a
  player comparing two weapons had no way to see effective damage output or
  side effects without reading source.
- A hover tooltip could falsely appear to occlude the bag due to Phaser's
  wrapped-text logical bounds overhanging a visually clipped comparison card.

`previewEquipDelta` in `src/core/systems/equipmentSystem.ts` only accepted a
catalog item id, so there was no core-side entry point for previewing a
candidate equip against a frozen/generated `EquipmentItemDef` (needed for the
generated ring/weapon variants used in the new edge-case scenarios).

## Decision

- Add `previewEquipDeltaForDef(world, entity, def)` to
  `src/core/systems/equipmentSystem.ts`, factored out of the existing
  `previewEquipDelta` so both catalog-id and frozen-def equip candidates share
  one swap calculation. This is the only core-layer change; equip rules,
  persistence, and stat math are unchanged — it's an additive read-only
  preview entry point.
- In `src/engine/EquipmentUI.ts` and `src/engine/item-tooltip.ts`, generalize
  tooltip stat-delta composition to N displaced items:
  `comparisonTooltipStatLines(candidate, replaced[])` sums displaced items'
  stat bonuses and diffs against the candidate, so both the 1-item (ring) and
  2-item (two-hand weapon) cases route through one function.
- Add `weaponSingleTargetDps()` and `weaponEffectTooltipLines()` so DPS and
  effects (knockback, AoE radius) render as ordinary tooltip stat lines,
  always with DPS first for weapons.
- Bind the comparison tooltip's `tooltipBounds` to the deterministic card
  geometry rectangle rather than Phaser's measured text bounds, fixing a false
  bag-occlusion report specific to the multi-card comparison renderer.
- Unify "CD Reduction" wording via `formatStatLabel()` so the Stats panel and
  every tooltip agree, and widen/pad tooltip cards to fit the additional
  lines without overflow or cramping.

## Consequences

### Positive

- One shared comparison path handles 1-N displaced items, so future
  multi-item equip scenarios (if any) reuse the same code instead of
  duplicating per-scenario delta logic.
- Weapon DPS/knockback/AoE are now visible, testable tooltip stats instead of
  implicit item-def fields a player couldn't see.
- Fixes a real false-positive bag-occlusion bug in the comparison renderer.

### Negative

- Slightly larger tooltip cards (wider dual-ring cards, taller compact
  tooltips) use marginally more screen space.

### Risks

- `previewEquipDeltaForDef` duplicates the swap-calculation entry surface;
  future equip-rule changes must update both call sites' shared body (they do
  share one implementation, so this is a naming/entry-point risk, not a logic
  duplication risk).

## Alternatives Considered

- **Per-scenario delta functions** (one for rings, one for two-hand
  replacement): rejected — would duplicate the "sum displaced items, diff
  against candidate" logic and drift over time.
- **Keep `previewEquipDelta` catalog-id-only and special-case generated defs
  in the UI layer**: rejected — would leak equip-swap math into
  `src/engine`, violating the core/engine layer boundary.
