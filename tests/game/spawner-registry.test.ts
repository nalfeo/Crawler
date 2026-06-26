import { describe, expect, it } from 'vitest';
import {
  SPAWNER_ARCHETYPES,
  getSpawnerArchetype,
  getSpawnerArchetypeByIndex,
  getSpawnerArchetypeIndex,
  pickFromPool,
} from '../../src/game/spawners/registry.js';
import type { SpawnPoolEntry } from '../../src/game/spawners/types.js';

function poolIds(pool: readonly SpawnPoolEntry[]): string[] {
  return pool.map((entry) => entry.mob.id);
}

describe('spawner registry', () => {
  it('exposes both shipped archetypes in stable index order', () => {
    expect(SPAWNER_ARCHETYPES.map((a) => a.id)).toEqual(['rats-nest', 'slime-pool']);
  });

  it('round-trips id ↔ index ↔ archetype', () => {
    SPAWNER_ARCHETYPES.forEach((archetype, index) => {
      expect(getSpawnerArchetypeIndex(archetype.id)).toBe(index);
      expect(getSpawnerArchetypeByIndex(index)).toBe(archetype);
      expect(getSpawnerArchetype(archetype.id)).toBe(archetype);
    });
  });

  it('returns -1 / undefined for unknown ids and indexes', () => {
    expect(getSpawnerArchetypeIndex('nope')).toBe(-1);
    expect(getSpawnerArchetype('nope')).toBeUndefined();
    expect(getSpawnerArchetypeByIndex(999)).toBeUndefined();
  });

  it('Rats Nest spawns rats + brutes, with king/queen on death', () => {
    const nest = getSpawnerArchetype('rats-nest');
    expect(nest).toBeDefined();
    expect(poolIds(nest!.passive.pool)).toEqual(expect.arrayContaining(['rat', 'rat-brute']));
    // Defensive ups the brute presence.
    const brute = nest!.defensive.pool.find((e) => e.mob.id === 'rat-brute');
    const passiveBrute = nest!.passive.pool.find((e) => e.mob.id === 'rat-brute');
    expect(brute!.weight).toBeGreaterThan(passiveBrute!.weight);
    const deathIds = nest!.onDeath.flatMap((g) => poolIds(g.pool));
    expect(deathIds).toEqual(expect.arrayContaining(['rat-king', 'rat-queen']));
  });

  it('Slime Pool spawns slimes faster when defensive, with mama/papa on death', () => {
    const pool = getSpawnerArchetype('slime-pool');
    expect(pool).toBeDefined();
    expect(poolIds(pool!.passive.pool)).toContain('slime');
    // "More slimes faster": shorter interval + higher cap when defensive.
    expect(pool!.defensive.intervalMs).toBeLessThan(pool!.passive.intervalMs);
    expect(pool!.defensive.maxAlive).toBeGreaterThan(pool!.passive.maxAlive);
    const deathIds = pool!.onDeath.flatMap((g) => poolIds(g.pool));
    expect(deathIds).toEqual(expect.arrayContaining(['mama-slime', 'papa-slime']));
  });

  it('every defensive mode is at least as aggressive as passive', () => {
    for (const archetype of SPAWNER_ARCHETYPES) {
      expect(archetype.defensive.intervalMs).toBeLessThanOrEqual(archetype.passive.intervalMs);
      expect(archetype.defensive.maxAlive).toBeGreaterThanOrEqual(archetype.passive.maxAlive);
    }
  });
});

describe('pickFromPool', () => {
  const pool: SpawnPoolEntry[] = [
    { weight: 1, mob: getSpawnerArchetype('rats-nest')!.passive.pool[0]!.mob },
    { weight: 3, mob: getSpawnerArchetype('rats-nest')!.passive.pool[1]!.mob },
  ];

  it('selects the first positive-weight entry at roll 0 and the last near roll 1', () => {
    expect(pickFromPool(pool, 0)?.id).toBe(pool[0]!.mob.id);
    expect(pickFromPool(pool, 0.999)?.id).toBe(pool[1]!.mob.id);
  });

  it('honours relative weights across the [0,1) range', () => {
    // weight split is 1:3 over total 4 → roll < 0.25 picks A, otherwise B.
    expect(pickFromPool(pool, 0.2)?.id).toBe(pool[0]!.mob.id);
    expect(pickFromPool(pool, 0.3)?.id).toBe(pool[1]!.mob.id);
  });

  it('is robust to empty pools, zero weights, and out-of-range rolls', () => {
    expect(pickFromPool([], 0.5)).toBeUndefined();
    const single: SpawnPoolEntry[] = [{ weight: 0, mob: pool[0]!.mob }];
    expect(pickFromPool(single, 0.5)?.id).toBe(pool[0]!.mob.id);
    // Rolls are clamped into [0,1): negative → first entry, ≥1 → last entry.
    expect(pickFromPool(pool, -1)?.id).toBe(pool[0]!.mob.id);
    expect(pickFromPool(pool, 5)?.id).toBe(pool[pool.length - 1]!.mob.id);
  });
});
