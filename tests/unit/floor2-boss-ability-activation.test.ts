import { describe, expect, it } from 'vitest';
import { hasComponent } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { Invincible } from '../../src/core/components.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType } from '../../src/shared/map-types.js';
import { FLOOR2_BOSS_ABILITY_CATALOG } from '../../src/shared/boss-abilities.js';
import { GAME } from '../../src/shared/constants.js';
import { createFloor2BossAbilityDefinition } from '../../src/core/mob-abilities/floor2-roster.js';
import {
  mobAbilitySystem,
  registerMobAbilityOwnedZone,
} from '../../src/core/mob-abilities/runtime.js';
import {
  initializeFloor2Bosses,
  floor2ObjectiveTick,
  denUnlockGoalId,
} from '../../src/game/floor2Scenario.js';

function setup() {
  const world = createTestWorld({ floor: 2, seed: 1234 });
  world.floorMap = new CaveSystemGenerator({ presentCount: 4 }).generate(
    {
      widthTiles: 80,
      heightTiles: 60,
      tileSizeFt: 4,
      biome: BiomeType.CAVE_SYSTEM,
      seed: 1234,
      roomWidthRange: [5, 12],
      roomHeightRange: [5, 12],
      maxRooms: 20,
      floorDensity: 0.45,
    },
    new SeededRandom(1234),
  );
  world.floorExtendedState = {
    familyState: {
      presentFamilies: ['goblins', 'geese', 'raccoons', 'imps'].map(asFamilyId),
      contestedResource: asResourceId('iron'),
      betrayerFlag: false,
    },
  };
  initializeFloor2Bosses(world, world.floorMap, world.floorExtendedState.familyState!);
  const player = spawnPlayer(world, 0, 0);
  const encounters = [...world.floorExtendedState.familyState!.bossEncounters!.values()];
  return { world, player, encounters };
}

describe('Floor 2 production ability activation', () => {
  it('binds exactly the approved eighteen catalog entries with matching identities', () => {
    expect(FLOOR2_BOSS_ABILITY_CATALOG.entries).toHaveLength(18);
    for (const entry of FLOOR2_BOSS_ABILITY_CATALOG.entries) {
      const definition = createFloor2BossAbilityDefinition(entry.familyId);
      expect(definition.abilityId).toBe(entry.id);
      expect(definition.bossArchetypeKey).toBe(entry.bossArchetypeId);
      expect(definition.firstEligibleAfterMs).toBe(entry.timing.firstEligibleAfterMs);
      expect(definition.telegraphDurationMs).toBe(entry.telegraph.durationMs);
    }
    expect(() => createFloor2BossAbilityDefinition('unknown')).toThrow();
  });
  it('keeps dormant bosses unregistered and starts each clock only when its unlocked den is entered', () => {
    const { world, player, encounters } = setup();
    expect(encounters).toHaveLength(4);
    expect(world.mobAbilities.byEntity.size).toBe(0);
    const first = encounters[0]!;
    world.stores.position.x[player] = first.bossSpawnX!;
    world.stores.position.y[player] = first.bossSpawnY!;
    floor2ObjectiveTick(world);
    expect(first.started).toBe(false);
    expect(world.mobAbilities.byEntity.size).toBe(0);
    world.goalFlags.set(denUnlockGoalId(first.familyId), true);
    floor2ObjectiveTick(world);
    expect(first.started).toBe(true);
    expect(hasComponent(world.ecs, first.bossEid!, Invincible)).toBe(false);
    expect(world.mobAbilities.byEntity.size).toBe(1);
    expect(world.mobAbilities.encounterActive).toBe(true);
    expect(world.mobAbilities.enabled).toBe(true);
    const instance = world.mobAbilities.byEntity.get(first.bossEid!)!;
    mobAbilitySystem(world);
    expect(instance.timerMs).toBeCloseTo(instance.definition.firstEligibleAfterMs - GAME.DELTA_MS);
    const timer = instance.timerMs;
    registerMobAbilityOwnedZone(world, {
      abilityId: instance.definition.abilityId,
      casterEid: first.bossEid!,
      sourceId: 'test-active-zone',
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 1 },
      durationMs: 5000,
      tickIntervalMs: 500,
      tick: () => {},
    });
    const second = encounters[1]!;
    world.stores.position.x[player] = second.bossSpawnX!;
    world.stores.position.y[player] = second.bossSpawnY!;
    world.goalFlags.set(denUnlockGoalId(second.familyId), true);
    floor2ObjectiveTick(world);
    expect(second.started).toBe(true);
    expect(instance.timerMs).toBe(timer);
    expect(world.mobAbilities.ownedZones).toHaveLength(1);
    expect(world.mobAbilities.byEntity.size).toBe(2);
    expect(world.mobAbilities.byEntity.has(encounters[2]!.bossEid!)).toBe(false);
    expect(world.mobAbilities.byEntity.has(encounters[3]!.bossEid!)).toBe(false);
  });
  it('cleans only the defeated caster without disabling another encounter', () => {
    const { world, player, encounters } = setup();
    for (const encounter of encounters.slice(0, 2)) {
      world.stores.position.x[player] = encounter.bossSpawnX!;
      world.stores.position.y[player] = encounter.bossSpawnY!;
      world.goalFlags.set(denUnlockGoalId(encounter.familyId), true);
      floor2ObjectiveTick(world);
    }
    const first = encounters[0]!,
      second = encounters[1]!;
    const firstBoss = first.bossEid!;
    world.stores.health.current[firstBoss] = 0;
    world.combatEvents.push({
      type: 'death',
      targetEid: firstBoss,
      x: first.bossSpawnX!,
      y: first.bossSpawnY!,
      amount: 0,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      isBoss: 1,
      familyIndex: 0,
    });
    floor2ObjectiveTick(world);
    expect(first.defeated).toBe(true);
    expect(world.mobAbilities.byEntity.has(firstBoss)).toBe(false);
    expect(world.mobAbilities.byEntity.has(second.bossEid!)).toBe(true);
    expect(world.mobAbilities.encounterActive).toBe(true);
  });
});
