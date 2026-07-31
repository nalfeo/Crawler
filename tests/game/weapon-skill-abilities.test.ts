/**
 * Tests for level-5 weapon skill ability grants and the weapon-prerequisite
 * passive ability system.
 *
 * Covers:
 * - SKILL_LEVEL5_ABILITY_GRANTS map contains all 20 skill IDs
 * - Ability definitions have correct weapon prerequisites
 * - skillSystem grants the ability at level 5
 * - abilitySystem applies passives when weapon prerequisite is met
 * - abilitySystem revokes passives when weapon changes to ineligible
 * - weaponPrerequisiteMet returns correct value
 * - Unconditional passives (no prerequisite) are applied unconditionally
 */
import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { Health, SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { spawnEnemy } from '../../src/core/spawners/combatants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import {
  abilitySystem,
  grantPassiveAbility,
  getOrCreateAbilityState,
  weaponPrerequisiteMet,
} from '../../src/game/systems/abilitySystem.js';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import {
  getAbilityDefinition,
  SKILL_LEVEL5_ABILITY_GRANTS,
} from '../../src/game/abilities/registry.js';
import { WEAPON_CLASS_SKILL_IDS, WEAPON_TYPE_SKILL_IDS } from '../../src/shared/weapon-skills.js';
import { WEAPON_DEFS } from '../../src/shared/weaponDefs.js';
import { setActiveWeaponDef, clearActiveWeaponDef } from '../../src/core/active-weapon.js';
import { type SkillState } from '../../src/game/skills/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupPlayerWithSkills() {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, player);
  addComponent(world.ecs, player, SkillHolder);
  statSystem(world);

  const skillMap = new Map<string, SkillState>();
  for (const skill of getAllSkillDefinitions()) {
    skillMap.set(skill.id, {
      level: 0,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    });
  }
  world.playerSkills = skillMap;
  world.skillStatesByEntity.set(player, skillMap);
  world.abilityStatesByEntity.set(player, getOrCreateAbilityState(world, player));
  return { world, player };
}

function fireSkillUsageEvents(
  world: ReturnType<typeof createTestWorld>,
  player: number,
  skillId: string,
  metric: 'weapon_fired' | 'hits_landed' | 'damage_dealt' | 'distance_dodged_near_threat',
  eventCount: number,
) {
  for (let i = 0; i < eventCount; i++) {
    world.skillUsageEvents.push({ holderEid: player, skillId, metric, amount: 1 });
  }
}

// ---------------------------------------------------------------------------
// SKILL_LEVEL5_ABILITY_GRANTS coverage
// ---------------------------------------------------------------------------

describe('SKILL_LEVEL5_ABILITY_GRANTS', () => {
  it('covers all weapon class skill IDs', () => {
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      expect(SKILL_LEVEL5_ABILITY_GRANTS.has(id), `missing grant for class skill: ${id}`).toBe(
        true,
      );
    }
  });

  it('covers all weapon type skill IDs', () => {
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      expect(SKILL_LEVEL5_ABILITY_GRANTS.has(id), `missing grant for type skill: ${id}`).toBe(true);
    }
  });

  it('covers non-weapon skills (swordsmanship, iron-skin, sprint)', () => {
    expect(SKILL_LEVEL5_ABILITY_GRANTS.has('swordsmanship')).toBe(true);
    expect(SKILL_LEVEL5_ABILITY_GRANTS.has('iron-skin')).toBe(true);
    expect(SKILL_LEVEL5_ABILITY_GRANTS.has('sprint')).toBe(true);
  });

  it('all mapped ability IDs reference real registered abilities', () => {
    for (const [skillId, abilityId] of SKILL_LEVEL5_ABILITY_GRANTS) {
      const def = getAbilityDefinition(abilityId);
      expect(def, `ability ${abilityId} (for skill ${skillId}) not found`).toBeDefined();
      expect(def!.kind).toBe('passive');
    }
  });
});

// ---------------------------------------------------------------------------
// Ability definition weapon prerequisites
// ---------------------------------------------------------------------------

describe('weapon-skill passive ability definitions', () => {
  it('weapon CLASS skill abilities have matching weaponPrerequisite', () => {
    for (const classSkillId of WEAPON_CLASS_SKILL_IDS) {
      const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get(classSkillId);
      if (!abilityId) continue;
      const def = getAbilityDefinition(abilityId);
      expect(def?.kind).toBe('passive');
      if (def?.kind === 'passive') {
        expect(
          def.weaponPrerequisite,
          `${abilityId} should have weapon prerequisite '${classSkillId}'`,
        ).toBe(classSkillId);
      }
    }
  });

  it('weapon TYPE skill abilities have matching weaponPrerequisite', () => {
    for (const typeSkillId of WEAPON_TYPE_SKILL_IDS) {
      const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get(typeSkillId);
      if (!abilityId) continue;
      const def = getAbilityDefinition(abilityId);
      expect(def?.kind).toBe('passive');
      if (def?.kind === 'passive') {
        expect(
          def.weaponPrerequisite,
          `${abilityId} should have weapon prerequisite '${typeSkillId}'`,
        ).toBe(typeSkillId);
      }
    }
  });

  it('general skill abilities (swordsmanship, iron-skin, sprint) have no weaponPrerequisite', () => {
    for (const generalId of ['swordsmanship', 'iron-skin', 'sprint']) {
      const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get(generalId)!;
      const def = getAbilityDefinition(abilityId);
      expect(def?.kind).toBe('passive');
      if (def?.kind === 'passive') {
        expect(
          def.weaponPrerequisite,
          `${abilityId} should NOT have a weapon prerequisite`,
        ).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// skillSystem grants abilities at level 5
// ---------------------------------------------------------------------------

describe('skillSystem level-5 ability grants', () => {
  it('grants the correct passive ability when sword skill reaches level 5', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordDef = getSkillDefinition('sword')!;
    const threshold = swordDef.usageThresholds[4]!; // level 5 threshold

    // Fire exactly enough usage events to hit level 5.
    fireSkillUsageEvents(world, player, 'sword', 'weapon_fired', threshold);
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player)!;
    const expectedAbilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!;
    expect(abilityState.passiveAbilityIds).toContain(expectedAbilityId);
  });

  it('grants ability for sprint skill (general, no weapon prereq) at level 5', () => {
    const { world, player } = setupPlayerWithSkills();
    const sprintDef = getSkillDefinition('sprint')!;
    const threshold = sprintDef.usageThresholds[4]!;

    fireSkillUsageEvents(world, player, 'sprint', 'distance_dodged_near_threat', threshold);
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player)!;
    const expectedAbilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sprint')!;
    expect(abilityState.passiveAbilityIds).toContain(expectedAbilityId);
  });

  it('does not grant ability below level 5', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordDef = getSkillDefinition('sword')!;
    const threshold4 = swordDef.usageThresholds[3]!; // only reach level 4

    fireSkillUsageEvents(world, player, 'sword', 'weapon_fired', threshold4);
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player)!;
    const expectedAbilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!;
    expect(abilityState.passiveAbilityIds).not.toContain(expectedAbilityId);
  });

  it('does not double-grant the ability if skill usage accumulates past level 5', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordDef = getSkillDefinition('sword')!;
    const threshold = swordDef.usageThresholds[4]!;

    // Fire way past level 5.
    fireSkillUsageEvents(world, player, 'sword', 'weapon_fired', threshold * 2);
    skillSystem(world);

    const abilityState = world.abilityStatesByEntity.get(player)!;
    const expectedAbilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!;
    const count = abilityState.passiveAbilityIds.filter((id) => id === expectedAbilityId).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// weaponPrerequisiteMet
// ---------------------------------------------------------------------------

describe('weaponPrerequisiteMet', () => {
  it('returns true for unconditional passives (no prerequisite)', () => {
    const { world, player } = setupPlayerWithSkills();
    // ever-vigilant has no weaponPrerequisite
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sprint')!;
    expect(weaponPrerequisiteMet(world, player, abilityId)).toBe(true);
  });

  it('returns false for weapon-prerequisite passive when no weapon is equipped', () => {
    const { world, player } = setupPlayerWithSkills();
    clearActiveWeaponDef(world);
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman
    expect(weaponPrerequisiteMet(world, player, abilityId)).toBe(false);
  });

  it('returns true when the equipped weapon matches the class prerequisite', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!; // class: slashing, type: sword
    setActiveWeaponDef(world, swordWeapon);
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('slashing')!; // blade-mastery (requires slashing class)
    expect(weaponPrerequisiteMet(world, player, abilityId)).toBe(true);
  });

  it('returns true when the equipped weapon matches the type prerequisite', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!; // type: sword
    setActiveWeaponDef(world, swordWeapon);
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman (requires sword type)
    expect(weaponPrerequisiteMet(world, player, abilityId)).toBe(true);
  });

  it('returns false when the equipped weapon does NOT match the type prerequisite', () => {
    const { world, player } = setupPlayerWithSkills();
    const pistol = WEAPON_DEFS.get('pistol')!; // type: pistol
    setActiveWeaponDef(world, pistol);
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman (requires sword type)
    expect(weaponPrerequisiteMet(world, player, abilityId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// abilitySystem weapon-prerequisite passive gate
// ---------------------------------------------------------------------------

describe('abilitySystem weapon-prerequisite passive gate', () => {
  it('applies a weapon-prereq passive when the right weapon is equipped', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!;
    setActiveWeaponDef(world, swordWeapon);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.appliedPassiveAbilityIds.has(abilityId)).toBe(true);
  });

  it('does NOT apply a weapon-prereq passive when wrong weapon is equipped', () => {
    const { world, player } = setupPlayerWithSkills();
    const pistol = WEAPON_DEFS.get('pistol')!;
    setActiveWeaponDef(world, pistol);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.appliedPassiveAbilityIds.has(abilityId)).toBe(false);
  });

  it('revokes a weapon-prereq passive when weapon is swapped to ineligible', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!;
    const pistol = WEAPON_DEFS.get('pistol')!;
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman

    // Grant with correct weapon.
    setActiveWeaponDef(world, swordWeapon);
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);
    expect(world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has(abilityId)).toBe(
      true,
    );

    // Swap to ineligible weapon.
    setActiveWeaponDef(world, pistol);
    abilitySystem(world);
    expect(world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has(abilityId)).toBe(
      false,
    );
  });

  it('re-applies a weapon-prereq passive when weapon swaps back to eligible', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!;
    const pistol = WEAPON_DEFS.get('pistol')!;
    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!;

    grantPassiveAbility(world, player, abilityId);

    // Apply with sword.
    setActiveWeaponDef(world, swordWeapon);
    abilitySystem(world);
    expect(world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has(abilityId)).toBe(
      true,
    );
    expect(world.vfxEvents.filter((event) => event.kind === 'abilityActivateFlash')).toHaveLength(
      1,
    );

    // Revoke with pistol.
    setActiveWeaponDef(world, pistol);
    abilitySystem(world);
    expect(world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has(abilityId)).toBe(
      false,
    );
    expect(world.vfxEvents.filter((event) => event.kind === 'abilityActivateFlash')).toHaveLength(
      1,
    );

    // Re-apply with sword.
    setActiveWeaponDef(world, swordWeapon);
    abilitySystem(world);
    expect(world.abilityStatesByEntity.get(player)!.appliedPassiveAbilityIds.has(abilityId)).toBe(
      true,
    );
    expect(world.vfxEvents.filter((event) => event.kind === 'abilityActivateFlash')).toHaveLength(
      2,
    );
  });

  it('applies unconditional passives regardless of equipped weapon', () => {
    const { world, player } = setupPlayerWithSkills();
    const pistol = WEAPON_DEFS.get('pistol')!;
    setActiveWeaponDef(world, pistol);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sprint')!; // ever-vigilant (no prereq)
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.appliedPassiveAbilityIds.has(abilityId)).toBe(true);
  });

  it('applies unconditional passives even with no weapon equipped', () => {
    const { world, player } = setupPlayerWithSkills();
    clearActiveWeaponDef(world);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('swordsmanship')!; // combat-flow (no prereq)
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.appliedPassiveAbilityIds.has(abilityId)).toBe(true);
  });

  it('does NOT push activation VFX for a no-prerequisite passive applied via applyPassive directly', () => {
    // applyPassive's VFX is scoped to weapon-prerequisite passives only (the
    // "equip flash"). A general passive granted and applied outside the
    // level-5 milestone flow (e.g. equipment/carryover re-sync) must not
    // produce misleading repeated unlock feedback.
    const { world, player } = setupPlayerWithSkills();
    clearActiveWeaponDef(world);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('swordsmanship')!; // combat-flow (no prereq)
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    expect(world.vfxEvents.some((event) => event.kind === 'abilityActivateFlash')).toBe(false);
  });

  it('DOES push activation VFX for a weapon-prerequisite passive applied via applyPassive', () => {
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!;
    setActiveWeaponDef(world, swordWeapon);

    const abilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sword')!; // keen-swordsman (weapon prereq)
    grantPassiveAbility(world, player, abilityId);
    abilitySystem(world);

    expect(world.vfxEvents.some((event) => event.kind === 'abilityActivateFlash')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Level-5 milestone unlock feedback: VFX scoping + skillPassiveUnlocked
// announcement (source-scoped to the skillSystem grant site only)
// ---------------------------------------------------------------------------

describe('level-5 milestone unlock feedback (VFX + announcement)', () => {
  it('pushes exactly one activation VFX and one skillPassiveUnlocked announcement for a general passive', () => {
    const { world, player } = setupPlayerWithSkills();
    clearActiveWeaponDef(world);
    const sprintDef = getSkillDefinition('sprint')!; // grants ever-vigilant (no prereq)
    const threshold = sprintDef.usageThresholds[4]!;

    fireSkillUsageEvents(world, player, 'sprint', 'distance_dodged_near_threat', threshold);
    skillSystem(world);

    const vfxCount = world.vfxEvents.filter(
      (event) => event.kind === 'abilityActivateFlash',
    ).length;
    expect(vfxCount).toBe(1);

    const announcement = world.announcements.find((event) => event.kind === 'skillPassiveUnlocked');
    expect(announcement).toBeDefined();
    expect(announcement?.text).toContain('Passive Unlocked:');
  });

  it('pushes a skillPassiveUnlocked announcement but NO activation VFX for a weapon-gated passive at grant time', () => {
    // The weapon-gated passive's own "equip flash" VFX comes from
    // applyPassive() when abilitySystem next runs with a matching weapon
    // equipped — the milestone site itself must not also fire VFX, or the
    // player would see two flashes for one unlock.
    const { world, player } = setupPlayerWithSkills();
    clearActiveWeaponDef(world);
    const swordDef = getSkillDefinition('sword')!; // grants keen-swordsman (sword prereq)
    const threshold = swordDef.usageThresholds[4]!;

    fireSkillUsageEvents(world, player, 'sword', 'weapon_fired', threshold);
    skillSystem(world);

    expect(world.vfxEvents.some((event) => event.kind === 'abilityActivateFlash')).toBe(false);

    const announcement = world.announcements.find((event) => event.kind === 'skillPassiveUnlocked');
    expect(announcement).toBeDefined();
    expect(announcement?.text).toContain('Passive Unlocked:');
  });

  it('does not double-fire activation VFX when the matching weapon is already equipped at grant time', () => {
    // Regression guard for the hazard the milestone-site VFX split exists to
    // avoid: if the weapon-gated passive's prerequisite is ALREADY met the
    // same tick as the level-5 grant, applyPassive() will apply it on the
    // very next abilitySystem() run and push its own "equip flash" VFX. The
    // milestone site must not ALSO push VFX for weapon-gated passives, or the
    // player would see two flashes for one unlock.
    const { world, player } = setupPlayerWithSkills();
    const swordWeapon = WEAPON_DEFS.get('sword')!;
    setActiveWeaponDef(world, swordWeapon); // matching weapon already equipped
    const swordDef = getSkillDefinition('sword')!; // grants keen-swordsman (sword prereq)
    const threshold = swordDef.usageThresholds[4]!;

    fireSkillUsageEvents(world, player, 'sword', 'weapon_fired', threshold);
    skillSystem(world); // grants the passive at level 5
    abilitySystem(world); // applies the now-eligible passive, may push its own VFX

    const vfxCount = world.vfxEvents.filter(
      (event) => event.kind === 'abilityActivateFlash',
    ).length;
    expect(vfxCount).toBe(1);

    const announcementCount = world.announcements.filter(
      (event) => event.kind === 'skillPassiveUnlocked',
    ).length;
    expect(announcementCount).toBe(1);
  });

  it('does not push unlock feedback for a mob (non-Player) reaching a skill milestone', () => {
    const world = createTestWorld({ seed: 7 });
    const mob = spawnEnemy(world, 0, 0, 50); // Enemy-tagged, not Player-tagged
    initializeBaseStats(world, mob);
    const skillMap = new Map<string, SkillState>();
    for (const skill of getAllSkillDefinitions()) {
      skillMap.set(skill.id, { level: 0, usage: 0, itemBonus: 0, triggeredMilestones: new Set() });
    }
    world.skillStatesByEntity.set(mob, skillMap);

    const sprintDef = getSkillDefinition('sprint')!;
    const threshold = sprintDef.usageThresholds[4]!;
    world.skillUsageEvents.push({
      holderEid: mob,
      skillId: 'sprint',
      metric: 'distance_dodged_near_threat',
      amount: threshold,
    });
    skillSystem(world);

    // The passive is still granted (mobs can level skills via the v2 path)...
    const abilityState = world.abilityStatesByEntity.get(mob);
    const expectedAbilityId = SKILL_LEVEL5_ABILITY_GRANTS.get('sprint')!;
    expect(abilityState?.passiveAbilityIds).toContain(expectedAbilityId);
    // ...but no player-facing HUD feedback is produced for a non-Player holder.
    expect(world.vfxEvents.some((event) => event.kind === 'abilityActivateFlash')).toBe(false);
    expect(world.announcements.some((event) => event.kind === 'skillPassiveUnlocked')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Weapon-swap HP exploit regression
// ---------------------------------------------------------------------------

describe("athlete's-grit weapon-swap cycle does not grant free HP", () => {
  it('armor increases when sports weapon equipped and returns to baseline on unequip — no HP gain', () => {
    const { world, player } = setupPlayerWithSkills();
    addComponent(world.ecs, player, Health);

    // Establish baseline stats.
    statSystem(world);
    const baseArmor = world.stores.effectiveStats.armor[player] ?? 0;
    const initialMax = world.stores.health.max[player] ?? 0;

    // Damage the player slightly so their HP is below max.
    world.stores.health.current[player] = Math.max(
      1,
      (world.stores.health.current[player] ?? 0) - 10,
    );
    const damagedHp = world.stores.health.current[player]!;

    // Equip sports weapon and grant athlete's-grit (armor +2, no maxHp change).
    const sportsWeapon = WEAPON_DEFS.get('baseball-bat')!;
    setActiveWeaponDef(world, sportsWeapon);
    grantPassiveAbility(world, player, 'athletes-grit');
    abilitySystem(world);
    statSystem(world);

    // Armor should have increased; current HP and max HP must not change.
    expect(world.stores.effectiveStats.armor[player]).toBeGreaterThan(baseArmor);
    expect(world.stores.health.current[player]).toBe(damagedHp);
    expect(world.stores.health.max[player]).toBe(initialMax);

    // Unequip weapon — passive revokes, armor returns to baseline.
    clearActiveWeaponDef(world);
    abilitySystem(world);
    statSystem(world);

    // HP must not have increased; armor returns to baseline.
    expect(world.stores.health.current[player]).toBeLessThanOrEqual(damagedHp);
    expect(world.stores.health.max[player]).toBe(initialMax);
    expect(world.stores.effectiveStats.armor[player]).toBe(baseArmor);
  });
});
