/**
 * Arcane level-5 ACTIVE unlock — visual-pipeline integration guard (issue #3676).
 *
 * The Arcane weapon-class skill used to reward a flat +10% damage PASSIVE at
 * level 5, which is not what the milestone is supposed to be: the arcane class
 * unlock is an ACTIVE ability. This test drives the SHIPPED VISUAL PIPELINE via
 * `createFloor1MainSceneOptions()` + the engine `runSimulationStep`, so it is a
 * real-artifact observation (rule #9), not a lab.
 *
 * It pins the three properties the fix is actually about:
 *   1. Reaching arcane level 5 equips an ACTIVE on the ability bar (not a
 *      passive), and announces it as an ability unlock.
 *   2. The active really fires in the shipped pipeline while an arcane weapon
 *      is equipped — before the spellbook feature unlock exists.
 *   3. The weapon-class contract survives: it refuses to fire when a
 *      non-arcane weapon is equipped.
 */
import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Enemy,
  Health,
  Position,
  SkillHolder,
  Velocity,
  Weight,
  createGameWorld,
  spawnPlayer,
  type GameWorld,
} from '../../src/core/index.js';
import { initializeFloor1Scenario, selectFloor1StarterWeapon } from '../../src/game/index.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { skillSystem } from '../../src/game/systems/skillSystem.js';
import { grantAbilitySources } from '../../src/game/systems/abilitySystem.js';
import { runSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { learnedAbilityGrantSourceId } from '../../src/shared/abilities.js';
import type { SkillState } from '../../src/game/skills/types.js';

/** Usage large enough to cross every arcane class threshold up to level 5. */
const ARCANE_L5_USAGE = 600;

function createPlayingFloor1World(seed: number): { world: GameWorld; playerEid: number } {
  const world = createGameWorld({ seed });
  const playerEid = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, playerEid);
  selectFloor1StarterWeapon(world, 0);
  addComponent(world.ecs, playerEid, SkillHolder);
  // Register the arcane skill on the holder WITHOUT clobbering any skills the
  // scenario already installed on this entity.
  const state: SkillState = { level: 0, usage: 0, itemBonus: 0, triggeredMilestones: new Set() };
  world.playerSkills.set('arcane', state);
  const holderSkills = world.skillStatesByEntity.get(playerEid) ?? new Map<string, SkillState>();
  holderSkills.set('arcane', state);
  world.skillStatesByEntity.set(playerEid, holderSkills);
  return { world, playerEid };
}

/** Level the arcane skill to its L5 milestone through the real skill system. */
function levelArcaneToFive(world: GameWorld, playerEid: number): void {
  world.skillUsageEvents.push({
    holderEid: playerEid,
    skillId: 'arcane',
    metric: 'weapon_fired',
    amount: ARCANE_L5_USAGE,
  });
  skillSystem(world);
  expect(world.playerSkills.get('arcane')!.level).toBeGreaterThanOrEqual(5);
}

/** Plant a stationary, high-HP training dummy `offsetFt` feet along +x. */
function spawnStationaryEnemyNearPlayer(
  world: GameWorld,
  playerEid: number,
  offsetFt: number,
): number {
  const px = world.stores.position.x[playerEid] ?? 0;
  const py = world.stores.position.y[playerEid] ?? 0;
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: px + offsetFt, y: py }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 5000, max: 5000 }));
  addComponent(world.ecs, eid, set(Weight, { value: 120 }));
  addComponent(world.ecs, eid, Enemy);
  return eid;
}

function stepVisualPipeline(
  world: GameWorld,
  options: ReturnType<typeof createFloor1MainSceneOptions>,
  frames: number,
): void {
  const input = createInputState();
  for (let i = 0; i < frames; i += 1) {
    world.frameCount += 1;
    world.elapsedMs += GAME.DELTA_MS;
    runSimulationStep(world, input, {
      preSystems: options.preSystems,
      postSystems: options.postSystems,
    });
  }
}

describe('Arcane level-5 milestone unlocks an ACTIVE ability', () => {
  it('equips an active on the ability bar and announces an ability unlock', () => {
    const { world, playerEid } = createPlayingFloor1World(21);
    levelArcaneToFive(world, playerEid);

    const state = world.abilityStatesByEntity.get(playerEid);
    expect(state).toBeDefined();
    // The regression this test exists for: the reward landed in the PASSIVE
    // list instead of on the ability bar.
    expect(state!.passiveAbilityIds).not.toContain('arcane-nova');
    expect(state!.equippedActiveAbilityIds).toContain('arcane-nova');
    expect(state!.grantOwnership!.activeSourcesByAbilityId.get('arcane-nova')).toEqual(
      new Set(['skill:arcane:5']),
    );

    const unlockBanners = world.announcements.filter((a) => a.kind === 'skillAbilityUnlocked');
    expect(unlockBanners).toHaveLength(1);
    expect(unlockBanners[0]!.text).toBe('Ability Unlocked: Arcane Nova');
  });

  it('fires in the shipped pipeline with an arcane weapon, before the spellbook unlock', () => {
    const { world, playerEid } = createPlayingFloor1World(21);
    const options = createFloor1MainSceneOptions();
    setActiveWeapon(world, getWeaponDef('fireball')!);
    levelArcaneToFive(world, playerEid);

    // `kind: 'active'` (not `'spell'`) is load-bearing: on Floor 1 the spell
    // feature unlock only opens after the first boss.
    expect(world.featureUnlocks.spells).toBe(false);

    spawnStationaryEnemyNearPlayer(world, playerEid, 3);
    spawnStationaryEnemyNearPlayer(world, playerEid, -3);
    stepVisualPipeline(world, options, 5);

    const state = world.abilityStatesByEntity.get(playerEid);
    expect(state!.cooldownByAbilityId.get('arcane-nova')).toBeGreaterThan(0);
  });

  it('refuses to fire while a non-arcane weapon is equipped', () => {
    const { world, playerEid } = createPlayingFloor1World(21);
    const options = createFloor1MainSceneOptions();
    setActiveWeapon(world, getWeaponDef('sword')!);
    levelArcaneToFive(world, playerEid);

    spawnStationaryEnemyNearPlayer(world, playerEid, 3);
    spawnStationaryEnemyNearPlayer(world, playerEid, -3);
    stepVisualPipeline(world, options, 5);

    const state = world.abilityStatesByEntity.get(playerEid);
    // Still owned and equipped — just inert until an arcane weapon is back.
    expect(state!.equippedActiveAbilityIds).toContain('arcane-nova');
    // A suppressed attempt must not consume the cooldown either.
    expect(state!.cooldownByAbilityId.has('arcane-nova')).toBe(false);
  });

  it('upgrades the active in place at level 15 without stranding the level-5 grant', () => {
    const { world, playerEid } = createPlayingFloor1World(21);
    levelArcaneToFive(world, playerEid);
    const state = world.abilityStatesByEntity.get(playerEid)!;
    grantAbilitySources(
      world,
      playerEid,
      [
        { kind: 'active', abilityId: 'heal', sourceId: learnedAbilityGrantSourceId('heal') },
        { kind: 'active', abilityId: 'haste', sourceId: learnedAbilityGrantSourceId('haste') },
      ],
      { configureActives: 'fill-open-slots' },
    );
    const replacedSlotIndex = state.equippedActiveAbilityIds.indexOf('arcane-nova');

    world.skillUsageEvents.push({
      holderEid: playerEid,
      skillId: 'arcane',
      metric: 'weapon_fired',
      amount: 5_000,
    });
    skillSystem(world);

    const upgradedState = world.abilityStatesByEntity.get(playerEid);
    expect(world.playerSkills.get('arcane')!.level).toBe(15);
    expect(upgradedState!.equippedActiveAbilityIds).toContain('arcane-nova-evolved');
    // The L5 grant is revoked as an ACTIVE (a passive-kind revoke would be
    // rejected by the grant-ownership validator and leak the old ability).
    expect(upgradedState!.equippedActiveAbilityIds).not.toContain('arcane-nova');
    expect(upgradedState!.grantOwnership!.activeSourcesByAbilityId.has('arcane-nova')).toBe(false);
    expect(upgradedState!.equippedActiveAbilityIds.indexOf('arcane-nova-evolved')).toBe(
      replacedSlotIndex,
    );
  });

  it('keeps the arcane active owned but unequipped when the active bar is full', () => {
    const { world, playerEid } = createPlayingFloor1World(21);
    const fullBar = [
      'fireball',
      'heal',
      'pulse-shield',
      'magic-missile',
      'frost-nova',
      'bless',
      'stoneskin',
      'curse',
      'vampiric-touch',
      'haste',
    ];
    grantAbilitySources(
      world,
      playerEid,
      fullBar.map((abilityId) => ({
        kind: 'active',
        abilityId,
        sourceId: learnedAbilityGrantSourceId(abilityId),
      })),
      { configureActives: 'fill-open-slots' },
    );

    levelArcaneToFive(world, playerEid);

    const state = world.abilityStatesByEntity.get(playerEid);
    expect(state!.equippedActiveAbilityIds).toEqual(fullBar);
    expect(state!.ownedActiveAbilityIds).toContain('arcane-nova');
    expect(state!.grantOwnership!.activeSourcesByAbilityId.get('arcane-nova')).toEqual(
      new Set(['skill:arcane:5']),
    );
  });
});
