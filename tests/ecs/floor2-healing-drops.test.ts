import { addComponent, query, set } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { Damage, DroppedItem, FamilyMembership } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { getItemByIndex } from '../../src/shared/items.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';

function fixture(boss: boolean, roll: number, floorId = 'floor2') {
  const world = createTestWorld({ seed: 42, floor: 2 });
  world.floorId = floorId;
  const enemy = spawnEnemy(world, 0, 0, 10);
  if (boss) addComponent(world.ecs, enemy, set(FamilyMembership, { familyId: 0, isBoss: 1 }));
  world.stores.health.current[enemy] = 0;
  addComponent(world.ecs, enemy, set(Damage, { amount: 0 }));
  vi.spyOn(world.rng, 'next').mockReturnValue(roll);
  return world;
}

function potions(world: ReturnType<typeof createTestWorld>) {
  return [...query(world.ecs, [DroppedItem])].filter(
    (eid) => getItemByIndex(world.stores.droppedItem.itemIndex[eid]!)?.id === 'health-vial',
  );
}

describe('Floor 2 healing drops', () => {
  it.each([
    { boss: false, roll: 0.009999, expected: 1 },
    { boss: false, roll: 0.01, expected: 0 },
    { boss: true, roll: 0.499999, expected: 1 },
    { boss: true, roll: 0.5, expected: 0 },
  ])('uses exact threshold boss=$boss roll=$roll', ({ boss, roll, expected }) => {
    const world = fixture(boss, roll);
    dropSystem(world);
    dropSystem(world);
    expect(potions(world)).toHaveLength(expected);
    world.frameCount++;
    dropSystem(world);
    expect(potions(world)).toHaveLength(expected);
  });

  it('does not introduce drops on other floors or with loot disabled', () => {
    const other = fixture(true, 0, 'floor1');
    dropSystem(other);
    expect(potions(other)).toHaveLength(0);
    const disabled = fixture(true, 0);
    dropSystem(disabled, { spawnLoot: false });
    expect(potions(disabled)).toHaveLength(0);
  });

  it('drops and heals through the real core simulation pipeline', () => {
    const world = fixture(true, 0);
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 200;
    world.stores.health.current[player] = 100;
    runSimulationStep(world, createInputState(), 1000 / 60);
    runSimulationStep(world, createInputState(), 1000 / 60);
    expect(world.stores.health.current[player]).toBe(120);
    expect(potions(world)).toHaveLength(0);
  });

  it('replays the same drop sequence from the same seed', () => {
    const run = () => {
      const world = createTestWorld({ seed: 42, floor: 2 });
      world.floorId = 'floor2';
      const trace: number[] = [];
      for (let n = 0; n < 100; n++) {
        const enemy = spawnEnemy(world, n * 3, 0, 10);
        world.stores.health.current[enemy] = 0;
        dropSystem(world);
        trace.push(potions(world).length);
        world.frameCount++;
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});
