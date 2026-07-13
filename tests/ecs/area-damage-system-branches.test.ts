import { addComponent, addEntity, removeEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnAreaAttack, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { areaDamageSystem, clearAreaDamageHits } from '../../src/core/systems/areaDamageSystem.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { Health, Position, Sprite, Team } from '../../src/core/components.js';
import { TeamId } from '../../src/shared/constants.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';

/** Feet centre of the safe room (tile 3,3). */
const SAFE_FT = { x: 3 * 32 + 16, y: 3 * 32 + 16 };

function addBareTarget(
  world: GameWorld,
  x: number,
  y: number,
  opts: { health?: boolean; team?: number } = {},
): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
  if (opts.health) {
    addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
  }
  if (opts.team !== undefined) {
    addComponent(world.ecs, eid, set(Team, { id: opts.team }));
  }
  return eid;
}

describe('areaDamageSystem branch coverage', () => {
  it('skips player-owned area attacks when the owner is inside a safe room', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const player = spawnPlayer(world, SAFE_FT.x, SAFE_FT.y);
    const enemy = spawnEnemy(world, SAFE_FT.x + 8, SAFE_FT.y, 50);
    world.elapsedMs = 100;
    spawnAreaAttack(world, SAFE_FT.x, SAFE_FT.y, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('skips same-team targets', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    // An enemy re-flagged onto the PLAYER team should be ignored by a
    // player-team area attack.
    const ally = spawnEnemy(world, 110, 100, 50);
    addComponent(world.ecs, ally, set(Team, { id: TeamId.PLAYER }));
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[ally]).toBe(50);
  });

  it('skips targets without a Health component', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    addBareTarget(world, 110, 100, { health: false });
    const enemy = spawnEnemy(world, 112, 100, 50);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    // Should not throw despite a candidate lacking Health; the real enemy is hit.
    expect(() => areaDamageSystem(world, collision)).not.toThrow();
    expect(world.stores.health.current[enemy]).toBe(35);
  });

  it('skips non-combatant targets (Health but neither Player nor Enemy)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const prop = addBareTarget(world, 110, 100, { health: true, team: TeamId.ENEMY });
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[prop]).toBe(50);
  });

  it('only damages enemies inside the swing arc', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    // Arc points east (+x) with a narrow 60° spread.
    const inArc = spawnEnemy(world, 130, 100, 50); // due east
    const outOfArc = spawnEnemy(world, 100, 130, 50); // due south
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 60, 200, TeamId.PLAYER, 1, 0, 60);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[inArc]).toBe(35);
    expect(world.stores.health.current[outOfArc]).toBe(50);
  });

  it('skips area-damage entities that no longer exist', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    spawnEnemy(world, 110, 100, 50);
    world.elapsedMs = 100;
    const aoe = spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    removeEntity(world.ecs, aoe);
    expect(() => areaDamageSystem(world, collision)).not.toThrow();
  });

  it('clearAreaDamageHits is a no-op when the world has no tracking yet', () => {
    const world = createTestWorld();
    expect(() => clearAreaDamageHits(world, 123)).not.toThrow();
  });
});

describe('areaDamageSystem hit-gated weapon-skill XP', () => {
  it('emits weapon_fired events for both skills when a player-owned explosion hits an enemy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 110, 100, 50);
    world.elapsedMs = 100;
    const aoeEid = spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);
    world.attackWeaponSkillsByEntity.set(aoeEid, {
      classSkillId: 'arcane',
      typeSkillId: 'fireball',
    });

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(35);
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['arcane', 'fireball']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });

  it('emits no skill events when the explosion has no registered skill source', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 110, 100, 50);
    world.elapsedMs = 100;
    // Area attack spawned but no attackWeaponSkillsByEntity entry registered for it.
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);

    expect(world.stores.health.current[enemy]).toBe(35);
    expect(world.skillUsageEvents).toHaveLength(0);
  });
});

describe('areaDamageSystem lethal-hit kill attribution', () => {
  it('retains player EID as sourceEid in the death event after a lethal area hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    // HP=1 so the 40-damage area hit is lethal
    const enemy = spawnEnemy(world, 110, 100, 1);
    world.elapsedMs = 100;
    spawnAreaAttack(world, 100, 100, player, 15, 40, 200, TeamId.PLAYER);

    const collision = collisionSystem(world);
    areaDamageSystem(world, collision);
    // Enemy HP should now be ≤ 0
    expect(world.stores.health.current[enemy] ?? 1).toBeLessThanOrEqual(0);

    dropSystem(world, { spawnLoot: false });

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents).toHaveLength(1);
    expect(deathEvents[0]!.sourceEid).toBe(player);
  });
});
