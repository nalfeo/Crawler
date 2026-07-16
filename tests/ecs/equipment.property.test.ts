import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addEntity } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  initializeBaseStats,
  equip,
  unequip,
  getEffectiveStats,
  getEquipmentState,
} from '../../src/core/systems/equipmentSystem.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import {
  ALL_STAT_IDS,
  STAT_CLAMPS,
  DEFAULT_BASE_STATS,
  PRIMARY_STATS,
  CORE_STAT_TO_SECONDARY,
} from '../../src/shared/stats.js';
import type { StatId, SecondaryStatId } from '../../src/shared/stats.js';
import type { EquipmentItemDef, ItemRarity } from '../../src/shared/equipment-types.js';

const SLOT_IDS = SLOT_REGISTRY.map((s) => s.id);
const RARITIES: ItemRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// Arbitrary for a valid single-slot item
const arbItem: fc.Arbitrary<EquipmentItemDef> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  name: fc.string({ minLength: 1, maxLength: 16 }),
  slots: fc
    .uniqueArray(fc.constantFrom(...SLOT_IDS), { minLength: 1, maxLength: 3 })
    .map((s) => [...s]),
  statBonuses: fc
    .dictionary(fc.constantFrom(...ALL_STAT_IDS), fc.integer({ min: -10, max: 10 }))
    .map((d) => d as Partial<Record<StatId, number>>),
  weightLb: fc.constant(0),
  rarity: fc.constantFrom(...RARITIES),
  weightLb: fc.float({ min: 0, max: 50, noNaN: true }),
});

describe('Equipment System — Property Tests', () => {
  it('equipped item count never exceeds slot count', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 0, maxLength: 20 }), (items) => {
        const world = createTestWorld();
        world.state = 'safe_room';
        const eid = addEntity(world.ecs);
        initializeBaseStats(world, eid);

        for (const item of items) {
          equip(world, eid, item, { force: true });
        }

        const state = getEquipmentState(world, eid);
        if (!state) return true;
        const equipped = Object.values(state.equipped).filter((v) => v !== null);
        return equipped.length <= SLOT_IDS.length;
      }),
      { numRuns: 100 },
    );
  });

  it('effective stats = base + equipment bonuses (clamped)', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 1, maxLength: 8 }), (items) => {
        const world = createTestWorld();
        world.state = 'safe_room';
        const eid = addEntity(world.ecs);
        initializeBaseStats(world, eid);

        for (const item of items) {
          equip(world, eid, item, { force: true });
        }

        const state = getEquipmentState(world, eid)!;
        const effective = getEffectiveStats(world, eid);

        // Manually compute expected: base + equipment, then derive secondaries
        // from the (post-equipment) effective primaries, then clamp — mirroring
        // applyEffectiveStats. (coreStatPoints is 0 for a fresh entity.)
        const expected = { ...DEFAULT_BASE_STATS } as Record<StatId, number>;
        const seenInstances = new Set<number>();
        for (const slotId of Object.keys(state.equipped)) {
          const instId = state.equipped[slotId] ?? null;
          if (instId === null || seenInstances.has(instId)) continue;
          seenInstances.add(instId);
          const inst = state.instances.get(instId);
          if (!inst) continue;
          for (const [stat, bonus] of Object.entries(inst.def.statBonuses)) {
            if (typeof bonus === 'number' && ALL_STAT_IDS.includes(stat as StatId)) {
              expected[stat as StatId] = (expected[stat as StatId] || 0) + bonus;
            }
          }
        }

        // Derive secondaries from the effective primaries.
        for (const p of PRIMARY_STATS) {
          const derived = CORE_STAT_TO_SECONDARY[p];
          for (const [secondary, rate] of Object.entries(derived) as [SecondaryStatId, number][]) {
            expected[secondary] = (expected[secondary] ?? 0) + expected[p] * rate;
          }
        }

        // Clamp expected
        for (const statId of ALL_STAT_IDS) {
          const clamp = STAT_CLAMPS[statId];
          if (clamp.min !== undefined) expected[statId] = Math.max(clamp.min, expected[statId]);
          if (clamp.max !== undefined) expected[statId] = Math.min(clamp.max, expected[statId]);
        }

        // Compare with Float32 tolerance
        for (const statId of ALL_STAT_IDS) {
          expect(effective[statId]).toBeCloseTo(expected[statId], 4);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('equip then unequip returns effective stats to base', () => {
    fc.assert(
      fc.property(arbItem, (item) => {
        const world = createTestWorld();
        world.state = 'safe_room';
        const eid = addEntity(world.ecs);
        initializeBaseStats(world, eid);

        const baseBefore = getEffectiveStats(world, eid);
        const result = equip(world, eid, item, { force: true });
        if (result.ok) {
          // Find any slot this item occupies
          const slotId = item.slots[0];
          if (slotId) unequip(world, eid, slotId, { force: true });
        }
        const baseAfter = getEffectiveStats(world, eid);

        for (const statId of ALL_STAT_IDS) {
          expect(baseAfter[statId]).toBeCloseTo(baseBefore[statId], 4);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('stat values respect clamp ranges', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { minLength: 1, maxLength: 10 }), (items) => {
        const world = createTestWorld();
        world.state = 'safe_room';
        const eid = addEntity(world.ecs);
        initializeBaseStats(world, eid);

        for (const item of items) {
          equip(world, eid, item, { force: true });
        }

        const stats = getEffectiveStats(world, eid);
        for (const statId of ALL_STAT_IDS) {
          const clamp = STAT_CLAMPS[statId];
          if (clamp.min !== undefined) {
            expect(stats[statId]).toBeGreaterThanOrEqual(clamp.min - 0.001);
          }
          if (clamp.max !== undefined) {
            expect(stats[statId]).toBeLessThanOrEqual(clamp.max + 0.001);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
