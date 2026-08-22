import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { SkillHolder } from '../../src/core/components.js';
import { spawnEnemy, spawnMeleeSwing, spawnPlayer } from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { meleeSwingSystem } from '../../src/core/systems/meleeSwingSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/index.js';
import { getAllSkillDefinitions, getSkillDefinition } from '../../src/game/skills/registry.js';
import {
  WEAPON_CLASS_SKILL_IDS,
  WEAPON_TYPE_SKILL_IDS,
  CLASS_SKILL_THRESHOLDS,
  TYPE_SKILL_THRESHOLDS,
} from '../../src/shared/weapon-skills.js';
import { WEAPON_DEFS } from '../../src/shared/weaponDefs.js';
import {
  computeEffectiveAccuracy,
  emitWeaponSkillEvents,
  setActiveWeapon,
  weaponSystem,
} from '../../src/game/weaponSystem.js';
import { SKILL_HARD_CAP } from '../../src/shared/skills.js';
import type { SkillState } from '../../src/game/skills/types.js';
import { TeamId } from '../../src/shared/constants.js';

// Helper: create a world with a player and all weapon skills registered.
function setupPlayerWithWeaponSkills() {
  const world = createTestWorld();
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
  return { world, player };
}

// ─── Taxonomy tests ────────────────────────────────────────────────────────────

describe('weapon-skills taxonomy', () => {
  it('all WEAPON_CLASS_SKILL_IDS have registered skill definitions', () => {
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(def, `missing skill definition for class skill "${id}"`).toBeDefined();
    }
  });

  it('all WEAPON_TYPE_SKILL_IDS have registered skill definitions', () => {
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(def, `missing skill definition for type skill "${id}"`).toBeDefined();
    }
  });

  it('class skills use weapon_fired metric', () => {
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(def?.usageMetric).toBe('weapon_fired');
    }
  });

  it('type skills use weapon_fired metric', () => {
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(def?.usageMetric).toBe('weapon_fired');
    }
  });

  it('class skills grant damage per level', () => {
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(
        def?.perLevelBonus.damage,
        `class skill "${id}" should grant damage per level`,
      ).toBeGreaterThan(0);
    }
  });

  it('type skills grant accuracy per level', () => {
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      const def = getSkillDefinition(id);
      expect(
        def?.perLevelBonus.accuracy,
        `type skill "${id}" should grant accuracy per level`,
      ).toBeGreaterThan(0);
    }
  });

  it('all skill definitions have exactly 20 usage thresholds', () => {
    const allSkills = getAllSkillDefinitions();
    for (const skill of allSkills) {
      expect(skill.usageThresholds).toHaveLength(SKILL_HARD_CAP);
    }
  });

  it('CLASS_SKILL_THRESHOLDS has 20 entries and is strictly increasing', () => {
    expect(CLASS_SKILL_THRESHOLDS).toHaveLength(SKILL_HARD_CAP);
    for (let i = 1; i < CLASS_SKILL_THRESHOLDS.length; i++) {
      expect(CLASS_SKILL_THRESHOLDS[i]).toBeGreaterThan(CLASS_SKILL_THRESHOLDS[i - 1]!);
    }
  });

  it('TYPE_SKILL_THRESHOLDS has 20 entries and is strictly increasing', () => {
    expect(TYPE_SKILL_THRESHOLDS).toHaveLength(SKILL_HARD_CAP);
    for (let i = 1; i < TYPE_SKILL_THRESHOLDS.length; i++) {
      expect(TYPE_SKILL_THRESHOLDS[i]).toBeGreaterThan(TYPE_SKILL_THRESHOLDS[i - 1]!);
    }
  });
});

// ─── WeaponDef augmentation tests ─────────────────────────────────────────────

describe('WeaponDef skill fields', () => {
  it('every weapon def has a weaponClassSkillId that is a valid class skill', () => {
    for (const def of WEAPON_DEFS.values()) {
      expect(
        WEAPON_CLASS_SKILL_IDS as readonly string[],
        `weapon "${def.id}" has unknown class skill "${def.weaponClassSkillId}"`,
      ).toContain(def.weaponClassSkillId);
    }
  });

  it('every weapon def has a weaponTypeSkillId that is a valid type skill', () => {
    for (const def of WEAPON_DEFS.values()) {
      expect(
        WEAPON_TYPE_SKILL_IDS as readonly string[],
        `weapon "${def.id}" has unknown type skill "${def.weaponTypeSkillId}"`,
      ).toContain(def.weaponTypeSkillId);
    }
  });

  it('every weapon def has baseAccuracy in [0, 1]', () => {
    for (const def of WEAPON_DEFS.values()) {
      expect(def.baseAccuracy).toBeGreaterThanOrEqual(0);
      expect(def.baseAccuracy).toBeLessThanOrEqual(1);
    }
  });

  it('traps have baseAccuracy of 1.0', () => {
    const landmine = WEAPON_DEFS.get('landmine');
    expect(landmine?.baseAccuracy).toBe(1.0);
  });

  it('sword is in slashing class and sword type', () => {
    const sword = WEAPON_DEFS.get('sword');
    expect(sword?.weaponClassSkillId).toBe('slashing');
    expect(sword?.weaponTypeSkillId).toBe('sword');
  });

  it('pistol is in ranged class and pistol type', () => {
    const pistol = WEAPON_DEFS.get('pistol');
    expect(pistol?.weaponClassSkillId).toBe('ranged');
    expect(pistol?.weaponTypeSkillId).toBe('pistol');
  });

  it('punch and kick are in forearms class and unarmed type', () => {
    const punch = WEAPON_DEFS.get('punch');
    const kick = WEAPON_DEFS.get('kick');
    expect(punch?.weaponClassSkillId).toBe('forearms');
    expect(punch?.weaponTypeSkillId).toBe('unarmed');
    expect(kick?.weaponClassSkillId).toBe('forearms');
    expect(kick?.weaponTypeSkillId).toBe('unarmed');
  });
});

// ─── Accuracy system tests ─────────────────────────────────────────────────────

describe('computeEffectiveAccuracy', () => {
  it('returns baseAccuracy when player has no accuracy bonus', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('pistol')!;
    const eff = computeEffectiveAccuracy(world, player, def);
    // Base pistol accuracy = 0.8, accuracy stat base = 0
    expect(eff).toBeCloseTo(0.8);
  });

  it('clamps effective accuracy to 1.0 maximum', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    // Add a large accuracy bonus via stat modifier
    world.statModifiers.push({
      sourceType: 'skill',
      sourceId: 'test',
      stat: 'accuracy',
      op: 'add',
      value: 5.0,
    });
    statSystem(world);
    const def = WEAPON_DEFS.get('bow')!;
    const eff = computeEffectiveAccuracy(world, player, def);
    expect(eff).toBeLessThanOrEqual(1.0);
  });

  it('traps always return 1.0 regardless of accuracy stat', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    // Even with negative modifiers, traps should return 1.0
    world.statModifiers.push({
      sourceType: 'skill',
      sourceId: 'test',
      stat: 'accuracy',
      op: 'add',
      value: -10,
    });
    statSystem(world);
    const def = WEAPON_DEFS.get('landmine')!;
    const eff = computeEffectiveAccuracy(world, player, def);
    expect(eff).toBe(1.0);
  });

  it('accuracy stat bonus from dexterity is applied', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    // Add dexterity points — each effective point gives 0.25pp accuracy.
    world.stores.coreStatPoints.dexterity[player] = 10;
    statSystem(world);
    const def = WEAPON_DEFS.get('pistol')!;
    const eff = computeEffectiveAccuracy(world, player, def);
    // pistol base 0.8 + effective dex (base 1 + 10 allocated = 11) * 0.0025 = 0.8275
    expect(eff).toBeCloseTo(0.8275, 5);
  });
});

// ─── Skill emission tests ──────────────────────────────────────────────────────

describe('emitWeaponSkillEvents', () => {
  it('emits class and type skill events on weapon fire', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;
    emitWeaponSkillEvents(world, player, def);

    const events = world.skillUsageEvents;
    const classEvent = events.find((e) => e.skillId === 'slashing' && e.metric === 'weapon_fired');
    const typeEvent = events.find((e) => e.skillId === 'sword' && e.metric === 'weapon_fired');
    expect(classEvent).toBeDefined();
    expect(typeEvent).toBeDefined();
  });

  it('skill levels up after enough weapon fires (type skill hits level 4)', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // TYPE_SKILL_THRESHOLDS[3] = 90 → need 90 fires for level 4
    const targetLevel = 4;
    const threshold = TYPE_SKILL_THRESHOLDS[targetLevel - 1]!;
    for (let i = 0; i < threshold; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }

    const typeState = world.playerSkills.get('sword');
    expect(typeState?.level).toBeGreaterThanOrEqual(targetLevel);
  });

  it('class skill hits level 2 by end of floor 1 threshold (~80 fires)', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // CLASS_SKILL_THRESHOLDS[1] = 80 → level 2 at 80 fires
    const threshold = CLASS_SKILL_THRESHOLDS[1]!;
    for (let i = 0; i < threshold; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }

    const classState = world.playerSkills.get('slashing');
    expect(classState?.level).toBeGreaterThanOrEqual(2);
  });

  it('type skill gives accuracy stat bonus on level-up', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('pistol')!;

    // Verify level 1 threshold boundary: 9 fires → still level 0
    const threshold = TYPE_SKILL_THRESHOLDS[0]!; // = 10 fires for level 1
    for (let i = 0; i < threshold - 1; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }
    expect(world.playerSkills.get('pistol')?.level).toBe(0);

    // Fire once more (now at threshold) → level 1
    emitWeaponSkillEvents(world, player, def);
    skillSystem(world);
    statSystem(world);

    const pistolState = world.playerSkills.get('pistol');
    expect(pistolState?.level).toBeGreaterThanOrEqual(1);

    // accuracy should now be > 0 (base = 0, +0.03/level)
    const accuracyStat = world.stores.effectiveStats.accuracy[player] ?? 0;
    expect(accuracyStat).toBeGreaterThan(0);
  });

  it('class skill gives damage bonus on level-up', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;
    const initialDamage = world.stores.effectiveStats.damageBonus[player] ?? 0;

    // Fire enough to level slashing class skill to level 1 (threshold = 30)
    for (let i = 0; i < 30; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }
    statSystem(world);

    const slashingState = world.playerSkills.get('slashing');
    expect(slashingState?.level).toBeGreaterThanOrEqual(1);

    const newDamage = world.stores.effectiveStats.damageBonus[player] ?? 0;
    expect(newDamage).toBeGreaterThan(initialDamage);
  });

  it('milestone fires when reaching level 5', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // Reach level 5 (TYPE_SKILL_THRESHOLDS[4] = 135)
    const threshold = TYPE_SKILL_THRESHOLDS[4]!;
    for (let i = 0; i < threshold; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }

    const swordState = world.playerSkills.get('sword');
    expect(swordState?.level).toBeGreaterThanOrEqual(5);
    expect(swordState?.triggeredMilestones.has(5)).toBe(true);
  });
});

// ─── Balance validation ────────────────────────────────────────────────────────

describe('floor 1 balance targets', () => {
  it('type skill reaches level 4 within 200 weapon fires (floor 1 pace)', () => {
    // Floor 1 balance goal: type skill level 4 by end of floor.
    // We simulate 200 fires and assert level >= 4.
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('pistol')!;
    for (let i = 0; i < 200; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }
    const pistolState = world.playerSkills.get('pistol');
    expect(
      pistolState?.level,
      'pistol type skill should reach level 4 within 200 fires',
    ).toBeGreaterThanOrEqual(4);
  });

  it('class skill reaches level 2 within 200 weapon fires (floor 1 pace)', () => {
    // Floor 1 balance goal: class skill level 2 by end of floor.
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('pistol')!;
    for (let i = 0; i < 200; i++) {
      emitWeaponSkillEvents(world, player, def);
      skillSystem(world);
    }
    const rangedState = world.playerSkills.get('ranged');
    expect(
      rangedState?.level,
      'ranged class skill should reach level 2 within 200 fires',
    ).toBeGreaterThanOrEqual(2);
  });
});

// ─── Hit-based skill gate tests ────────────────────────────────────────────────

describe('weapon skill hit gate', () => {
  it('no skill XP on missed attack (accuracy check fails)', () => {
    const { world } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // Spawn an enemy in melee range so weaponSystem actually attempts the attack.
    // The MELEE branch returns early when no enemy is in combat range, which would
    // skip dispatchAttack entirely and make the accuracy roll (and these
    // assertions) pass vacuously.
    spawnEnemy(world, 1.875, 0, 50);

    // Force a deterministic miss: rng.next() returns 1.0 (> sword baseAccuracy 0.9)
    world.rng.next = () => 1.0;

    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;
    weaponSystem(world);

    // The miss path must have actually run — a 'miss' combat event proves
    // dispatchAttack reached and failed the accuracy roll.
    expect(world.combatEvents.some((e) => e.type === 'miss')).toBe(true);
    // skillUsageEvents must be empty — miss should produce no events
    expect(world.skillUsageEvents).toHaveLength(0);
    // attackerWeaponSkills is only populated after a successful accuracy check
    expect(world.attackerWeaponSkills.size).toBe(0);
  });

  it('attackerWeaponSkills is populated after a successful accuracy check', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // Spawn an enemy in melee range so weaponSystem triggers an attack
    spawnEnemy(world, 1.875, 0, 50);

    // Force a hit: rng.next() returns 0.0 (always <= any accuracy)
    world.rng.next = () => 0.0;

    setActiveWeapon(world, def);
    world.elapsedMs = def.cooldownMs;
    weaponSystem(world);

    const skills = world.attackerWeaponSkills.get(player);
    expect(skills).toBeDefined();
    expect(skills?.classSkillId).toBe(def.weaponClassSkillId);
    expect(skills?.typeSkillId).toBe(def.weaponTypeSkillId);
  });

  it('skill XP emitted when melee swing hits an enemy', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    // Register weapon skills as if a successful attack was dispatched
    world.attackerWeaponSkills.set(player, {
      classSkillId: def.weaponClassSkillId,
      typeSkillId: def.weaponTypeSkillId,
    });

    // Spawn enemy close enough for the swing to hit
    const enemy = spawnEnemy(world, 1.25, 0, 50);
    spawnMeleeSwing(
      world,
      0,
      0,
      player,
      def.baseDamage,
      def.aoeRadius,
      def.durationMs,
      1,
      0,
      def.swingArcDeg,
      TeamId.PLAYER,
    );

    meleeSwingSystem(world);

    // Two events should have been queued: one for class skill, one for type skill
    const events = world.skillUsageEvents;
    const classEvent = events.find(
      (e) => e.skillId === def.weaponClassSkillId && e.metric === 'weapon_fired',
    );
    const typeEvent = events.find(
      (e) => e.skillId === def.weaponTypeSkillId && e.metric === 'weapon_fired',
    );
    expect(classEvent).toBeDefined();
    expect(typeEvent).toBeDefined();
    expect(classEvent?.holderEid).toBe(player);
    expect(typeEvent?.holderEid).toBe(player);

    // Verify the enemy actually took damage
    expect(world.stores.health.current[enemy]).toBeLessThan(50);
  });

  it('no skill XP when melee swing misses (no enemies nearby)', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const def = WEAPON_DEFS.get('sword')!;

    world.attackerWeaponSkills.set(player, {
      classSkillId: def.weaponClassSkillId,
      typeSkillId: def.weaponTypeSkillId,
    });

    // Spawn swing with NO enemies in the world
    spawnMeleeSwing(
      world,
      0,
      0,
      player,
      def.baseDamage,
      def.aoeRadius,
      def.durationMs,
      1,
      0,
      def.swingArcDeg,
      TeamId.PLAYER,
    );

    meleeSwingSystem(world);

    // No skill events since no enemy was hit
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('attributes delayed projectile XP via production path: bow fires, weapon switches, projectile lands', () => {
    const { world, player } = setupPlayerWithWeaponSkills();
    const bowDef = WEAPON_DEFS.get('bow')!;
    const pistolDef = WEAPON_DEFS.get('pistol')!;
    const enemy = spawnEnemy(world, 50, 0, 50);

    // Fire bow through the production path (weaponSystem → dispatchAttackInner →
    // attackWeaponSkillsByEntity registration), not via manual map insertion.
    world.rng.next = () => 0; // force accuracy roll to hit
    setActiveWeapon(world, bowDef);
    world.elapsedMs = bowDef.cooldownMs;
    weaponSystem(world);

    // Verify the production path registered the projectile in the per-attack map.
    expect(world.attackWeaponSkillsByEntity.size).toBeGreaterThanOrEqual(1);
    const bowEntry = [...world.attackWeaponSkillsByEntity.entries()].find(
      ([, skills]) => skills?.classSkillId === bowDef.weaponClassSkillId,
    );
    expect(bowEntry).toBeDefined();
    const [projectileEid] = bowEntry!;

    // Switch weapon: overwrite attacker-level skills to pistol (simulates equip).
    world.attackerWeaponSkills.set(player, {
      classSkillId: pistolDef.weaponClassSkillId,
      typeSkillId: pistolDef.weaponTypeSkillId,
    });

    // Land the original bow projectile on the enemy now.
    world.stores.position.x[projectileEid] = world.stores.position.x[enemy] ?? 0;
    world.stores.position.y[projectileEid] = world.stores.position.y[enemy] ?? 0;
    world.stores.velocity.x[projectileEid] = 0;
    world.stores.velocity.y[projectileEid] = 0;
    damageSystem(world, collisionSystem(world));

    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired.length).toBeGreaterThanOrEqual(2);
    // bow type skill must be present; pistol type skill must not
    expect(fired.map((e) => e.skillId)).toContain(bowDef.weaponTypeSkillId);
    expect(fired.map((e) => e.skillId)).not.toContain(pistolDef.weaponTypeSkillId);
  });
});
