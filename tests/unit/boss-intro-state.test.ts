import { describe, expect, it } from 'vitest';
import { removeEntity } from 'bitecs';
import { resolvePendingBossIntro } from '../../src/engine/boss-intro-state.js';
import type { FloorBossEncounterState } from '../../src/shared/floor-types.js';
import { spawnEnemy, type GameWorld } from '../../src/core/index.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { createTestWorld } from '../helpers/world-factory.js';

function battle(overrides: Partial<FloorBossEncounterState> = {}): FloorBossEncounterState {
  return {
    started: true,
    bossEid: null,
    defeated: false,
    displayName: 'Slime Rat',
    ...overrides,
  };
}

/**
 * Attach only the boss-battle slice of a Floor 1 scenario. The resolver reads
 * nothing else off `floorScenario`, so building a whole real scenario would add
 * a large amount of irrelevant setup to these trigger-rule tests.
 */
function withFloor1Battles(
  world: GameWorld,
  battles: Map<string, FloorBossEncounterState>,
): GameWorld {
  (world as unknown as { floorScenario: unknown }).floorScenario = {
    objective: { bossBattles: battles },
  };
  return world;
}

function withFamilyEncounters(
  world: GameWorld,
  encounters: Map<string, FloorBossEncounterState>,
): GameWorld {
  (world as unknown as { floorExtendedState: unknown }).floorExtendedState = {
    familyState: { bossEncounters: encounters },
  };
  return world;
}

describe('resolvePendingBossIntro', () => {
  it('returns null when the world has no boss encounters at all', () => {
    const world = createTestWorld();
    expect(resolvePendingBossIntro(world, new Set())).toBeNull();
  });

  it('returns null while the battle has not started', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    withFloor1Battles(world, new Map([['slime-rat', battle({ started: false, bossEid: eid })]]));
    expect(resolvePendingBossIntro(world, new Set())).toBeNull();
  });

  it('returns null before the boss entity has spawned', () => {
    const world = createTestWorld();
    withFloor1Battles(world, new Map([['slime-rat', battle({ bossEid: null })]]));
    expect(resolvePendingBossIntro(world, new Set())).toBeNull();
  });

  it('does not fire for the debug skip that latches started+defeated with no boss', () => {
    const world = createTestWorld();
    withFloor1Battles(world, new Map([['slime-rat', battle({ defeated: true, bossEid: null })]]));
    expect(resolvePendingBossIntro(world, new Set())).toBeNull();
  });

  it('does not fire once the boss entity is gone', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    withFloor1Battles(world, new Map([['slime-rat', battle({ bossEid: eid })]]));
    removeEntity(world.ecs, eid);
    expect(resolvePendingBossIntro(world, new Set())).toBeNull();
  });

  it('resolves the authored Floor 1 intro for a live battle', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    withFloor1Battles(world, new Map([['staircase', battle({ bossEid: eid })]]));

    const pending = resolvePendingBossIntro(world, new Set());
    expect(pending?.bossEid).toBe(eid);
    expect(pending?.content.introId).toBe('floor1:staircase');
    expect(pending?.content.name).toBe('Rat Slime');
  });

  it('suppresses an intro that has already been shown', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    withFloor1Battles(world, new Map([['staircase', battle({ bossEid: eid })]]));

    expect(resolvePendingBossIntro(world, new Set(['floor1:staircase']))).toBeNull();
  });

  it('moves on to the next un-introduced boss when several are live', () => {
    const world = createTestWorld();
    const slimeRatEid = spawnEnemy(world, 0, 0, 100);
    const stairEid = spawnEnemy(world, 1, 1, 100);
    withFloor1Battles(
      world,
      new Map([
        ['slime-rat', battle({ bossEid: slimeRatEid })],
        ['staircase', battle({ bossEid: stairEid, displayName: 'Rat Slime' })],
      ]),
    );

    expect(resolvePendingBossIntro(world, new Set())?.content.introId).toBe('floor1:slime-rat');
    expect(resolvePendingBossIntro(world, new Set(['floor1:slime-rat']))?.content.introId).toBe(
      'floor1:staircase',
    );
    expect(
      resolvePendingBossIntro(world, new Set(['floor1:slime-rat', 'floor1:staircase'])),
    ).toBeNull();
  });

  it('resolves the family intro for a live Floor 2 den boss', () => {
    const world = createTestWorld({ floor: 2 });
    const family = loadFamilies()[0]!;
    const eid = spawnEnemy(world, 0, 0, 100);
    withFamilyEncounters(
      world,
      new Map([[family.id, battle({ bossEid: eid, displayName: family.boss.name })]]),
    );

    const pending = resolvePendingBossIntro(world, new Set());
    expect(pending?.content.introId).toBe(`floor2:${family.id}`);
    expect(pending?.content.name).toBe(family.boss.name);
  });

  it('falls back to a named sheet for an unrecognised boss key', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    withFloor1Battles(
      world,
      new Map([['mystery', battle({ bossEid: eid, displayName: 'Something Wet' })]]),
    );

    const pending = resolvePendingBossIntro(world, new Set());
    expect(pending?.content.introId).toBe('boss:mystery');
    expect(pending?.content.name).toBe('Something Wet');
  });
});
