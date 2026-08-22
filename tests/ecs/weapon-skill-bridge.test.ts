import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { emitWeaponHitSkillEventsForSource } from '../../src/core/weapon-skill-bridge.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('emitWeaponHitSkillEventsForSource', () => {
  it('emits from the per-entity mapping when present', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.attackWeaponSkillsByEntity.set(42, {
      classSkillId: 'class-a',
      typeSkillId: 'type-a',
    });

    emitWeaponHitSkillEventsForSource(world, player, 42);

    expect(world.skillUsageEvents).toEqual([
      { holderEid: player, skillId: 'class-a', metric: 'weapon_fired', amount: 1 },
      { holderEid: player, skillId: 'type-a', metric: 'weapon_fired', amount: 1 },
    ]);
  });

  it('falls back to the attacker-level map when the entity is unregistered', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    world.attackerWeaponSkills.set(player, {
      classSkillId: 'class-fallback',
      typeSkillId: 'type-fallback',
    });

    // 999 was never registered in attackWeaponSkillsByEntity (get() -> undefined).
    emitWeaponHitSkillEventsForSource(world, player, 999);

    expect(world.skillUsageEvents).toEqual([
      { holderEid: player, skillId: 'class-fallback', metric: 'weapon_fired', amount: 1 },
      { holderEid: player, skillId: 'type-fallback', metric: 'weapon_fired', amount: 1 },
    ]);
  });

  it('does not emit anything when neither mapping has an entry', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);

    emitWeaponHitSkillEventsForSource(world, player, 999);

    expect(world.skillUsageEvents).toEqual([]);
  });

  it('suppresses the attacker-level fallback for an entity explicitly mapped to null (e.g. a spell projectile)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Simulates the player having last fired a weapon...
    world.attackerWeaponSkills.set(player, {
      classSkillId: 'bow-class',
      typeSkillId: 'bow-type',
    });
    // ...then casting Magic Missile, whose projectile explicitly opts out of
    // the weapon-skill fallback so its hit is never misattributed to the bow.
    world.attackWeaponSkillsByEntity.set(7, null);

    emitWeaponHitSkillEventsForSource(world, player, 7);

    expect(world.skillUsageEvents).toEqual([]);
  });
});
