/**
 * Harvest System unit tests.
 *
 * Tests cover: proximity detection, progress accumulation, harvest completion
 * (item added + entity removed), progress reset on leaving range, and
 * independence of multiple simultaneous nodes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { entityExists, query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer, spawnHarvestableNode } from '../../src/core/helpers.js';
import { harvestSystem, HARVEST_RANGE_FT } from '../../src/core/systems/harvestSystem.js';
import { Harvestable } from '../../src/core/components.js';
import { getItemCount } from '../../src/shared/inventory.js';
import { getItemById } from '../../src/shared/items.js';
import {
  HARVESTABLE_DEFS,
  FLOOR2_HARVESTABLE_START_INDEX,
} from '../../src/shared/harvestableDefs.js';
import { GAME } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/world.js';

// Helper: advance N fixed-step ticks.
function tick(world: GameWorld, n = 1): void {
  for (let i = 0; i < n; i++) {
    harvestSystem(world);
  }
}

// Helper: ticks needed to complete harvesting def 0 (3000ms / DELTA_MS).
function ticksForDef(defIndex: number): number {
  const def = HARVESTABLE_DEFS[defIndex]!;
  return Math.ceil(def.durationMs / GAME.DELTA_MS);
}

describe('harvestSystem', () => {
  let world: GameWorld;
  let playerEid: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    playerEid = spawnPlayer(world, 0, 0);
  });

  it('nodes start with zero progress', () => {
    const eid = spawnHarvestableNode(world, 0, 0, 0);
    expect(world.stores.harvestable.progressMs[eid]).toBe(0);
    expect(world.stores.harvestable.harvesterEid[eid]).toBe(0);
  });

  it('increments progress while player is on the node', () => {
    const eid = spawnHarvestableNode(world, 0, 0, 0);
    tick(world);
    expect(world.stores.harvestable.progressMs[eid]).toBeGreaterThan(0);
    expect(world.stores.harvestable.harvesterEid[eid]).toBe(playerEid);
  });

  it('increments progress by GAME.DELTA_MS per tick', () => {
    const eid = spawnHarvestableNode(world, 0, 0, 0);
    tick(world, 3);
    expect(world.stores.harvestable.progressMs[eid]).toBeCloseTo(GAME.DELTA_MS * 3, 5);
  });

  it('accepts player at exactly HARVEST_RANGE_FT distance', () => {
    // Place player exactly at the harvest range boundary.
    world.stores.position.x[playerEid] = HARVEST_RANGE_FT;
    world.stores.position.y[playerEid] = 0;
    const eid = spawnHarvestableNode(world, 0, 0, 0);
    tick(world);
    // At exactly HARVEST_RANGE_FT distance the condition is distSq ≤ range²,
    // which should pass at the boundary point.
    expect(world.stores.harvestable.progressMs[eid]).toBeGreaterThan(0);
  });

  it('does NOT harvest when player is out of range', () => {
    const eid = spawnHarvestableNode(world, HARVEST_RANGE_FT * 2, 0, 0);
    tick(world, 5);
    expect(world.stores.harvestable.progressMs[eid]).toBe(0);
  });

  it('resets progress when player moves away', () => {
    const eid = spawnHarvestableNode(world, 0, 0, 0);
    // Start harvesting.
    tick(world, 2);
    expect(world.stores.harvestable.progressMs[eid]).toBeGreaterThan(0);

    // Move player far away.
    world.stores.position.x[playerEid] = 100;
    tick(world);
    expect(world.stores.harvestable.progressMs[eid]).toBe(0);
    expect(world.stores.harvestable.harvesterEid[eid]).toBe(0);
  });

  it('completes harvest: adds item to inventory and removes entity', () => {
    const defIndex = 0;
    const def = HARVESTABLE_DEFS[defIndex]!;
    const eid = spawnHarvestableNode(world, 0, 0, defIndex);
    const neededTicks = ticksForDef(defIndex);

    tick(world, neededTicks);

    // Entity should be gone.
    expect(entityExists(world.ecs, eid)).toBe(false);

    // Item should be in inventory.
    const bag = world.inventories.get(playerEid);
    expect(bag).toBeDefined();
    const count = getItemCount(bag!, def.itemId);
    expect(count).toBe(1);
  });

  it('emits a pickupSparkle VFX event on harvest completion', () => {
    const defIndex = 0;
    spawnHarvestableNode(world, 0, 0, defIndex);
    const neededTicks = ticksForDef(defIndex);
    tick(world, neededTicks);
    const sparkles = world.vfxEvents.filter((e) => e.kind === 'pickupSparkle');
    expect(sparkles.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a material-gain floater on harvest completion', () => {
    const defIndex = 0;
    const def = HARVESTABLE_DEFS[defIndex]!;
    const itemDef = getItemById(def.itemId);
    expect(itemDef).toBeDefined();
    spawnHarvestableNode(world, 0, 0, defIndex);
    tick(world, ticksForDef(defIndex));

    expect(world.floaterEvents).toHaveLength(1);
    expect(world.floaterEvents[0]).toMatchObject({
      kind: 'materialGain',
      x: 0,
      y: 0,
      label: `+1 ${itemDef!.name}`,
    });
  });

  it('handles multiple independent nodes without interference', () => {
    const eid0 = spawnHarvestableNode(world, 0, 0, 0);
    const eid1 = spawnHarvestableNode(world, 100, 0, 1); // far away

    tick(world, 5);

    // Node 0 should have progress; node 1 should not.
    expect(world.stores.harvestable.progressMs[eid0]).toBeGreaterThan(0);
    expect(world.stores.harvestable.progressMs[eid1]).toBe(0);
  });

  it('does nothing when there is no player entity', () => {
    // Spawn a node but no player — harvestSystem should exit gracefully.
    const world2 = createTestWorld({ seed: 99 });
    const eid = spawnHarvestableNode(world2, 0, 0, 0);
    expect(() => tick(world2)).not.toThrow();
    expect(world2.stores.harvestable.progressMs[eid]).toBe(0);
  });

  it('can harvest all 6 floor-1 node types', () => {
    for (let i = 0; i < FLOOR2_HARVESTABLE_START_INDEX; i++) {
      const def = HARVESTABLE_DEFS[i]!;
      const w = createTestWorld({ seed: i + 1 });
      const pEid = spawnPlayer(w, 0, 0);
      const eid = spawnHarvestableNode(w, 0, 0, i);
      const neededTicks = Math.ceil(def.durationMs / GAME.DELTA_MS);

      for (let t = 0; t < neededTicks; t++) {
        harvestSystem(w);
      }

      expect(entityExists(w.ecs, eid)).toBe(false);
      const bag = w.inventories.get(pEid)!;
      expect(getItemCount(bag, def.itemId)).toBe(1);
    }
  });

  it('can harvest all floor-2 node types (iron-vein, copper-seam, gem-cluster)', () => {
    // gem-cluster has durationMs=7000 which due to Float32 accumulation needs
    // Math.ceil(durationMs/DELTA_MS)+1 ticks. Use the same +1 buffer for all
    // Floor 2 defs to be safe.
    for (let i = FLOOR2_HARVESTABLE_START_INDEX; i < HARVESTABLE_DEFS.length; i++) {
      const def = HARVESTABLE_DEFS[i]!;
      const w = createTestWorld({ seed: i + 1 });
      const pEid = spawnPlayer(w, 0, 0);
      const eid = spawnHarvestableNode(w, 0, 0, i);
      // +1 tick buffer accounts for Float32 accumulation rounding in progressMs.
      const neededTicks = Math.ceil(def.durationMs / GAME.DELTA_MS) + 1;

      for (let t = 0; t < neededTicks; t++) {
        harvestSystem(w);
      }

      expect(entityExists(w.ecs, eid)).toBe(false);
      const bag = w.inventories.get(pEid)!;
      expect(getItemCount(bag, def.itemId)).toBe(1);
    }
  });

  it('Harvestable query returns zero after all nodes are harvested', () => {
    const defIndex = 0;
    spawnHarvestableNode(world, 0, 0, defIndex);
    const neededTicks = ticksForDef(defIndex);
    tick(world, neededTicks);

    const remaining = query(world.ecs, [Harvestable]);
    expect(remaining.length).toBe(0);
  });
});
