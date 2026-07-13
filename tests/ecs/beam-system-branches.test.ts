import { addComponent, addEntity, removeEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnBeam, spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { beamSystem } from '../../src/core/systems/beamSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { Health, Position, Sprite, Team } from '../../src/core/components.js';
import { TeamId } from '../../src/shared/constants.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';

const SAFE_FT = { x: 3 * 32 + 16, y: 3 * 32 + 16 };

function addBareHealthTarget(world: GameWorld, x: number, y: number, team?: number): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 16, height: 16 }));
  addComponent(world.ecs, eid, set(Health, { current: 50, max: 50 }));
  if (team !== undefined) {
    addComponent(world.ecs, eid, set(Team, { id: team }));
  }
  return eid;
}

describe('beamSystem branch coverage', () => {
  it('damages a target sitting exactly on a zero-length beam origin', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 100, 100);
    const enemy = spawnEnemy(world, 100, 100, 50);
    world.elapsedMs = 1000;
    // length 0 → the segment collapses to a point (abLenSq <= epsilon branch).
    spawnBeam(world, 100, 100, 1, 0, 0, 15, 500, 0, player, TeamId.PLAYER);

    beamSystem(world);

    expect(world.stores.health.current[enemy]).toBe(35);
  });

  it('skips beams owned by a player standing in a safe room', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const player = spawnPlayer(world, SAFE_FT.x, SAFE_FT.y);
    const enemy = spawnEnemy(world, SAFE_FT.x + 20, SAFE_FT.y, 50);
    world.elapsedMs = 1000;
    spawnBeam(world, SAFE_FT.x, SAFE_FT.y, 1, 0, 64, 15, 500, 0, player, TeamId.PLAYER);

    beamSystem(world);

    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('skips non-combatant targets and same-team targets', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Non-combatant: Health but not Enemy/Player.
    const prop = addBareHealthTarget(world, 30, 0);
    // Same-team enemy: should be skipped by the team check.
    const ally = spawnEnemy(world, 50, 0, 50);
    addComponent(world.ecs, ally, set(Team, { id: TeamId.PLAYER }));
    // A genuine enemy that should take damage.
    const foe = spawnEnemy(world, 70, 0, 50);
    world.elapsedMs = 1000;
    spawnBeam(world, 0, 0, 1, 0, 100, 15, 500, 0, player, TeamId.PLAYER);

    beamSystem(world);

    expect(world.stores.health.current[prop]).toBe(50);
    expect(world.stores.health.current[ally]).toBe(50);
    expect(world.stores.health.current[foe]).toBe(35);
  });

  it('respects the per-beam tick interval', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 30, 0, 50);
    world.elapsedMs = 1000;
    const beam = spawnBeam(world, 0, 0, 1, 0, 100, 15, 2000, 500, player, TeamId.PLAYER);
    // Force a recent tick so the tick-gate short-circuits this frame.
    world.stores.lineDamage.lastTickMs[beam] = 1000;
    world.elapsedMs = 1100; // < 1000 + 500 tickMs

    beamSystem(world);

    expect(world.stores.health.current[enemy]).toBe(50);
  });

  it('ignores removed beam entities without throwing', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemy(world, 30, 0, 50);
    world.elapsedMs = 1000;
    const beam = spawnBeam(world, 0, 0, 1, 0, 100, 15, 500, 0, player, TeamId.PLAYER);
    removeEntity(world.ecs, beam);

    expect(() => beamSystem(world)).not.toThrow();
  });
});

describe('beamSystem hit-gated weapon-skill XP', () => {
  it('emits weapon_fired events for both skills when a player-owned beam hits an enemy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 30, 0, 50);
    world.elapsedMs = 1000;
    const beam = spawnBeam(world, 0, 0, 1, 0, 100, 15, 500, 0, player, TeamId.PLAYER);
    world.attackWeaponSkillsByEntity.set(beam, {
      classSkillId: 'energy',
      typeSkillId: 'laser',
    });

    beamSystem(world);

    expect(world.stores.health.current[enemy]).toBe(35);
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['energy', 'laser']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });

  it('emits no skill events when the beam has no registered skill source', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 30, 0, 50);
    world.elapsedMs = 1000;
    // Beam spawned but no attackWeaponSkillsByEntity entry registered for it.
    spawnBeam(world, 0, 0, 1, 0, 100, 15, 500, 0, player, TeamId.PLAYER);

    beamSystem(world);

    expect(world.stores.health.current[enemy]).toBe(35);
    expect(world.skillUsageEvents).toHaveLength(0);
  });
});

describe('beamSystem lethal-hit kill attribution', () => {
  it('retains player EID as sourceEid in the death event after a lethal beam hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // HP=1 so the 15-damage beam hit is lethal
    const enemy = spawnEnemy(world, 30, 0, 1);
    world.elapsedMs = 1000;
    spawnBeam(world, 0, 0, 1, 0, 100, 15, 500, 0, player, TeamId.PLAYER);

    beamSystem(world);
    // Enemy HP should now be ≤ 0
    expect(world.stores.health.current[enemy] ?? 1).toBeLessThanOrEqual(0);

    dropSystem(world, { spawnLoot: false });

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents).toHaveLength(1);
    expect(deathEvents[0]!.sourceEid).toBe(player);
  });
});
