import { describe, expect, it } from 'vitest';
import {
  beginWeaponActivation,
  createWeaponTelemetry,
  endWeaponActivation,
  getActivationForEntity,
  markWeaponAccuracyMiss,
  pruneAttackEntity,
  recordWeaponEnemyHit,
  summarizeWeaponTelemetry,
  tagAttackEntity,
  withActivationId,
} from '../../src/core/weapon-telemetry.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Unit coverage for the optional per-run weapon telemetry helpers.
 *
 * These are pure data-only helpers (no systems, no RNG, no wall-clock). The key
 * invariants: every mutator is a no-op when the channel is disabled (undefined
 * `world.weaponTelemetry`), one `dispatchAttack` is exactly one swing/activation,
 * enemies are deduplicated per activation, and the summary math matches the
 * documented definitions.
 */
describe('weapon-telemetry', () => {
  it('createWeaponTelemetry returns a fresh empty collector', () => {
    const wt = createWeaponTelemetry();
    expect(wt.swings).toBe(0);
    expect(wt.accuracyMisses).toBe(0);
    expect(wt.nextActivationId).toBe(0);
    expect(wt.currentActivationId).toBeUndefined();
    expect(wt.entityActivation.size).toBe(0);
    expect(wt.enemiesByActivation.size).toBe(0);
  });

  describe('disabled channel (undefined world.weaponTelemetry)', () => {
    it('every mutator is a no-op and never installs a collector', () => {
      const world = createTestWorld();
      expect(world.weaponTelemetry).toBeUndefined();

      // None of these should throw or install a collector.
      beginWeaponActivation(world);
      tagAttackEntity(world, 10);
      recordWeaponEnemyHit(world, 10, 99);
      markWeaponAccuracyMiss(world);
      endWeaponActivation(world);
      pruneAttackEntity(world, 10);
      expect(getActivationForEntity(world, 10)).toBeUndefined();

      let ran = false;
      withActivationId(world, 5, () => {
        ran = true;
      });
      expect(ran).toBe(true); // fn still runs when disabled
      expect(world.weaponTelemetry).toBeUndefined();
    });
  });

  describe('activation counting', () => {
    it('each begin increments swings and hands out a fresh monotonic id', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();
      const wt = world.weaponTelemetry;

      beginWeaponActivation(world);
      expect(wt.swings).toBe(1);
      expect(wt.currentActivationId).toBe(0);
      endWeaponActivation(world);
      expect(wt.currentActivationId).toBeUndefined();

      beginWeaponActivation(world);
      expect(wt.swings).toBe(2);
      expect(wt.currentActivationId).toBe(1);
      endWeaponActivation(world);

      expect(wt.nextActivationId).toBe(2);
    });

    it('does not tag attack entities spawned with no open activation', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      // Simulates an enemy-spawned projectile: no begin was called.
      tagAttackEntity(world, 42);
      expect(getActivationForEntity(world, 42)).toBeUndefined();
      expect(world.weaponTelemetry.entityActivation.size).toBe(0);
    });

    it('counts accuracy whiffs separately from swings', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      markWeaponAccuracyMiss(world);
      endWeaponActivation(world);

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.swings).toBe(1);
      expect(summary.accuracyMisses).toBe(1);
      expect(summary.connectingSwings).toBe(0);
      expect(summary.accuracy).toBe(0);
    });
  });

  describe('hit recording + dedup', () => {
    it('records a single distinct enemy as one connecting swing', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      tagAttackEntity(world, 100);
      recordWeaponEnemyHit(world, 100, 500);
      endWeaponActivation(world);

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.connectingSwings).toBe(1);
      expect(summary.multiHitSwings).toBe(0);
      expect(summary.totalEnemyHits).toBe(1);
      expect(summary.accuracy).toBe(1);
      expect(summary.avgEnemiesPerConnectingSwing).toBe(1);
    });

    it('deduplicates the same enemy hit multiple times in one activation', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      tagAttackEntity(world, 100);
      // e.g. a piercing projectile grazing the same enemy across frames.
      recordWeaponEnemyHit(world, 100, 500);
      recordWeaponEnemyHit(world, 100, 500);
      recordWeaponEnemyHit(world, 100, 500);
      endWeaponActivation(world);

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.connectingSwings).toBe(1);
      expect(summary.totalEnemyHits).toBe(1);
      expect(summary.multiHitSwings).toBe(0);
    });

    it('counts >=2 distinct enemies in one activation as a multi-hit swing', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      tagAttackEntity(world, 100);
      recordWeaponEnemyHit(world, 100, 500);
      recordWeaponEnemyHit(world, 100, 501);
      recordWeaponEnemyHit(world, 100, 502);
      endWeaponActivation(world);

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.connectingSwings).toBe(1);
      expect(summary.multiHitSwings).toBe(1);
      expect(summary.totalEnemyHits).toBe(3);
      expect(summary.multiHitRate).toBe(1);
      expect(summary.avgEnemiesPerConnectingSwing).toBe(3);
    });

    it('ignores hits from an untagged attack entity', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      // never tagged (e.g. entity 200 was not spawned via a tagging choke point)
      recordWeaponEnemyHit(world, 200, 500);
      endWeaponActivation(world);

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.connectingSwings).toBe(0);
      expect(summary.totalEnemyHits).toBe(0);
    });
  });

  describe('withActivationId (AoE inheritance)', () => {
    it('folds a nested spawn into the parent activation and restores the previous id', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      // Parent projectile cast.
      beginWeaponActivation(world);
      tagAttackEntity(world, 100); // the fireball projectile
      const parentId = getActivationForEntity(world, 100);
      endWeaponActivation(world);
      expect(world.weaponTelemetry.currentActivationId).toBeUndefined();

      // Explosion spawns AFTER the projectile ended — inherit its activation.
      withActivationId(world, parentId, () => {
        tagAttackEntity(world, 101); // the explosion area-damage entity
        recordWeaponEnemyHit(world, 100, 500); // projectile impact
        recordWeaponEnemyHit(world, 101, 501); // splash
        recordWeaponEnemyHit(world, 101, 502); // splash
      });

      // Current id restored to undefined (the value before the wrapper).
      expect(world.weaponTelemetry.currentActivationId).toBeUndefined();

      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      // ONE cast → one swing → one connecting activation with 3 distinct enemies.
      expect(summary.swings).toBe(1);
      expect(summary.connectingSwings).toBe(1);
      expect(summary.multiHitSwings).toBe(1);
      expect(summary.totalEnemyHits).toBe(3);
    });

    it('leaves the child untagged when the parent id is undefined', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      withActivationId(world, undefined, () => {
        tagAttackEntity(world, 300);
      });
      expect(getActivationForEntity(world, 300)).toBeUndefined();
    });

    it('restores the previous activation id even if fn throws', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      const openId = world.weaponTelemetry.currentActivationId;
      expect(() =>
        withActivationId(world, 999, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(world.weaponTelemetry.currentActivationId).toBe(openId);
    });
  });

  describe('pruneAttackEntity', () => {
    it('drops the entity tag but retains the recorded enemy set', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      beginWeaponActivation(world);
      tagAttackEntity(world, 100);
      recordWeaponEnemyHit(world, 100, 500);
      endWeaponActivation(world);

      pruneAttackEntity(world, 100);
      expect(world.weaponTelemetry.entityActivation.has(100)).toBe(false);

      // The aggregate is keyed by activation id, so the connecting hit survives.
      const summary = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(summary.connectingSwings).toBe(1);
      expect(summary.totalEnemyHits).toBe(1);
    });
  });

  describe('summary math across multiple activations', () => {
    it('aggregates accuracy and multi-hit rate over a mixed run', () => {
      const world = createTestWorld();
      world.weaponTelemetry = createWeaponTelemetry();

      // Swing 1: connects with 1 enemy.
      beginWeaponActivation(world);
      tagAttackEntity(world, 10);
      recordWeaponEnemyHit(world, 10, 1);
      endWeaponActivation(world);

      // Swing 2: connects with 2 enemies (multi-hit).
      beginWeaponActivation(world);
      tagAttackEntity(world, 11);
      recordWeaponEnemyHit(world, 11, 2);
      recordWeaponEnemyHit(world, 11, 3);
      endWeaponActivation(world);

      // Swing 3: whiffs entirely (no hit).
      beginWeaponActivation(world);
      tagAttackEntity(world, 12);
      endWeaponActivation(world);

      // Swing 4: accuracy-roll miss.
      beginWeaponActivation(world);
      markWeaponAccuracyMiss(world);
      endWeaponActivation(world);

      const s = summarizeWeaponTelemetry(world.weaponTelemetry);
      expect(s.swings).toBe(4);
      expect(s.accuracyMisses).toBe(1);
      expect(s.connectingSwings).toBe(2);
      expect(s.multiHitSwings).toBe(1);
      expect(s.totalEnemyHits).toBe(3);
      expect(s.accuracy).toBeCloseTo(2 / 4, 10);
      expect(s.multiHitRate).toBeCloseTo(1 / 2, 10);
      expect(s.avgEnemiesPerConnectingSwing).toBeCloseTo(3 / 2, 10);
    });

    it('reports zeroed rates when there were no swings', () => {
      const s = summarizeWeaponTelemetry(createWeaponTelemetry());
      expect(s.accuracy).toBe(0);
      expect(s.multiHitRate).toBe(0);
      expect(s.avgEnemiesPerConnectingSwing).toBe(0);
    });
  });
});
