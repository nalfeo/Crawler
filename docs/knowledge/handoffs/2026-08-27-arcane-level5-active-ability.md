# Session Handoff: Arcane level-5 milestone grants an ACTIVE ability

## Date

2026-08-27

## Persona

Game Designer → Systems Engineer

## Systems touched

weapons, hud-ux, ai-combat-balance

## Apples

4🍎 estimated — see `docs/knowledge/metrics/apples/2026-08-27-arcane-level5-active-ability.json`.

## What Was Done

Issue #3676: the Arcane weapon-class skill's level-5 milestone granted
`arcane-mastery-base`, a flat "+10% damage with arcane weapons" **passive**, when the
arcane class unlock is supposed to be an **active** ability. The root blocker was that
`skillSystem.applyMilestone` hard-coded `kind: 'passive'` on both the grant and the
L15/L20 replacement revoke, so a non-passive milestone reward was not expressible at all.

- New actives `arcane-nova` (L5) and `arcane-nova-evolved` (L15), both
  `kind: 'active'` (not `'spell'`) with `weaponPrerequisite: 'arcane'`. L15 had to move
  too, because `applyMilestone` revokes the L5 grant when L15 fires.
- `applyMilestone` now derives grant **and** revoke kind from the catalog, and grants
  actives with `configureActives: 'fill-open-slots'`.
- `weaponPrerequisiteMet` generalized from passives to any kind; `activateAbility` fire-gates
  on it (before the cooldown read/stamp). `forceActivateAbility` is deliberately NOT gated —
  it is the documented lab bypass.
- New `skillAbilityUnlocked` announcement kind ("Ability Unlocked: …"); `skillPassiveUnlocked`
  keeps its passive-only contract. Three `HudAnnouncementBanner` branch sites updated.
- `HudAbilityBar` now shows for non-spell actives (it previously required
  `featureUnlocks.spells`, which on Floor 1 only opens post-boss — the ability would have
  been invisible) and dims a slot whose weapon prerequisite is unmet.
- AI `equipment-loadout-evaluator` zeroes weapon-gated actives on a mismatched loadout weapon.
- Skill lab renders active milestone rewards with a `[ACTIVE]` tag + prereq status.

**Observed in the shipped pipeline** (rule #9, not a lab):
`tests/integration/arcane-nova-active-unlock.test.ts` drives
`createFloor1MainSceneOptions()` + engine `runSimulationStep`. Before: the reward landed
in `passiveAbilityIds` and nothing ever fired. After: `arcane-nova` is on
`equippedActiveAbilityIds`, and with a Fire Wand equipped + 2 clustered dummies its
cooldown is stamped within 5 frames while `featureUnlocks.spells === false`; with a sword
equipped it stays equipped but never fires and never burns cooldown.

## Key Decisions Made

- **New ability IDs, not a kind flip.** `validatePersistedAbilityKind` throws on a kind
  mismatch for carried-over grants; new IDs make in-flight carryover a no-op.
- **`'active'`, never `'spell'`** — spells are gated on the post-boss `featureUnlocks.spells`
  and emit spell-mastery usage events. A pre-boss milestone must not be one.
- **Fire-gate, not equip-gate.** Equip/unequip on weapon swap would fight the player's
  `[B]` ability-bar config and churn cooldown state (revoke clears `cooldownByAbilityId`).
- **`weaponPrerequisite` lives on the SHARED presentation table** because `src/engine`
  cannot import `src/game`, and `HudAbilityBar` needs to read it.
- **Achievements deliberately unchanged.** `unlockedAbilityCount()` counts passives only;
  arcane L5/L15 no longer contribute. Broadening the count would silently re-tune achievement
  pacing for every class — a separate design decision. Documented in the ADR.

See `docs/knowledge/adr/2026-08-27-arcane-level5-active-ability.md`.

## What's Next / Blockers

- The shared presentation table declares **all 20** weapon-type L5 abilities as
  `kind: 'active'` while `src/game/abilities/registry.ts` still defines them as passive
  stubs ("active wiring is a follow-up"). Arcane is now the first one actually converted;
  the plumbing added here (kind-derived milestone grants + weapon-gated actives) makes each
  remaining conversion a registry-only edit. That is the obvious follow-up wave.
- `arcane-nova` tuning (14 base dmg / 3-tile radius / 10s, 2-enemy cluster within 8 ft) was
  authored conservatively and is worth a Floor-1 win-rate sweep via
  `workflow_dispatch` (`weapon-sweep.yml`) before further buffs. Do **not** tune it against
  hand-picked seeds (rule #12).

## Retrospective

### Lessons Learned

- `revokeRequests` in `applyMilestone` was **hard-typed** `Array<{ kind: 'passive'; … }>`,
  not merely passing a passive literal. Widening the value without widening the type would
  not have compiled — worth grepping for the type, not just the literal, when generalizing a
  hard-coded discriminant.
- `HudAbilityBar.sync()` hid the entire bar behind `featureUnlocks.spells`. Any future
  non-spell active granted before the first boss is invisible unless that gate is relaxed;
  this is a real trap for the remaining 19 weapon-type conversions.
- The shared `ABILITY_PRESENTATION_BY_ID` already declared these L5 abilities `active` while
  the game registry defined them passive. When a bug report says "this was supposed to be X",
  check whether some layer already believes X — it is strong evidence about intent.

### Mistakes Made

- First draft of the integration test registered the arcane `SkillState` by **replacing**
  `world.skillStatesByEntity.get(playerEid)`, clobbering the scenario's own skills, and used
  `metric: 'damage_dealt'` when arcane's `usageMetric` is `weapon_fired`. Both showed up as
  the same symptom — skill level stuck at 0. Early signal: if a skill will not level in a
  test, check `usageMetric` on the definition _first_, then check you merged rather than
  replaced the holder map.

### Opportunities for Future Improvement

- `applyMilestone`'s L15→L5 / L20→L10 replacement mapping is implicit in two magic-number
  branches. A declarative `replaces: 5` field on the milestone would make the upgrade chain
  readable and stop the next author from converting one tier and stranding the other.
- There is no deterministic guard that a milestone-granted ACTIVE is reachable on the HUD
  (i.e. that the bar is visible when it is granted). The integration test covers arcane
  specifically; a generic guard over all milestone actives would scale to the follow-up wave.
