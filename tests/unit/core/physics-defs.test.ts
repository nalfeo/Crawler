import { describe, expect, it } from 'vitest';
import {
  PHYSICS_BODIES,
  SHAPE_BOX,
  SHAPE_CIRCLE,
  getPhysicsBody,
  type PhysicsBodyId,
} from '../../../src/core/physics-defs.js';

describe('physics-defs registry', () => {
  it('every entry has a valid shape/size combo (R6: no zero-body entries)', () => {
    for (const [id, def] of Object.entries(PHYSICS_BODIES)) {
      if (def.shape === SHAPE_CIRCLE) {
        expect(def.radius, `${id}: circles must have radius > 0`).toBeGreaterThan(0);
        expect(def.halfWidth, `${id}: circles must have halfWidth === 0`).toBe(0);
        expect(def.halfHeight, `${id}: circles must have halfHeight === 0`).toBe(0);
      } else if (def.shape === SHAPE_BOX) {
        expect(def.radius, `${id}: boxes must have radius === 0`).toBe(0);
        // beam-segment intentionally has halfWidth = 0 (length is per-cast).
        // Everything else must have both non-zero.
        if (id !== 'beam-segment') {
          expect(def.halfWidth, `${id}: boxes must have halfWidth > 0`).toBeGreaterThan(0);
        }
        expect(def.halfHeight, `${id}: boxes must have halfHeight > 0`).toBeGreaterThan(0);
      } else {
        throw new Error(`${id}: shape must be SHAPE_CIRCLE or SHAPE_BOX, got ${def.shape}`);
      }
      expect(def.weight, `${id}: weight must be > 0`).toBeGreaterThan(0);
    }
  });

  it('bit-identical Slice-1 half-extents (parity with shipping spawners)', () => {
    // Player sprite is 3×3 → r = 1.5.
    expect(PHYSICS_BODIES.player.radius).toBe(1.5);
    // spawnBehaviorEnemy sprite is 2×2 → r = 1.0.
    expect(PHYSICS_BODIES['mob-baseline'].radius).toBe(1.0);
    // spawnSpawner sprite is 3×3 → r = 1.5.
    expect(PHYSICS_BODIES['spawner-structure'].radius).toBe(1.5);
    // spawnProjectile sprite is 0.75×0.75 → r = 0.375.
    expect(PHYSICS_BODIES['projectile-bullet'].radius).toBe(0.375);
    // spawnBeam sprite height is 0.5 → hh = 0.25.
    expect(PHYSICS_BODIES['beam-segment'].halfHeight).toBe(0.25);
    // spawnXpGem sprite is 1×1 → r = 0.5.
    expect(PHYSICS_BODIES['xp-gem'].radius).toBe(0.5);
    // spawnGold sprite is 1×1 today → r = 0.5.
    expect(PHYSICS_BODIES.gold.radius).toBe(0.5);
    // spawnDroppedItem sprite is 1.25×1.25 → r = 0.625.
    expect(PHYSICS_BODIES['dropped-item'].radius).toBe(0.625);
    // spawnTrap sprite is 1.5×1.5 → r = 0.75.
    expect(PHYSICS_BODIES.trap.radius).toBe(0.75);
    // spawnHarvestableNode sprite is 1×1 → r = 0.5.
    expect(PHYSICS_BODIES['harvestable-node'].radius).toBe(0.5);
  });

  it('getPhysicsBody returns the def for a known id', () => {
    expect(getPhysicsBody('player').radius).toBe(1.5);
  });

  it('getPhysicsBody throws for an unknown id', () => {
    expect(() => getPhysicsBody('nope' as PhysicsBodyId)).toThrow(/unknown id/);
  });
});
