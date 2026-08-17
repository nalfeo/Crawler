import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Companion,
  Team,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { TeamId } from '../../src/shared/constants.js';
import {
  AI_TYPE,
  companionAISystem,
  enemyAISystem,
  getCompanionAIDecision,
} from '../../src/game/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function spawnCompanion(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  teamId = TeamId.PLAYER,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Companion, {
      speciesToken: 1,
      form: 0,
      level: 1,
      xp: 0,
      ownerTeam: teamId,
      knockedOut: 0,
    }),
  );
  return eid;
}

function spawnRival(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  teamId = TeamId.ENEMY,
): number {
  const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

describe('companionAISystem', () => {
  it('targets the nearest rival with a different team id', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 0, 0);
    const nearRival = spawnRival(world, 4, 0);
    spawnRival(world, 8, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(nearRival);
  });

  it('follows player when no rival exists and companion is outside leash', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 20, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('follow');
    expect(decision?.targetEid).toBeDefined();
    expect(decision?.x).toBe(0);
    expect(decision?.y).toBe(0);
  });

  it('idles when inside leash and no rival exists', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 1, 0);

    companionAISystem(world);
    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('idle');
  });

  it('skips knocked-out companions', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    const companion = spawnCompanion(world, 20, 0);
    world.stores.companion.knockedOut[companion] = 1;

    companionAISystem(world);
    expect(getCompanionAIDecision(world, companion)).toBeUndefined();
  });

  it('is consumed by enemyAISystem in real prepass → ai → movement pipeline', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, -20);
    const companion = spawnCompanion(world, 0, 0);
    const rival = spawnRival(world, 0, 12);

    companionAISystem(world);
    enemyAISystem(world);
    movementSystem(world);

    const decision = getCompanionAIDecision(world, companion);
    expect(decision?.kind).toBe('rival-primary');
    expect(decision?.targetEid).toBe(rival);
    expect(world.stores.position.y[companion]).toBeGreaterThan(0);
  });
});
