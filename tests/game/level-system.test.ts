import { describe, it, expect } from 'vitest';
import { hasComponent } from 'bitecs';
import { SkillHolder } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { levelSystem } from '../../src/game/systems/levelSystem.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';

describe('levelSystem', () => {
  it('does nothing when no player exists', () => {
    const world = createTestWorld();
    expect(() => levelSystem(world)).not.toThrow();
    expect(world.playerLevel.level).toBe(0);
  });

  it('does not level up if XP is below threshold', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(1) - 1;
    levelSystem(world);
    expect(world.playerLevel.level).toBe(0);
  });

  it('advances level when XP crosses threshold', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(1);
    levelSystem(world);
    expect(world.playerLevel.level).toBe(1);
  });

  it('grants pointsPerLevel unspent points on level-up', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(1);
    levelSystem(world);
    expect(world.playerLevel.unspentPoints).toBe(world.playerLevel.pointsPerLevel);
  });

  it('batches multiple level-ups from a single XP grant', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(3);
    levelSystem(world);
    expect(world.playerLevel.level).toBe(3);
    expect(world.playerLevel.unspentPoints).toBe(world.playerLevel.pointsPerLevel * 3);
  });

  it('adds SkillHolder tag to player on first level-up', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(1);
    levelSystem(world);
    expect(hasComponent(world.ecs, player, SkillHolder)).toBe(true);
  });

  it('does not grant points again if level already reached', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(2);
    levelSystem(world);
    const pointsAfterFirst = world.playerLevel.unspentPoints;
    levelSystem(world); // same XP, already at level 2
    expect(world.playerLevel.unspentPoints).toBe(pointsAfterFirst);
  });

  it('emits a levelUpBurst VFX at the player position on level-up', () => {
    const world = createTestWorld();
    spawnPlayer(world, 64, 48);
    world.playerLevel.xp = xpRequiredForLevel(1);
    levelSystem(world);
    expect(world.vfxEvents).toHaveLength(1);
    expect(world.vfxEvents[0]).toMatchObject({ kind: 'levelUpBurst', x: 64, y: 48 });
  });

  it('does not emit a levelUpBurst when no level-up occurs', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.playerLevel.xp = xpRequiredForLevel(1) - 1;
    levelSystem(world);
    expect(world.vfxEvents).toHaveLength(0);
  });
});
