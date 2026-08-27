# ADR: Generated equipment carries its base's inherent stat line at every rarity

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — one generator contract plus the Floor 2 reward legality invariant; no new lab, no new system.

## Context

Playtest issue [#3697](https://github.com/nalfeo/Crawler/issues/3697) reported
that **Leather Gloves offer no stat bonus at all**. They literally do not.

`generateEquipmentInstance` (`src/game/generated-equipment-generator.ts`)
classifies each base as `weapon` / `armor` / `accessory`, where `accessory`
means "non-weapon base whose authored `statBonuses.armor` is 0". Since the
2026-07-31 rarity-decoupling change, a generated instance's `frozen.statBonuses`
was built from **only** two sources:

1. the scaled inherent `armor` of an armor-kind base, and
2. the stats granted by rarity affixes.

Common rarity has a **zero-effect affix budget** (`RARITY_EFFECT_BUDGET.common
=== 0`). So every base with no inherent armor realized at Common with an
**empty stat map** — a dead item that occupies a slot, consumes a reward roll,
and costs full price at the Floor 2 Quartermaster (which prices offers purely
from item level and rarity). Eight shipped bases were affected:
`leather-gloves`, `feet.merchant-sandals`, `accessory.compass-charm`,
`accessory.gearwork-locket`, `accessory.surveyor-map`,
`accessory.lucky-feather`, `accessory.warding-bell`, `accessory.iron-ring`.

The decoupling model implicitly assumed every base's _inherent_ power is armor.
That is true for helmets and breastplates and false for gloves, sandals, rings
and charms, whose authored stat line **is** their identity.

## Decision

Inherent power is defined **per target kind**, and always reaches the generated
instance:

| target kind | inherent power                                                    |
| ----------- | ----------------------------------------------------------------- |
| weapon      | base damage, carried by `frozen.activeWeaponSnapshot` (unchanged) |
| armor       | level/rarity-scaled `armor` (unchanged)                           |
| non-weapon  | **plus** the base's authored non-armor stat line, copied verbatim |

Non-weapon bases (both armor-kind and accessory-kind) therefore spread their
authored non-armor stats into every instance made from them, at every rarity.
The accessory level curve is already `no-inherent-scaling/v1`, so the inherent
line is not level-scaled — it is the item's constant identity. Rarity affixes
still stack on top, so **rarity remains affix-driven**.

The Floor 2 reward legality invariant
(`_assertGeneratedRewardInstanceLegal` in
`src/game/floor2-reward-bundle-resolver.ts`) changes accordingly: a Common
instance may not carry an **affix-driven** stat bonus (evidence read from
`instance.resolvedEffects`, the authoritative affix record), rather than "may
not carry any non-armor stat". `generatedEquipmentInstanceHasNonArmorStatBonus`
is replaced by `generatedEquipmentInstanceHasAffixDrivenStatBonus`.

Weapons deliberately still contribute no `statBonuses` inherent line: their
power lives entirely in the weapon snapshot, and the shipped weapon bases
author an empty stat map.

## Consequences

### Positive

- No shipped base can realize a stat-less item; Common gear keeps its authored
  identity (gloves swing faster, charms are lucky, sandals are quick).
- Quartermaster gold and reward rolls always buy something.
- The same base now reads identically across acquisition sources — the frozen
  stats match what the catalog authored.
- Two deterministic guards make the failure class un-shippable:
  `tests/unit/generated-equipment-meaningful-instances.test.ts` (every shipped
  base is meaningful at Common) and a Quartermaster shipped-path assertion that
  no offer is a dead item.

### Negative

- Common and Uncommon non-weapon items are stronger than before by exactly
  their authored line (e.g. `+1 DEX`, `+0.05 attack speed` for gloves). This is
  a deliberate power restoration, not a new power budget: the values are the
  ones the static catalog always authored and that the static-item equip path
  already granted.
- Newly generated accessory instances have different fingerprints than before,
  so a same-seed run generated on an older build produces different frozen
  stats. Persisted instances remain loadable — frozen content and fingerprints
  are stored with the instance, not recomputed from the catalog.

### Risks

- Floor 2 economy/balance shifts slightly upward for non-weapon gear; the
  headless Floor 1 gates do not cover it, so Floor 2 balance is monitored via
  the normal sweep path.
- Armor-kind bases still drop their non-armor _rider_ only where the rider is
  zero; any base authoring a stat as "affix-only" must now express that by not
  authoring it on the base at all.

## Alternatives Considered

- **Give every blank base an inherent `armor` value.** Nonsense for a charm or
  a surveyor's map, and it only fixes the bases someone remembers to edit — the
  next zero-armor base ships dead again.
- **Exclude accessory-kind bases from Common draws.** Preserves the previous
  model exactly, but shrinks Common pools (which have authored non-empty
  invariants) and leaves Common gloves permanently unobtainable rather than
  fixing the item.
- **Keep dropping armor-kind non-armor riders and restore only accessory
  lines.** Rejected as semantically unstable: whether a base keeps its authored
  stats would hinge on whether it happens to have `armor > 0`, so adding 1
  armor to a charm would silently delete its luck.
