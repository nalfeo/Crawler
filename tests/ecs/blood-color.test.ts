/**
 * BloodColor component + death-event blood colour propagation tests.
 */
import { hasComponent, query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BloodColor, Enemy, Health, Spawner } from '../../src/core/components.js';
import {
  spawnEnemy,
  spawnBehaviorEnemy,
  setBloodColor,
  spawnPlayer,
  DEFAULT_BLOOD_COLOR,
} from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { AI_TYPE } from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

const GREEN_SLIME = 0x22aa44;

describe('BloodColor component', () => {
  it('spawnEnemy sets default red blood color', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);

    expect(hasComponent(world.ecs, eid, BloodColor)).toBe(true);
    expect(world.stores.bloodColor.r[eid]).toBe(0xcc);
    expect(world.stores.bloodColor.g[eid]).toBe(0x00);
    expect(world.stores.bloodColor.b[eid]).toBe(0x00);
  });

  it('spawnEnemy accepts a custom blood color', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10, 120, GREEN_SLIME);

    expect(world.stores.bloodColor.r[eid]).toBe(0x22);
    expect(world.stores.bloodColor.g[eid]).toBe(0xaa);
    expect(world.stores.bloodColor.b[eid]).toBe(0x44);
  });

  it('spawnBehaviorEnemy sets default red blood color', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 10, AI_TYPE.CHASE, 1, 200, 0);

    expect(hasComponent(world.ecs, eid, BloodColor)).toBe(true);
    expect(world.stores.bloodColor.r[eid]).toBe(0xcc);
    expect(world.stores.bloodColor.g[eid]).toBe(0x00);
    expect(world.stores.bloodColor.b[eid]).toBe(0x00);
  });

  it('spawnBehaviorEnemy accepts a custom blood color via options', () => {
    const world = createTestWorld();
    const eid = spawnBehaviorEnemy(world, 0, 0, 10, AI_TYPE.CHASE, 1, 200, 0, {
      bloodColor: GREEN_SLIME,
    });

    expect(world.stores.bloodColor.r[eid]).toBe(0x22);
    expect(world.stores.bloodColor.g[eid]).toBe(0xaa);
    expect(world.stores.bloodColor.b[eid]).toBe(0x44);
  });

  it('setBloodColor converts 0xRRGGBB hex into separate r/g/b channels', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    setBloodColor(world, eid, 0x1a2b3c);

    expect(world.stores.bloodColor.r[eid]).toBe(0x1a);
    expect(world.stores.bloodColor.g[eid]).toBe(0x2b);
    expect(world.stores.bloodColor.b[eid]).toBe(0x3c);
  });
});

describe('dropSystem blood color in death event', () => {
  it('emits death event with default red blood color', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 50, 60, 10);
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world, { spawnLoot: false });

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents).toHaveLength(1);
    expect(deathEvents[0]!.bloodColor).toBe(DEFAULT_BLOOD_COLOR);
  });

  it('emits death event with green blood for slime enemies', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10, 120, GREEN_SLIME);
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world, { spawnLoot: false });

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents).toHaveLength(1);
    expect(deathEvents[0]!.bloodColor).toBe(GREEN_SLIME);
  });

  it('mini slimes inherit parent blood color on split', () => {
    // Use the same seed range as the sibling drop-system test which already
    // confirms at least one seed in 1..64 triggers a split.
    let assertionRan = false;

    for (let seed = 1; seed <= 64; seed++) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      meetTutorialGoon(world);

      const slime = spawnBehaviorEnemy(world, 100, 120, 30, AI_TYPE.LEAPER, 0.9, 320, 0, {
        bloodColor: GREEN_SLIME,
      });
      world.floorScenario?.enemyArchetypes.set(slime, 'slime');
      setComponent(world.ecs, slime, Health, { current: 0, max: 30 });

      dropSystem(world, { spawnLoot: false });

      const enemies = Array.from(query(world.ecs, [Enemy, Health])).filter(
        (e) => e !== slime && !hasComponent(world.ecs, e, Spawner),
      );
      if (enemies.length === 2) {
        for (const miniEid of enemies) {
          const r = world.stores.bloodColor.r[miniEid] ?? 0;
          const g = world.stores.bloodColor.g[miniEid] ?? 0;
          const b = world.stores.bloodColor.b[miniEid] ?? 0;
          const packed = (r << 16) | (g << 8) | b;
          expect(packed).toBe(GREEN_SLIME);
        }
        assertionRan = true;
        break;
      }
    }

    // Ensure the assertion branch was actually exercised.
    expect(assertionRan).toBe(true);
  });
});

describe('DEFAULT_BLOOD_COLOR constant', () => {
  it('is red (0xcc0000)', () => {
    expect(DEFAULT_BLOOD_COLOR).toBe(0xcc0000);
  });
});
