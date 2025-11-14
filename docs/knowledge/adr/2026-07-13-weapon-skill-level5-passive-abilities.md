# ADR 0061: Level-5 Weapon Skill Passive Abilities with Weapon Prerequisites

## Status

Accepted

## Date

2026-07-13

## Estimated Complexity

🍎🍎🍎🍎🍎 — touches core/engine/game layers; new ability category, VFX kind, achievement fact, and two lab updates

## Context

Weapon skills (class skills: slashing/stabbing/smashing/ranged/throwing/forearms/arcane; type skills: sword/dagger/hammer/sports-equipment/bow/crossbow/pistol/throwing-weapons/unarmed/spellcraft; and general skills: swordsmanship/iron-skin/sprint) previously had no reward at level 5. The issue requested:

1. A passive ability unlocked for each skill at level 5.
2. Weapon-class and weapon-type abilities must require the appropriate weapon to be equipped (passive bonuses only active while wielding the right weapon).
3. General skills get unconditional passive bonuses.
4. Visual feedback when a weapon-gated passive activates.
5. UX listing of passive abilities (labs).
6. Achievement integration for first/fifth/tenth passive ability unlocked.

The existing ability system (`abilitySystem`) already processed `passiveAbilityIds` per entity. The question was how to integrate weapon-prerequisite gating cleanly without a new component or separate system.

## Decision

**Extend `PassiveAbilityDefinition` with an optional `weaponPrerequisite?: WeaponSkillId` field** that names the skill ID the active weapon must match (via `weaponClassSkillId` or `weaponTypeSkillId` on the weapon def).

**`abilitySystem` evaluates prerequisites each frame** using `weaponPrerequisiteMet()`:

- Passives with no prerequisite: applied once, never revoked (apply-once guard via `appliedPassiveAbilityIds`).
- Passives with a prerequisite: check `weaponPrerequisiteMet` each frame; `apply` when `prereqMet && !alreadyApplied`, `revoke` when `!prereqMet && alreadyApplied`.
- Revoke order: remove stat modifiers first, then clear tracking set (prevents ghost buffs).

**`skillSystem` grants the ability at level 5** using the `SKILL_LEVEL5_ABILITY_GRANTS` map (skill ID → ability ID). For v2 holder-scoped events the `holderEid` is used directly; for v1-style events (no `holderEid`), the player entity is resolved via `query(world.ecs, [Player])` so the milestone is never consumed without the ability being granted.

**`weaponPrerequisiteMet()` is player-scoped**: it calls `getActiveWeaponDef(world)` which reads the world-global active weapon state. Non-player entities return `false` (no weapon equip system), making their weapon-prereq passives inert by design.

**`unlockedAbilityCount` achievement fact** is scoped to the player entity via `query(world.ecs, [Player])[0]` so future non-player ability states don't inflate progression counters.

## Consequences

### Positive

- **Simple frame-evaluation**: no weapon-generation cache; `appliedPassiveAbilityIds` is the single source of truth for apply/revoke state.
- **Correct revoke semantics**: removes stat modifiers before clearing tracking, so no passive can enter a ghost state.
- **Player-only scope is explicit**: `hasComponent(world.ecs, holderEid, Player)` guard in `weaponPrerequisiteMet` documents the constraint and prevents incorrect application for future non-player entities.
- **Lab visibility**: both the abilities-lab and skill-lab now surface weapon-gated ability status (✓ active / ⚠ needs weapon / —).
- **Achievement-integrated**: three milestone achievements gate on `unlockedAbilityCount` (1, 5, 10).

### Negative

- **`SKILL_LEVEL5_ABILITY_GRANTS` is a second source of truth** alongside the skill definition registry and ability registry. Drift risk if a skill ID is renamed. Mitigated by the test suite asserting all 20 entries map to valid registered ability IDs.
- **Passive stat bonuses are 1 frame late** on the first application (abilitySystem runs after statsSystem in the frame pipeline). This is standard ECS behavior and imperceptible for persistent passive bonuses.

### Risks

- **Multi-entity ability holders**: if future work grants abilities to non-player entities (mobs, companions), weapon-prereq passives will silently do nothing for those entities because `weaponPrerequisiteMet` always returns `false` for non-Player entities. This is intentional for now but needs revisiting when per-entity weapon state is introduced.
- **Save/load**: `appliedPassiveAbilityIds` is a runtime `Set` that is not persisted. On load, `abilitySystem` re-applies all passives from scratch on the first frame. This is correct but must not change if serialization is added later.

## Alternatives Considered

**A. Derive passives during stat recompute** — check `skill.level >= 5 && weaponEquipped` inside `statsSystem` each frame, applying effects inline. Rejected: invasive change to statsSystem, blurs the apply/revoke model, and makes it harder to emit VFX on the transition.

**B. Encode ability grant on the skill milestone definition** (`milestone.abilityGrantId`) — avoids the side map. Rejected for this PR: requires changing `SkillDefinition` shape and all 20 skill definitions; out of scope. Left as a recommended future improvement.

**C. Holder-scoped weapon state** — store the equipped weapon per entity instead of world-global. Rejected: player is the only weapon-equipping entity today; the world-global active-weapon system is already established. Worth revisiting at multi-entity time.

**D. Weapon-generation cache for O(0) re-evaluation** — was implemented initially, then removed after review: the cache was redundant (appliedPassiveAbilityIds already tracked state), introduced a stale-EID memory leak risk, and the `weaponChanged` gate it enabled could cause passives to fail to revoke if any non-weapon-swap change made the prereq false.
