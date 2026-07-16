import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { addComponent, set } from 'bitecs';
import { Health, Invincible } from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { createEntity } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Property-based invariants for the damage choke point. Targets are bare
 * Health-only entities (no Player / EffectiveStats / DeathTimer), so the crit
 * and dodge branches are skipped and behaviour stays roll-free and
 * deterministic. HP values are kept as small integers so Float-backed stores
 * round-trip exactly.
 */

const hp = () => fc.integer({ min: 0, max: 100_000 });

/** Spawn a fresh world + bare Health entity for each property run. */
function withTarget(current: number): { world: ReturnType<typeof createTestWorld>; eid: number } {
  const world = createTestWorld();
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Health, { current, max: Math.max(current, 1) }));
  return { world, eid };
}

describe('applyDamage invariants (property-based)', () => {
  it('finite damage: dealt === clamp, HP floors at 0, and accounting is exact', () => {
    fc.assert(
      fc.property(hp(), fc.integer({ min: -500, max: 100_000 }), (current, amount) => {
        const { world, eid } = withTarget(current);

        const dealt = applyDamage(world, eid, amount, 0, 0, DEFAULT_DAMAGE_OPTIONS);
        const after = world.stores.health.current[eid] ?? 0;

        const expectedDealt = amount > 0 ? Math.min(current, amount) : 0;
        expect(dealt).toBe(expectedDealt);
        expect(dealt).toBeGreaterThanOrEqual(0);
        expect(after).toBe(current - expectedDealt);
        expect(after).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('non-finite amounts (NaN / ±Infinity) are no-ops', () => {
    fc.assert(
      fc.property(
        hp(),
        fc.constantFrom(NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (current, amount) => {
          const { world, eid } = withTarget(current);

          const dealt = applyDamage(world, eid, amount, 0, 0, DEFAULT_DAMAGE_OPTIONS);

          expect(dealt).toBe(0);
          expect(world.stores.health.current[eid]).toBe(current);
          expect(world.combatEvents).toHaveLength(0);
        },
      ),
    );
  });

  it('an Invincible target never takes damage', () => {
    fc.assert(
      fc.property(hp(), fc.integer({ min: 1, max: 100_000 }), (current, amount) => {
        const { world, eid } = withTarget(current);
        addComponent(world.ecs, eid, Invincible);

        const dealt = applyDamage(world, eid, amount, 0, 0, DEFAULT_DAMAGE_OPTIONS);

        expect(dealt).toBe(0);
        expect(world.stores.health.current[eid]).toBe(current);
      }),
    );
  });

  it('a positive hit emits at most one combat event, carrying the dealt amount', () => {
    fc.assert(
      fc.property(hp(), fc.integer({ min: 1, max: 100_000 }), (current, amount) => {
        const { world, eid } = withTarget(current);

        const dealt = applyDamage(world, eid, amount, 3, 4, DEFAULT_DAMAGE_OPTIONS);

        // An event is emitted iff some damage actually landed.
        if (dealt > 0) {
          expect(world.combatEvents).toHaveLength(1);
          expect(world.combatEvents[0]).toMatchObject({
            type: 'hit',
            amount: dealt,
            targetEid: eid,
          });
        } else {
          expect(world.combatEvents).toHaveLength(0);
        }
      }),
    );
  });
});
