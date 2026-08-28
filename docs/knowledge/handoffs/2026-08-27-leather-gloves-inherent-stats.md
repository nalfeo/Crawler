# Session Handoff: Generated equipment keeps its base inherent stat line

## Date

2026-08-27

## Persona

Game Designer (equipment generation contract)

## Systems touched

inventory

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

Fixed issue #3697 ("leather gloves offer not stat bonus at all"). The Floor 2
generated-equipment generator built `frozen.statBonuses` from only the scaled
inherent `armor` of an armor-kind base plus rarity-affix stats, so any
non-weapon base with **no authored armor** realized at Common (zero affix
budget) with a **literally empty stat map**. Eight shipped bases were affected:
`leather-gloves`, `feet.merchant-sandals`, `accessory.compass-charm`,
`accessory.gearwork-locket`, `accessory.surveyor-map`,
`accessory.lucky-feather`, `accessory.warding-bell`, `accessory.iron-ring`.
Five (`leather-gloves`, `feet.merchant-sandals`, `accessory.compass-charm`,
`accessory.gearwork-locket`, and `accessory.surveyor-map`) were sellable by the
Floor 2 Quartermaster, which prices offers purely from item level and rarity;
the two rare Wave B bases and Basic Leather's `accessory.iron-ring` were
reward-only dead items.

Non-weapon bases now spread their authored non-armor stat line into every
instance at every rarity; rarity affixes stack on top, so rarity stays
affix-driven. The Floor 2 Common reward invariant became "no **affix-driven**
stat bonus", read from `resolvedEffects`.

Observed deterministically in the shipped acquisition path — before:
`seed 1: offer floor2-quartermaster:1:0:0 (feet.merchant-sandals) is a dead item`
and `bases realizing a dead Common item: leather-gloves, feet.merchant-sandals,
accessory.compass-charm, accessory.gearwork-locket, accessory.surveyor-map,
accessory.lucky-feather, accessory.warding-bell, accessory.iron-ring`; after:
every Quartermaster offer across 12 seeds × 2 restock epochs is meaningful and
Common Leather Gloves realize `{ attackSpeed: 0.05, dexterity: 1 }`.

## Key Decisions Made

- Inherent power is defined **per target kind** — weapon → base damage (weapon
  snapshot), armor → scaled `armor`, non-weapon → **plus** its authored
  non-armor line copied verbatim. See ADR
  `2026-08-27-generated-equipment-inherent-stat-line.md`, which also amends
  ADR 0069 and 0070.
- Rejected the "give every blank base some inherent armor" patch: it is
  nonsense for a charm/map and only fixes the bases someone remembers to edit.
- Rejected restoring accessory lines only: whether a base keeps its authored
  stats would hinge on `armor > 0`, so adding 1 armor to a charm would silently
  delete its luck (raised by the separate-model plan review).
- The Common contract now reads affix evidence from `resolvedEffects` rather
  than diffing stat maps, so an affix that touches the same stat as the base
  cannot be misclassified.

## What's Next / Blockers

- Floor 2 economy shifts slightly upward for non-weapon gear (by exactly the
  authored line). Worth a Floor 2 balance sweep if Floor 2 tuning gets a pass.
- Quartermaster pricing still ignores item power entirely (`20 + level*5`,
  ×1.5 for uncommon). A dead item can no longer be sold, but a weak item and a
  strong one still cost the same — a separate design question.

## Retrospective

### Lessons Learned

- "Item has no stats" bugs are worth checking at the **generator** level before
  the UI level: both `InventoryUI` and `EquipmentUI` render `statBonuses`
  faithfully, so an empty tooltip was truthful.
- Two `Leather Gloves` exist (`leather-gloves` in `equipmentDefs.ts` and
  `hands.leather-gloves` in the Basic Leather set) with the same display name
  but different stats. Only the legacy one was blank; do not assume the id from
  the display name.
- Toggling the one-line generator change off and re-running the new guards is a
  cheap, reliable way to produce genuine before/after evidence for rule #9 when
  the run bundle/screenshot URLs are unreachable from the sandbox.

### Mistakes Made

- First instinct was the narrow data patch (`armor: 1` on the gloves def). A
  quick enumeration over the shipped base catalogs showed 8 blank bases, not 1
  — enumerate the whole catalog before deciding a data fix is "the" fix.
- The new Quartermaster test initially called `_restockFloor2Quartermaster`
  with a hardcoded epoch `2`; the restock API only accepts
  `current.restockEpoch + 1`, so it failed with `invalid-epoch`. Read the epoch
  from the stock rather than hardcoding it.

### Opportunities for Future Improvement

- The meaningfulness predicate lives in tests only. If more acquisition paths
  appear (drops, crafting), promoting it into the generator as a fail-closed
  post-generation assertion would make dead items impossible by construction.
- `Floor 2 Quartermaster` prices ignore generated power; a power-aware price
  would make the shop legible.
