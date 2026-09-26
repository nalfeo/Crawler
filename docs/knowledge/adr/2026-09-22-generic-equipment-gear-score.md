# ADR: Generic Floor-Scaled Equipment Gear Score

## Status

Accepted

## Date

2026-09-22

## Estimated Complexity

🍎 x 3 — shared scoring policy, generated-equipment integration, authored-content
rebalance, engine diagnostics, and deterministic balance coverage.

## Context

Equipment power was encoded independently in authored weapon numbers, wearable
stats, and procedural generation rules. That made cross-floor progression hard
to compare and allowed items with different cadence, coverage, accuracy, or
utility to look equivalent when their combat value was not. The product needs a
single internal score that works for every floor and equipment source while
keeping the numeric score out of normal player-facing UI.

The requested rarity bands are Common 50–70%, Uncommon 65–80%, Rare 75–90%,
Epic 85–95%, and Legendary 94–100% of the relevant floor-and-slot ceiling.
Floor ceilings must rise indefinitely without introducing rarity tiers above
Legendary, and a Common item on the next floor must center on the same score as
an Uncommon item on the preceding floor.

## Decision

Define one pure shared gear-score policy used by authored definitions,
procedurally generated instances, balance validation, comparison UI, and tests.
Each equipment slot has a base ceiling. Floor growth uses a geometric multiplier
of `(29 / 24)^(floor - 1)`, which exactly aligns the midpoint of next-floor
Common with the midpoint of prior-floor Uncommon.

Non-weapon score is the weighted sum of effective stats, permanent equipment
status effects, and ability grants. Authored non-weapons are recalibrated to the
midpoint of their floor, rarity, and slot band. The procedural generator selects
a deterministic point inside that same band and spends the remaining budget on
stats or weapon damage after accounting for grants and enhancement position.

Weapon score starts from accuracy-adjusted sustained damage and adds explicit
modifiers for range and safety, area coverage, pierce, bounce, returning throws,
traps, and knockback/control. Weapon base damage is recalibrated so the complete
weapon score reaches its assigned band target; legacy damage values are not
preserved as a competing balance authority.

The consolidated numeric score is exposed only by development inventory,
equipment, and shop diagnostics. Normal shop presentation receives qualitative
upgrade, sidegrade, or downgrade labels plus concrete item reasons.

## Consequences

### Positive

- Every equipment source uses one deterministic, explainable power budget.
- Floor progression and rarity overlap are independently tunable and testable.
- Different weapon mechanics contribute to value instead of raw damage being
  treated as the whole weapon.
- Procedural and authored gear obey the same ceiling and band contracts.
- Players receive useful comparisons without exposing an internal balance
  number outside development mode.

### Negative

- Existing equipment stats and weapon damage change substantially; this is an
  intentional rebalance rather than backward-compatible tuning.
- The scoring weights are a balance model and will need adjustment as new stats
  or weapon mechanics gain runtime behavior.
- Authored definitions are transformed at registration time, so debugging their
  shipped values requires inspecting the resolved definition rather than only
  its source literal.

### Risks

- A newly introduced combat mechanic can be undervalued until its contribution
  is added to the scorer and covered by a regression test.
- Large ceiling or weight changes can alter encounter pacing even while every
  item remains inside its legal band. The unchanged 1.7–2.3 representative-build
  DPS gate remains the protection against that drift.
- Floating-point calibrated damage is intentional and requires approximate
  assertions at Float32 ECS storage boundaries.

## Alternatives Considered

- **Preserve legacy item values and score them after the fact.** Rejected: this
  keeps inconsistent historical tuning as the real authority and cannot ensure
  same-slot, same-rarity parity.
- **Use floor-specific lookup tables.** Rejected: duplicated tables would drift
  between authored content and the procedural generator and would not extend
  naturally to future floors.
- **Add rarities beyond Legendary as floors advance.** Rejected: absolute point
  ceilings rise by floor while rarity remains capped at Legendary.
- **Display the numeric score to every player.** Rejected: the score is an
  internal balancing abstraction; normal UI should explain the practical trade
  through qualitative comparison and concrete reasons.
