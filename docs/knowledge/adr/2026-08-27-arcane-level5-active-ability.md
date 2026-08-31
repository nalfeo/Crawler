# ADR: Arcane level-5 milestone grants an ACTIVE ability

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 4 — spans `src/shared`, `src/game`, `src/engine`, and `src/labs`, and changes a
milestone-reward contract that four consumers read.

## Context

`docs/knowledge/adr/2026-07-13-weapon-skill-level5-passive-abilities.md` established
that every weapon-skill level-5 milestone grants a **passive** ability, and
`skillSystem.applyMilestone` hard-coded `kind: 'passive'` on both the grant and the
L15/L20 replacement revoke to match.

Issue #3676 reports that the Arcane class does not read that way to a player: arcane
is the one weapon class whose entire fantasy is _casting_, and its level-5 reward was
`arcane-mastery-base` — a flat "+10% damage with arcane weapons" passive that is
indistinguishable in play from the level-10 reward it sits next to. The expectation
(and the one the shared presentation table already encoded — every weapon-type L5
entry in `ABILITY_PRESENTATION_BY_ID` was already declared `kind: 'active'` while the
game registry defined passive stubs) is that arcane level 5 unlocks something the
player can actually see fire.

The blocker was structural, not cosmetic: `applyMilestone` could not grant a non-passive
milestone reward at all.

## Decision

1. **Arcane L5 → `arcane-nova`, L15 → `arcane-nova-evolved`**, both `kind: 'active'`.
   L15 must move too: `applyMilestone` revokes the L5 grant when L15 fires, so leaving
   L15 passive would delete the player's new active.
2. **New ability IDs** rather than flipping the kind of `arcane-mastery-base` /
   `arcane-mastery-evolved`. `normalizeAbilityState` calls `validatePersistedAbilityKind`,
   which throws on a kind mismatch for a carried-over grant; new IDs make any in-flight
   floor-carryover state a no-op instead of a throw.
3. **`kind: 'active'`, not `'spell'`.** `activateAbility` gates spells on
   `world.featureUnlocks.spells`, which on Floor 1 only opens after the Slime Rat boss.
   A milestone reachable before that boss must not be a spell, and it must not emit
   spell-mastery usage events.
4. **The weapon-class contract is preserved by fire-gating, not equip-gating.**
   `weaponPrerequisite` is generalized from passives to any ability kind; a weapon-gated
   active stays owned and equipped on the bar, but `activateAbility` refuses to fire it
   while the prerequisite is unmet — checked _before_ the cooldown read/stamp so a
   suppressed attempt neither burns the cooldown nor emits activation feedback.
   `forceActivateAbility` is deliberately **not** gated: it is the documented lab bypass.
5. **`applyMilestone` derives the grant AND revoke kind from the catalog** instead of
   assuming passive, and grants actives with `configureActives: 'fill-open-slots'` so the
   ability lands in a free bar slot and degrades to owned-but-unequipped at the slot cap
   rather than throwing.
6. **A new `skillAbilityUnlocked` announcement kind** ("Ability Unlocked: …") rather than
   reusing `skillPassiveUnlocked`, whose documented contract is passive-only.

`weaponPrerequisite` lives on the **shared** presentation table so `src/engine` can read
it without importing `src/game` (a layer violation): `HudAbilityBar` needs it to dim a
slot whose weapon prerequisite is currently unmet.

## Consequences

### Positive

- The arcane class now has a castable milestone unlock, matching the player expectation
  in #3676 and the shared presentation table's pre-existing `kind: 'active'` declarations.
- Milestone rewards of **either** kind are now expressible; the next class conversion is
  a registry edit with no system change.
- Weapon-gated actives score correctly in the AI equipment evaluator
  (`expectedActiveAbilityValue` now zeroes an active the candidate weapon cannot fire),
  so the AI no longer over-values an arcane active on a melee loadout.

### Negative

- `unlockedAbilityCount()` in `achievementSystem` counts `passiveAbilityIds` only, and the
  Floor 1 achievement copy is explicitly about _passive_ abilities. Arcane L5/L15 therefore
  no longer contribute to those achievements. **Deliberately left unchanged**: broadening
  the count would silently re-tune achievement pacing for every class, which is a separate
  design decision, not a bug fix for #3676.
- Floor 1 headless `RunStats` fingerprints shift on seeds where the AI runs an arcane
  weapon long enough to reach arcane level 5. This is intended behaviour change, not a
  regression.

### Risks

- **Balance.** `arcane-nova` is a 10s-cooldown AoE that fires on a 2-enemy cluster within
  8 ft. Mitigated by requiring an arcane weapon (so it is not a free universal AoE), by
  the 2-enemy minimum, and by validating Floor 1 win rate rather than cherry-picked seeds.
- **Slot pressure.** At the 10-slot cap the grant silently stays unequipped. This matches
  the existing equipment grant path; the player can re-equip from the `[B]` modal.

## Alternatives Considered

- **Equip-gate on weapon swap** (grant/revoke the active as the weapon changes). Rejected:
  it fights the player-configured ability bar, churns cooldown state on every swap
  (revoke clears `cooldownByAbilityId`), and complicates slot-cap re-equip.
- **Reuse an existing active (e.g. `fireball`) as the reward.** Rejected: `fireball` is a
  spell, so it would be gated behind the post-boss spellbook unlock and would collide with
  the boss reward pick.
- **Make the active unconditional (drop `weaponPrerequisite`).** Rejected: it would break
  the weapon-CLASS contract that every other class milestone honours, and hand every build
  a free AoE by grinding one weapon.
- **Convert only L5 and leave L15 passive.** Rejected: `applyMilestone`'s L15-replaces-L5
  rule would revoke the active and hand back a passive, a strict downgrade.

## Related

- `docs/knowledge/adr/2026-07-13-weapon-skill-level5-passive-abilities.md` — the L5-passive
  contract this ADR narrows to "all classes except arcane". (Cited by filename: its ADR
  number 0061 collides with `0061-game-intro-screen-player-identity.md`.)
- Issue #3676.
