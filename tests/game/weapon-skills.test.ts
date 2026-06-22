import { describe, it, expect, beforeEach } from 'vitest';
import { addComponent } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { Stats, SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { skillSystem, statsSystem } from '../../src/game/systems/index.js';
import { computeAccuracy, applyAccuracySpread } from '../../src/game/systems/accuracySystem.js';
import {
  getAllSkillDefinitions,
  getWeaponClassSkills,
  getWeaponTypeSkills,
} from '../../src/game/skills/registry.js';
import { WEAPON_CLASS_SKILL_IDS, WEAPON_TYPE_SKILL_IDS } from '../../src/shared/weapon-skills.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import type { SkillState } from '../../src/shared/skills.js';
import { SKILL_HARD_CAP } from '../../src/shared/skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initPlayerSkills(world: GameWorld, playerEid: number): Map<string, SkillState> {
  const skillStateById = new Map<string, SkillState>();
  for (const skill of getAllSkillDefinitions()) {
    const state: SkillState = {
      level: 0,
      usage: 0,
      itemBonus: 0,
      triggeredMilestones: new Set(),
    };
    world.playerSkills.set(skill.id, state);
    skillStateById.set(skill.id, state);
  }
  world.skillStatesByEntity.set(playerEid, skillStateById);
  return skillStateById;
}

// ---------------------------------------------------------------------------
// Skill taxonomy
// ---------------------------------------------------------------------------

describe('weapon skill taxonomy', () => {
  it('all WEAPON_CLASS_SKILL_IDS have a matching skill definition', () => {
    const classSkills = new Set(getWeaponClassSkills().map((s) => s.id));
    for (const id of WEAPON_CLASS_SKILL_IDS) {
      expect(classSkills.has(id), `Missing class skill definition for '${id}'`).toBe(true);
    }
  });

  it('all WEAPON_TYPE_SKILL_IDS have a matching skill definition', () => {
    const typeSkills = new Set(getWeaponTypeSkills().map((s) => s.id));
    for (const id of WEAPON_TYPE_SKILL_IDS) {
      expect(typeSkills.has(id), `Missing type skill definition for '${id}'`).toBe(true);
    }
  });

  it('weapon_class skills level up more slowly than weapon_type skills', () => {
    // The balance requirement: type skill level 4 by end of floor 1 (~150 uses);
    // class skill level 2 by end of floor 1 (~150 uses).
    // Verify type skill threshold[3] (level 4) <= 150 uses.
    // Verify class skill threshold[1] (level 2) >= type threshold[3].
    for (const classDef of getWeaponClassSkills()) {
      const classThresholdLevel2 = classDef.usageThresholds[1]!;
      for (const typeDef of getWeaponTypeSkills()) {
        const typeThresholdLevel4 = typeDef.usageThresholds[3]!;
        expect(classThresholdLevel2).toBeGreaterThanOrEqual(typeThresholdLevel4);
      }
    }
  });

  it('type skill reaches level 4 by ~150 uses (end-of-floor-1 target)', () => {
    for (const typeDef of getWeaponTypeSkills()) {
      expect(typeDef.usageThresholds[3]).toBeLessThanOrEqual(150);
    }
  });

  it('class skill reaches level 2 by ~150 uses (end-of-floor-1 target)', () => {
    for (const classDef of getWeaponClassSkills()) {
      expect(classDef.usageThresholds[1]).toBeLessThanOrEqual(150);
    }
  });

  it('all weapon_class skills have damage perLevelBonus', () => {
    for (const skill of getWeaponClassSkills()) {
      expect(skill.perLevelBonus.damage).toBeDefined();
      expect(skill.perLevelBonus.damage).toBeGreaterThan(0);
    }
  });

  it('all weapon_type skills have attackSpeed perLevelBonus', () => {
    for (const skill of getWeaponTypeSkills()) {
      expect(skill.perLevelBonus.attackSpeed).toBeDefined();
      expect(skill.perLevelBonus.attackSpeed).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// WeaponDef skill tags
// ---------------------------------------------------------------------------

describe('weapon def skill tags', () => {
  it('sword has slashing class and sword type skills', () => {
    const def = getWeaponDef('sword');
    expect(def?.classSkillId).toBe('slashing');
    expect(def?.typeSkillId).toBe('sword');
  });

  it('knife has stabbing class and dagger type skills', () => {
    const def = getWeaponDef('knife');
    expect(def?.classSkillId).toBe('stabbing');
    expect(def?.typeSkillId).toBe('dagger');
  });

  it('baseball-bat has smashing class and sports-equipment type skills', () => {
    const def = getWeaponDef('baseball-bat');
    expect(def?.classSkillId).toBe('smashing');
    expect(def?.typeSkillId).toBe('sports-equipment');
  });

  it('pistol has ranged class and pistol type skills', () => {
    const def = getWeaponDef('pistol');
    expect(def?.classSkillId).toBe('ranged');
    expect(def?.typeSkillId).toBe('pistol');
  });

  it('landmine has no skill tags (trap, not an active skill)', () => {
    const def = getWeaponDef('landmine');
    expect(def?.classSkillId).toBeNull();
    expect(def?.typeSkillId).toBeNull();
  });

  it('all weapons have baseAccuracy between 0 and 1', () => {
    const weaponIds = [
      'sword',
      'knife',
      'hammer',
      'baseball-bat',
      'pistol',
      'bow',
      'crossbow',
      'punch',
      'kick',
      'fireball',
      'boomerang',
      'throwing-knife',
      'bowling-ball',
      'laser',
      'landmine',
    ];
    for (const id of weaponIds) {
      const def = getWeaponDef(id);
      expect(def?.baseAccuracy, `${id}.baseAccuracy`).toBeGreaterThanOrEqual(0);
      expect(def?.baseAccuracy, `${id}.baseAccuracy`).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Accuracy system
// ---------------------------------------------------------------------------

describe('accuracy system', () => {
  let world: GameWorld;
  let player: number;

  beforeEach(() => {
    world = createTestWorld();
    player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, Stats);
    addComponent(world.ecs, player, SkillHolder);
    statsSystem(world);
    initPlayerSkills(world, player);
  });

  it('returns baseAccuracy when dex=0 and skill level=0', () => {
    const def = getWeaponDef('sword')!;
    const acc = computeAccuracy(world, player, def);
    // At level 0 type skill, dex 0: should equal baseAccuracy
    expect(acc).toBeCloseTo(def.baseAccuracy, 4);
  });

  it('accuracy is clamped to [0, 1]', () => {
    const def = getWeaponDef('laser')!; // baseAccuracy=1.0
    const acc = computeAccuracy(world, player, def);
    expect(acc).toBeLessThanOrEqual(1.0);
    expect(acc).toBeGreaterThanOrEqual(0.0);
  });

  it('increases as type skill level increases', () => {
    const def = getWeaponDef('sword')!;
    const acc0 = computeAccuracy(world, player, def);

    // Level up the sword type skill
    const state = world.skillStatesByEntity.get(player)?.get('sword');
    if (state) state.level = 4;

    const acc4 = computeAccuracy(world, player, def);
    expect(acc4).toBeGreaterThan(acc0);
  });

  it('applyAccuracySpread returns exact direction when accuracy=1', () => {
    const dir = { x: 1, y: 0 };
    const result = applyAccuracySpread(dir, 1.0, world);
    expect(result.x).toBeCloseTo(1, 5);
    expect(result.y).toBeCloseTo(0, 5);
  });

  it('applyAccuracySpread changes direction when accuracy < 1', () => {
    // Run many times; at accuracy=0 (max spread) at least one should differ
    const dir = { x: 1, y: 0 };
    let anyDiffers = false;
    for (let i = 0; i < 20; i++) {
      const result = applyAccuracySpread(dir, 0.5, world);
      if (Math.abs(result.x - 1) > 0.001 || Math.abs(result.y) > 0.001) {
        anyDiffers = true;
        break;
      }
    }
    expect(anyDiffers).toBe(true);
  });

  it('applyAccuracySpread result is a unit vector', () => {
    const dir = { x: 1, y: 0 };
    const result = applyAccuracySpread(dir, 0.5, world);
    const len = Math.hypot(result.x, result.y);
    expect(len).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Skill event emission from weapon use
// ---------------------------------------------------------------------------

describe('weapon skill progression via skillSystem', () => {
  let world: GameWorld;
  let player: number;

  beforeEach(() => {
    world = createTestWorld();
    player = spawnPlayer(world, 0, 0);
    addComponent(world.ecs, player, Stats);
    addComponent(world.ecs, player, SkillHolder);
    statsSystem(world);
    initPlayerSkills(world, player);
  });

  it('emitting hits_landed events for sword levels up sword type skill', () => {
    // Level 1 at 10 hits
    for (let i = 0; i < 10; i++) {
      world.skillUsageEvents.push({
        holderEid: player,
        skillId: 'sword',
        metric: 'hits_landed',
        amount: 1,
      });
    }
    world.frameCount++;
    skillSystem(world);

    const state = world.skillStatesByEntity.get(player)?.get('sword');
    expect(state?.level).toBeGreaterThanOrEqual(1);
  });

  it('emitting hits_landed events for slashing levels up slashing class skill', () => {
    // Class skill level 1 at 40 hits
    for (let i = 0; i < 40; i++) {
      world.skillUsageEvents.push({
        holderEid: player,
        skillId: 'slashing',
        metric: 'hits_landed',
        amount: 1,
      });
    }
    world.frameCount++;
    skillSystem(world);

    const state = world.skillStatesByEntity.get(player)?.get('slashing');
    expect(state?.level).toBeGreaterThanOrEqual(1);
  });

  it('type skill reaches level 4 after 150 uses', () => {
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'sword',
      metric: 'hits_landed',
      amount: 150,
    });
    world.frameCount++;
    skillSystem(world);

    const state = world.skillStatesByEntity.get(player)?.get('sword');
    expect(state?.level).toBeGreaterThanOrEqual(4);
  });

  it('class skill reaches level 2 after 150 uses', () => {
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'slashing',
      metric: 'hits_landed',
      amount: 150,
    });
    world.frameCount++;
    skillSystem(world);

    const state = world.skillStatesByEntity.get(player)?.get('slashing');
    expect(state?.level).toBeGreaterThanOrEqual(2);
  });

  it('skill level cannot exceed SKILL_HARD_CAP', () => {
    world.skillUsageEvents.push({
      holderEid: player,
      skillId: 'sword',
      metric: 'hits_landed',
      amount: 999_999,
    });
    world.frameCount++;
    skillSystem(world);

    const state = world.skillStatesByEntity.get(player)?.get('sword');
    expect(state?.level).toBeLessThanOrEqual(SKILL_HARD_CAP);
  });
});
