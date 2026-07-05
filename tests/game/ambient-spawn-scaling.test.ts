import { describe, expect, it } from 'vitest';
import { scaleAmbientSpawnStats } from '../../src/game/floorScenario.js';
import {
  MOB_SCALING_HP_MULT_MAX,
  MOB_SCALING_REFERENCE_DIST_FT,
  MOB_SCALING_SPEED_MULT_MAX,
} from '../../src/shared/mob-scaling.js';
import { floor1EnemyPack } from '../../src/shared/enemy-packs.js';

// Assertion-level coverage for the spawn wiring: `spawnAmbientArchetype` calls
// `scaleAmbientSpawnStats` with the archetype's base stats, the mob spawn
// position, and the floor spawn-tile world position. `computeMobLevelScale`
// (the ramp curve) is unit-tested in tests/unit/mob-scaling.test.ts; this
// suite pins that a mob spawned FAR from the spawn tile actually receives the
// boosted, rounded HP/speed that get handed to spawnBehaviorEnemy.
const rat = floor1EnemyPack.archetypes.find((a) => a.id === 'rat');
const slime = floor1EnemyPack.archetypes.find((a) => a.id === 'slime');

describe('scaleAmbientSpawnStats (distance-from-spawn spawn wiring)', () => {
  it('exercises the real Floor-1 archetype bases', () => {
    // Guards against enemy-pack data drift silently voiding the assertions below.
    expect(rat).toBeDefined();
    expect(slime).toBeDefined();
  });

  it('leaves base stats unchanged for a mob spawned on the spawn tile', () => {
    const spawned = scaleAmbientSpawnStats(rat!.hp, rat!.speed, 128, 128, 128, 128);
    expect(spawned.hp).toBe(Math.round(rat!.hp));
    expect(spawned.speed).toBeCloseTo(rat!.speed, 10);
  });

  it('applies the max HP/speed multipliers beyond the reference distance', () => {
    const farX = MOB_SCALING_REFERENCE_DIST_FT + 75;
    const spawned = scaleAmbientSpawnStats(rat!.hp, rat!.speed, farX, 0, 0, 0);
    expect(spawned.hp).toBe(Math.max(1, Math.round(rat!.hp * MOB_SCALING_HP_MULT_MAX)));
    expect(spawned.speed).toBeCloseTo(rat!.speed * MOB_SCALING_SPEED_MULT_MAX, 10);
  });

  it('boosts a distant spawn strictly above a spawn-adjacent one (both archetypes)', () => {
    for (const archetype of [rat!, slime!]) {
      const near = scaleAmbientSpawnStats(archetype.hp, archetype.speed, 5, 0, 0, 0);
      const far = scaleAmbientSpawnStats(
        archetype.hp,
        archetype.speed,
        MOB_SCALING_REFERENCE_DIST_FT,
        0,
        0,
        0,
      );
      expect(far.hp).toBeGreaterThan(near.hp);
      expect(far.speed).toBeGreaterThan(near.speed);
    }
  });

  it('interpolates linearly at the midpoint distance', () => {
    const midDist = MOB_SCALING_REFERENCE_DIST_FT / 2;
    const spawned = scaleAmbientSpawnStats(rat!.hp, rat!.speed, midDist, 0, 0, 0);
    const expectedHpMult = 1 + 0.5 * (MOB_SCALING_HP_MULT_MAX - 1);
    const expectedSpeedMult = 1 + 0.5 * (MOB_SCALING_SPEED_MULT_MAX - 1);
    expect(spawned.hp).toBe(Math.max(1, Math.round(rat!.hp * expectedHpMult)));
    expect(spawned.speed).toBeCloseTo(rat!.speed * expectedSpeedMult, 10);
  });

  it('uses Euclidean distance, so a diagonal offset scales by its magnitude', () => {
    // A diagonal whose magnitude equals the reference distance is fully scaled.
    const leg = MOB_SCALING_REFERENCE_DIST_FT / Math.SQRT2;
    const spawned = scaleAmbientSpawnStats(rat!.hp, rat!.speed, leg, leg, 0, 0);
    expect(spawned.hp).toBe(Math.max(1, Math.round(rat!.hp * MOB_SCALING_HP_MULT_MAX)));
    expect(spawned.speed).toBeCloseTo(rat!.speed * MOB_SCALING_SPEED_MULT_MAX, 10);
  });

  it('clamps rounded HP to a minimum of 1 for a tiny base', () => {
    const spawned = scaleAmbientSpawnStats(0.3, 0.1, 0, 0, 0, 0);
    expect(spawned.hp).toBe(1);
  });
});
