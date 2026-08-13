# Session Handoff: Level-5 Weapon Skill Abilities

## Date

2026-07-13

## Persona

Producer → Combat Engineer

## Systems touched

weapons, vfx, ci-policy

## Apples

5🍎 estimated, 5🍎 actual (exact). Full JSON summary in docs/knowledge/metrics/apples/2026-07-13-weapon-skill-abilities.json.

## What Was Done

Implemented the full level-5 weapon skill ability system (issue #1098):

**New types & registry** (`src/game/abilities/types.ts`, `src/game/abilities/registry.ts`):

- Added `weaponPrerequisite?: WeaponSkillId` to `PassiveAbilityDefinition` + Zod schema
- Added `WEAPON_PREREQ_IDS` const-array for safe `z.enum()` narrowing (avoids `string` inference bug)
- Added 20 new passive ability definitions — one per weapon skill (3 general, 7 class, 10 type)
- Added `SKILL_LEVEL5_ABILITY_GRANTS` map linking all 20 skill IDs to their ability IDs
- General skills have no `weaponPrerequisite` (always-on); class/type skills require the matching weapon

**Skill system** (`src/game/systems/skillSystem.ts`):

- Modified the level-5 milestone block to call `grantPassiveAbility(world, holderEid, abilityId)` for any skill that has a registered level-5 ability grant

**Ability system** (`src/game/systems/abilitySystem.ts`):

- Added `weaponPrerequisiteMet(world, eid, abilityId)` — checks the current weapon against the passive's `weaponPrerequisite` field (matches on `weaponClassSkillId` OR `weaponTypeSkillId`)
- Passive processing loop splits: unconditional passives apply once (never re-evaluated or revoked); weapon-prereq passives re-evaluate **every frame** so equip/unequip is reflected immediately without any per-entity cache

**VFX** (`src/shared/vfx-events.ts`, `src/engine/EffectsVfx.ts`):

- Added `weaponAbilityActivate` VFX kind
- Purple ring + rising motes effect in `EffectsVfx` when a weapon-gated passive activates

**Achievements** (`src/shared/achievements.ts`, `src/game/systems/achievementSystem.ts`, `src/shared/data/achievements.floor1.json`):

- Added `unlockedAbilityCount` number fact (counts `passiveAbilityIds` for the **player entity only** — scoped to `players[0]`; returns 0 when no player exists)
- Added 3 new achievements: `ability-awakening` (≥1 ability), `arsenal-builder` (≥5), `walking-arsenal` (≥10)

**Labs / UX** (`src/labs/abilities-lab/index.ts`, `src/labs/skill-lab/index.ts`):

- Abilities lab HUD ticker now shows active weapon name and per-passive prereq status (✓/✗)
- Skill lab table now has an extra "Lv5 Ability" column showing which passive is granted at level 5, with color-coded prereq status (active/weapon-needed/—)

**Tests** (`tests/game/weapon-skill-abilities.test.ts`):

- 22 tests covering SKILL_LEVEL5_ABILITY_GRANTS coverage, ability definitions, skill-level-5 grant flow, `weaponPrerequisiteMet`, apply/revoke behavior, and unconditional passives

Observed in `npm run verify:fast` (all 87 test files, 1199 tests passing, typecheck + lint clean).

## Key Decisions Made

1. **Per-frame evaluation over generation cache**: The initial design used a `lastWeaponGenerationByEntity` WeakMap to skip re-evaluation when the weapon hadn't changed (O(0) cost per frame with no weapon switch). This was removed because it introduced stale-EID risk on entity recycling and added complexity for a negligible CPU saving at player-only scope. The final approach re-evaluates weapon-gated prerequisites every frame unconditionally — straightforward, safe, and correct.

2. **Zod schema narrowing trick**: `z.enum([...string[]])` infers `string`, not the union literal. Fixed with a `const WEAPON_PREREQ_IDS = [...WEAPON_CLASS_SKILL_IDS, ...WEAPON_TYPE_SKILL_IDS] as const` typed array, ensuring `z.enum(WEAPON_PREREQ_IDS)` correctly narrows to `WeaponSkillId`.

3. **StatKey constraint**: Passive stat effects must use keys from `STAT_KEYS` (`maxHp | moveSpeed | damage | armor | attackSpeed | pickupRange | projectileCount | projectileSpeed | accuracy`). `hpRegen` is NOT a valid key — `stalwart-resolve` uses `armor + maxHp` instead.

4. **No new circular imports**: `skillSystem.ts` already imported from `abilitySystem.ts` (for `queueAbilityTrigger`); adding `grantPassiveAbility` to the same import keeps the graph clean.

5. **VFX events are cosmetic-only**: Pushing `weaponAbilityActivate` events in headless runs is safe — EffectsVfx only runs in Phaser scenes, and the VFX ring buffer caps at 512 with oldest-drop semantics.

## What's Next / Blockers

- **In-game HUD panel for passive abilities**: The issue mentions "passive abilities need to be listed in some UX." The abilities-lab and skill-lab now show them, but there's no in-game HUD panel yet. A small "active passives" section on the skills/character screen would complete this.
- **Milestone descriptions for level-5**: The `milestone` objects in skill definitions don't carry a description string for the ability grant — the milestone just says `{ level: 5, ... }`. A future session could add a `description` field to milestones to display "Unlocks: <Ability Name>" in the UI.
- **Additional passive effects**: Several abilities use placeholder-style effects (e.g. small `+2 armor`). These could be tuned with proper balance once playtesting reveals which weapons need stronger passives.

## Retrospective

### Lessons Learned

- **`z.enum()` type inference**: `z.enum(['a', 'b'])` from a `string[]` variable infers `string` not `'a' | 'b'`. Must use `as const` on the array before passing to `z.enum()`. This caused a typecheck failure that was fixed by introducing `WEAPON_PREREQ_IDS as const`.
- **StatKey exhaustiveness**: Always check `STAT_KEYS` in `src/shared/stats.ts` before using a stat name in a passive effect. `hpRegen` looks plausible but isn't in the set.
- **Per-frame weapon-prereq evaluation is the right approach**: The `lastWeaponGenerationByEntity` cache pattern was considered but removed — it introduced stale-EID risk and complexity with no meaningful runtime benefit at player-only scope. Future agents should default to evaluating weapon-gated passives every frame (the current `abilitySystem` approach) rather than reaching for a switch-event or generation-cache pattern.

### Mistakes Made

- Used `hpRegen` as a stat key in an early draft of `stalwart-resolve`. The typecheck immediately caught it, but it slowed iteration. Should have scanned `STAT_KEYS` first.
- Imported `Player` component in the test file but never used it (lint error). Caught by `verify:fast` lint pass.
- `weaponPrerequisiteMet` wasn't exported from `src/game/systems/index.ts` initially, causing the skill-lab import to fail. Added to both the systems index and the game index.

### Opportunities for Future Improvement

- A `milestone.description` field on `SkillDefinition` milestones would let the in-game skill-tree UI display "Unlocks: Hardened Warrior (level 5)" without hard-coding the ability grant map in the renderer.
- The `SKILL_LEVEL5_ABILITY_GRANTS` map is currently the only mechanism for skill→ability linking. If more milestone levels get abilities (level 10, 15), the map pattern should be generalized to `SKILL_MILESTONE_ABILITY_GRANTS: Map<skillId, Map<level, abilityId>>`.
