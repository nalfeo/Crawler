/**
 * Enemy fireball AoE DamageMeta regression tests.
 *
 * Verifies that the fireball projectile spawned by the enemy AI path carries
 * enemy/unscaled metadata, and that the explosion created by aoeOnImpactSystem
 * inherits that metadata via propagateDamageMeta — ensuring delayed damage
 * tracks the correct attacker origin rather than defaulting to 'environment'.
 */
import { query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage } from '../../src/core/components.js';
import { readDamageMeta, tagDamageMeta } from '../../src/core/damage-meta.js';
import { spawnAoeProjectile } from '../../src/core/helpers.js';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('enemy fireball AoE DamageMeta', () => {
  it('projectile tagged with enemy/unscaled metadata reads back correctly', () => {
    const world = createTestWorld();
    const ownerEid = 0; // synthetic enemy EID for this unit test
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 3, 10, ownerEid, TeamId.ENEMY, 0);

    // This mirrors what the fix in enemyAISystem does after spawnAoeProjectile.
    tagDamageMeta(world, proj, {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
    });

    const meta = readDamageMeta(world, proj);
    expect(meta.origin).toBe('enemy');
    expect(meta.affinity).toBe('unscaled');
    expect(meta.scaleWithPrimary).toBe(false);
    expect(meta.canCrit).toBe(false);
  });

  it('explosion spawned from tagged fireball projectile inherits enemy/unscaled metadata', () => {
    const world = createTestWorld();
    const ownerEid = 0;
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 3, 10, ownerEid, TeamId.ENEMY, 0);

    tagDamageMeta(world, proj, {
      origin: 'enemy',
      affinity: 'unscaled',
      scaleWithPrimary: false,
      canCrit: false,
    });

    // Run AoE pre-damage snapshot, destroy projectile (simulates impact), then post-damage.
    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    const explosions = Array.from(query(world.ecs, [AreaDamage]));
    expect(explosions).toHaveLength(1);

    const explosionMeta = readDamageMeta(world, explosions[0]!);
    expect(explosionMeta.origin).toBe('enemy');
    expect(explosionMeta.affinity).toBe('unscaled');
    expect(explosionMeta.scaleWithPrimary).toBe(false);
    expect(explosionMeta.canCrit).toBe(false);
  });

  it('untagged fireball projectile defaults to fail-closed environment metadata', () => {
    // Verify the fail-closed default so the test above proves tagging matters.
    const world = createTestWorld();
    const ownerEid = 0;
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 3, 10, ownerEid, TeamId.ENEMY, 0);

    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    const explosions = Array.from(query(world.ecs, [AreaDamage]));
    expect(explosions).toHaveLength(1);

    const explosionMeta = readDamageMeta(world, explosions[0]!);
    // Without the fix the origin defaults to 'environment' (fail-closed).
    expect(explosionMeta.origin).toBe('environment');
    expect(explosionMeta.affinity).toBe('unscaled');
  });
});
