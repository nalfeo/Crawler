import { describe, expect, it, beforeEach } from 'vitest';
import { addComponent, set } from 'bitecs';
import {
  getBodyHalfWidth,
  getBodyHalfHeight,
  getBodyRadius,
  resetShimStats,
  getShimStats,
} from '../../../src/core/physics-body.js';
import { Size } from '../../../src/core/components.js';
import { SHAPE_CIRCLE, SHAPE_BOX } from '../../../src/core/physics-defs.js';
import { createEntity } from '../../../src/core/helpers.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import type { GameWorld } from '../../../src/core/world.js';

function createCircleEntity(world: GameWorld, radius: number): number {
  const eid = createEntity(world);
  addComponent(
    world.ecs,
    eid,
    set(Size, { radius, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
  );
  return eid;
}

function createBoxEntity(world: GameWorld, halfWidth: number, halfHeight: number): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Size, { radius: 0, halfWidth, halfHeight, shape: SHAPE_BOX }));
  return eid;
}

describe('physics-body helpers', () => {
  beforeEach(() => {
    resetShimStats();
  });

  describe('getBodyHalfWidth', () => {
    it('returns halfWidth for a box body', () => {
      const world = createTestWorld();
      const eid = createBoxEntity(world, 8, 4);
      expect(getBodyHalfWidth(world, eid)).toBe(8);
    });

    it('returns radius for a circle body (circle has no halfWidth)', () => {
      const world = createTestWorld();
      const eid = createCircleEntity(world, 5);
      expect(getBodyHalfWidth(world, eid)).toBe(5);
    });

    it('returns 0 and increments shim counter when Size is not set', () => {
      const world = createTestWorld();
      const eid = createEntity(world);
      expect(getBodyHalfWidth(world, eid, 'test-system')).toBe(0);
      expect(getShimStats().count).toBe(1);
      expect(getShimStats().uniqueEids).toBe(1);
    });

    it('only increments uniqueEids once per eid across multiple calls', () => {
      const world = createTestWorld();
      const eid = createEntity(world);
      getBodyHalfWidth(world, eid);
      getBodyHalfWidth(world, eid);
      expect(getShimStats().count).toBe(2);
      expect(getShimStats().uniqueEids).toBe(1);
    });
  });

  describe('getBodyHalfHeight', () => {
    it('returns halfHeight for a box body', () => {
      const world = createTestWorld();
      const eid = createBoxEntity(world, 8, 4);
      expect(getBodyHalfHeight(world, eid)).toBe(4);
    });

    it('returns radius for a circle body', () => {
      const world = createTestWorld();
      const eid = createCircleEntity(world, 3);
      expect(getBodyHalfHeight(world, eid)).toBe(3);
    });

    it('returns 0 and increments shim counter when Size is not set', () => {
      const world = createTestWorld();
      const eid = createEntity(world);
      expect(getBodyHalfHeight(world, eid, 'test-system')).toBe(0);
      expect(getShimStats().count).toBe(1);
      expect(getShimStats().uniqueEids).toBe(1);
    });
  });

  describe('getBodyRadius', () => {
    it('returns radius for a circle body', () => {
      const world = createTestWorld();
      const eid = createCircleEntity(world, 6);
      expect(getBodyRadius(world, eid)).toBe(6);
    });

    it('returns max(halfWidth, halfHeight) for a box body (bounding radius)', () => {
      const world = createTestWorld();
      const eid = createBoxEntity(world, 10, 4);
      expect(getBodyRadius(world, eid)).toBe(10);
    });

    it('uses halfHeight when it is the larger axis', () => {
      const world = createTestWorld();
      const eid = createBoxEntity(world, 3, 7);
      expect(getBodyRadius(world, eid)).toBe(7);
    });

    it('returns 0 and increments shim counter when Size is not set', () => {
      const world = createTestWorld();
      const eid = createEntity(world);
      expect(getBodyRadius(world, eid, 'test-system')).toBe(0);
      expect(getShimStats().count).toBe(1);
      expect(getShimStats().uniqueEids).toBe(1);
    });
  });

  describe('resetShimStats', () => {
    it('resets count and uniqueEids to zero', () => {
      const world = createTestWorld();
      const eid = createEntity(world);
      getBodyRadius(world, eid);
      expect(getShimStats().count).toBe(1);
      resetShimStats();
      expect(getShimStats().count).toBe(0);
      expect(getShimStats().uniqueEids).toBe(0);
    });
  });
});
