import { addComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { SkillHolder, Stats } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { ACTIVE_ABILITY_SLOT_LIMIT } from '../../src/game/abilities/types.js';
import {
  abilitySystem,
  equipActiveAbility,
  getOrCreateAbilityState,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
  statsSystem,
} from '../../src/game/systems/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function makeWalledMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 10,
    heightTiles: 10,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(10, 10);
  const terrain = new Uint8Array(100);

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const idx = y * 10 + x;
      tileMap.flags[idx] =
        x === 0 || x === 9 || y === 0 || y === 9 || x === 5 ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 3 });
}

function setupPlayer() {
  const world = createTestWorld();
  const player = spawnPlayer(world, 0, 0);
  addComponent(world.ecs, player, Stats);
  addComponent(world.ecs, player, SkillHolder);
  statsSystem(world);
  getOrCreateAbilityState(world, player);
  return { world, player };
}

describe('abilitySystem', () => {
  it('enforces max 10 active abilities equipped', () => {
    const { world, player } = setupPlayer();
    const state = world.abilityStatesByEntity.get(player)!;
    // Pre-fill slots directly to verify cap enforcement independently of catalog size.
    state.equippedActiveAbilityIds = Array.from({ length: ACTIVE_ABILITY_SLOT_LIMIT }, (_, i) =>
      i < ACTIVE_ABILITY_SLOT_LIMIT - 1 ? `ability-${i}` : 'battle-focus',
    );

    expect(() => equipActiveAbility(world, player, 'fireball')).toThrow(/slot cap/i);
  });

  it('allows unlimited passive grants and applies them once through stat modifiers', () => {
    const { world, player } = setupPlayer();
    const state = world.abilityStatesByEntity.get(player)!;

    for (let i = 0; i < 12; i++) {
      state.passiveAbilityIds.push(`custom-passive-${i}`);
    }

    grantPassiveAbility(world, player, 'veteran-instinct');
    abilitySystem(world);

    const applied = world.statModifiers.filter((m) =>
      m.sourceId.startsWith('veteran-instinct:passive'),
    );
    expect(applied).toHaveLength(2);

    const before = world.statModifiers.length;
    abilitySystem(world);
    expect(world.statModifiers).toHaveLength(before);
  });

  it('memorized spells are active abilities', () => {
    const { world, player } = setupPlayer();
    memorizeSpell(world, player, 'fireball');

    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.equippedActiveAbilityIds).toContain('fireball');
  });

  it('triggers active ability when conditions match and enforces cooldown', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');
    const state = world.abilityStatesByEntity.get(player)!;

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    world.frameCount = 100;
    const beforeFirst = world.statModifiers.length;
    abilitySystem(world);
    const afterFirst = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeFirst + 1);
    expect(afterFirst).toHaveLength(1);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 101;
    const beforeSecond = world.statModifiers.length;
    abilitySystem(world);
    const afterSecond = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeSecond);
    expect(afterSecond).toHaveLength(1);
    expect(state.cooldownByAbilityId.get('battle-focus')).toBe(100);

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });
    world.frameCount = 131;
    const beforeThird = world.statModifiers.length;
    abilitySystem(world);
    const afterThird = world.statModifiers.filter(
      (m) => m.sourceId === `battle-focus:active:${player}`,
    );
    expect(world.statModifiers.length).toBe(beforeThird);
    expect(afterThird).toHaveLength(1);
    // Verify the trigger actually fired after cooldown by checking the cooldown timestamp updated
    expect(state.cooldownByAbilityId.get('battle-focus')).toBe(131);
    // Confirm cooldown advanced from the previous value (100 → 131)
    expect(state.cooldownByAbilityId.get('battle-focus')).toBeGreaterThan(100);
  });

  it('clears ability trigger events after processing', () => {
    const { world, player } = setupPlayer();
    equipActiveAbility(world, player, 'battle-focus');

    queueAbilityTrigger(world, {
      holderEid: player,
      kind: 'skill_usage',
      metric: 'hits_landed',
      amount: 10,
      skillId: 'swordsmanship',
    });

    abilitySystem(world);
    expect(world.abilityTriggerEvents).toHaveLength(0);
  });

  it('auto-casts fireball on enemy clumps, spends MP, and honors 5s cooldown', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    world.playerMp = 20;
    memorizeSpell(world, player, 'fireball');

    // Place enemies within 48px (6 feet) trigger radius and give them enough health to survive 2 spells
    spawnEnemy(world, 8, 0, 100);
    spawnEnemy(world, 12, 4, 100);
    spawnEnemy(world, 14, -4, 100);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);
    expect(world.playerMp).toBe(15);

    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(100);
    expect(world.playerMp).toBe(15);

    world.frameCount = 400;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('fireball')).toBe(400);
    expect(world.playerMp).toBe(10);
  });

  it('casts pulse shield only when low health and crowded, then spends 10 MP', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    world.playerMp = 20;
    memorizeSpell(world, player, 'pulse-shield');
    world.stores.health.current[player] = 40;
    world.stores.health.max[player] = 100;

    spawnEnemy(world, 12, 0, 10);
    spawnEnemy(world, -10, 6, 10);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.has('pulse-shield')).toBe(false);
    expect(world.playerMp).toBe(20);

    spawnEnemy(world, 6, -8, 10);
    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('pulse-shield')).toBe(200);
    expect(world.playerMp).toBe(10);

    world.stores.health.current[player] = 85;
    world.frameCount = 1600;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('pulse-shield')).toBe(200);
    expect(world.playerMp).toBe(10);
  });

  it('keeps pulse shield knockback from pushing enemies partially into walls', () => {
    const { world, player } = setupPlayer();
    world.floorMap = makeWalledMap();
    world.stores.position.x[player] = 120;
    world.stores.position.y[player] = 96;
    world.featureUnlocks.spells = true;
    world.playerMp = 20;
    memorizeSpell(world, player, 'pulse-shield');
    world.stores.health.current[player] = 40;
    world.stores.health.max[player] = 100;

    spawnEnemy(world, 88, 96, 10);
    spawnEnemy(world, 100, 96, 10);
    const wallEnemy = spawnEnemy(world, 144, 96, 10);
    world.stores.sprite.width[wallEnemy] = 30;
    world.stores.sprite.height[wallEnemy] = 30;

    world.frameCount = 100;
    abilitySystem(world);
    knockbackSystem(world);

    expect(world.playerMp).toBe(10);
    expect(world.stores.position.x[wallEnemy]).toBeCloseTo(145);
    expect(world.stores.position.y[wallEnemy]).toBeCloseTo(96);
  });

  it('does not trigger spells when MP is below cost', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    world.playerMp = 4;
    memorizeSpell(world, player, 'fireball');

    spawnEnemy(world, 20, 0, 10);
    spawnEnemy(world, 24, 4, 10);

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.has('fireball')).toBe(false);
    expect(world.playerMp).toBe(4);
  });

  it('casts heal only when HP deficit reaches heal amount, with 30s cooldown and 10 MP cost', () => {
    const { world, player } = setupPlayer();
    world.featureUnlocks.spells = true;
    world.playerMp = 30;
    memorizeSpell(world, player, 'heal');
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 75; // deficit 25 (< 30)

    world.frameCount = 100;
    abilitySystem(world);
    const state = world.abilityStatesByEntity.get(player)!;
    expect(state.cooldownByAbilityId.has('heal')).toBe(false);
    expect(world.playerMp).toBe(30);

    world.stores.health.current[player] = 70; // deficit 30
    world.frameCount = 200;
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(200);
    expect(world.playerMp).toBe(20);

    world.stores.health.current[player] = 40;
    world.frameCount = 1000; // still inside 1800-frame cooldown
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(200);
    expect(world.playerMp).toBe(20);

    world.frameCount = 2001; // cooldown elapsed
    abilitySystem(world);
    expect(state.cooldownByAbilityId.get('heal')).toBe(2001);
    expect(world.playerMp).toBe(10);
  });
});
