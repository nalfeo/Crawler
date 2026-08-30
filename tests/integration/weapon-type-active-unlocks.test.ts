import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  Enemy,
  Health,
  Position,
  Size,
  SkillHolder,
  Velocity,
  Weight,
  createGameWorld,
  spawnPlayer,
  type GameWorld,
} from '../../src/core/index.js';
import { SHAPE_CIRCLE } from '../../src/core/physics-defs.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario, selectFloor1StarterWeapon } from '../../src/game/index.js';
import { getSkillDefinition } from '../../src/game/skills/registry.js';
import type { SkillState } from '../../src/game/skills/types.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { WEAPON_TYPE_SKILL_IDS } from '../../src/shared/weapon-skills.js';
import { WEAPON_DEFS } from '../../src/shared/weaponDefs.js';

function createPlayingFloor1World(seed: number): { world: GameWorld; playerEid: number } {
  const world = createGameWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, playerEid);
  selectFloor1StarterWeapon(world, 0);
  addComponent(world.ecs, playerEid, SkillHolder);
  return { world, playerEid };
}

function spawnTrainingDummy(world: GameWorld, playerEid: number, offsetFt: number): number {
  const eid = addEntity(world.ecs);
  addComponent(
    world.ecs,
    eid,
    set(Position, {
      x: (world.stores.position.x[playerEid] ?? 0) + offsetFt,
      y: world.stores.position.y[playerEid] ?? 0,
    }),
  );
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 5_000, max: 5_000 }));
  addComponent(world.ecs, eid, set(Weight, { value: 120 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, { radius: 1.5, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
  );
  addComponent(world.ecs, eid, Enemy);
  return eid;
}

describe('weapon-type skill active milestones in the shipped simulation pipeline', () => {
  it('grants and fires every level-5 active with its matching weapon', () => {
    const options = createFloor1MainSceneOptions();

    for (const [index, skillId] of WEAPON_TYPE_SKILL_IDS.entries()) {
      const { world, playerEid } = createPlayingFloor1World(100 + index);
      const skill = getSkillDefinition(skillId)!;
      const state: SkillState = {
        level: 0,
        usage: 0,
        itemBonus: 0,
        triggeredMilestones: new Set(),
      };
      world.playerSkills.set(skillId, state);
      const holderSkills =
        world.skillStatesByEntity.get(playerEid) ?? new Map<string, SkillState>();
      holderSkills.set(skillId, state);
      world.skillStatesByEntity.set(playerEid, holderSkills);

      const matchingWeapon = [...WEAPON_DEFS.values()].find(
        (weapon) => weapon.weaponTypeSkillId === skillId,
      );
      expect(matchingWeapon, `missing weapon for ${skillId}`).toBeDefined();
      setActiveWeapon(world, matchingWeapon!);
      spawnTrainingDummy(world, playerEid, 2);
      spawnTrainingDummy(world, playerEid, -2);

      world.skillUsageEvents.push({
        holderEid: playerEid,
        skillId,
        metric: skill.usageMetric,
        amount: skill.usageThresholds[4]!,
      });
      skillSystem(world);

      const abilityId = skill.milestones.find((milestone) => milestone.level === 5)?.abilityId;
      expect(abilityId).toBeDefined();
      expect(world.abilityStatesByEntity.get(playerEid)?.equippedActiveAbilityIds).toContain(
        abilityId,
      );

      const input = createInputState();
      for (let frame = 0; frame < 5; frame += 1) {
        world.frameCount += 1;
        world.elapsedMs += GAME.DELTA_MS;
        runSimulationStep(world, input, {
          preSystems: options.preSystems,
          postSystems: options.postSystems,
        });
      }

      expect(
        world.abilityStatesByEntity.get(playerEid)?.cooldownByAbilityId.has(abilityId!),
        `${skillId} L5 active should fire through runSimulationStep`,
      ).toBe(true);
      expect(world.combatEvents.some((event) => event.fromActiveAbility)).toBe(true);
    }
  });
});
