import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELATION,
  adjustFactionRelation,
  asFamilyId,
  familyRelationshipSystem,
  getRelation,
  initializeFactionRelations,
  queueFactionRelationDelta,
} from '../../src/core/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * ECS coverage for `familyRelationshipSystem` (a `src/core` system, so it is
 * tested here under `tests/ecs/` per the tests-layer convention):
 *   - delta-drain semantics
 *   - passive decay toward the default relation (injectable rate, world-scoped
 *     timing)
 */

const goblins = asFamilyId('goblins');
const llamas = asFamilyId('llamas');

describe('familyRelationshipSystem drain semantics', () => {
  it('applies queued deltas via adjustFactionRelation and clears the queue', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins, llamas]);
    queueFactionRelationDelta(world, { familyId: goblins, delta: 10, reason: 'test' });
    queueFactionRelationDelta(world, { familyId: llamas, delta: -20, reason: 'test' });

    familyRelationshipSystem(world);

    expect(world.factionRelationDeltas).toHaveLength(0);
    expect(getRelation(world, goblins)).toBe(55);
    expect(getRelation(world, llamas)).toBe(25);
    // Two events emitted, one per applied delta.
    expect(world.factionRelationEvents.filter((e) => e.familyId === goblins)).toHaveLength(1);
    expect(world.factionRelationEvents.filter((e) => e.familyId === llamas)).toHaveLength(1);
  });

  it('is a noop when nothing is queued', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    const before = getRelation(world, goblins);
    familyRelationshipSystem(world);
    expect(getRelation(world, goblins)).toBe(before);
    expect(world.factionRelationEvents).toHaveLength(0);
  });
});

describe('familyRelationshipSystem passive decay', () => {
  it('drifts relations toward the default in both directions with an injected rate', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins, llamas]);
    adjustFactionRelation(world, goblins, 20); // 45 -> 65 (above default)
    adjustFactionRelation(world, llamas, -20); // 45 -> 25 (below default)
    world.factionRelationEvents.length = 0;

    // 1 second elapses; decay 5 points/sec toward DEFAULT_RELATION (45).
    world.factionRelationDecayLastMs = 0;
    world.elapsedMs = 1000;
    familyRelationshipSystem(world, { passiveDecayPerSecond: 5 });

    expect(getRelation(world, goblins)).toBe(60); // 65 - 5
    expect(getRelation(world, llamas)).toBe(30); // 25 + 5
    // Timing is tracked on the world, not a module-level map.
    expect(world.factionRelationDecayLastMs).toBe(1000);
    // Decay routes through adjustFactionRelation, so it emits change events.
    expect(world.factionRelationEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('never overshoots the default relation', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    adjustFactionRelation(world, goblins, 5); // 45 -> 50

    world.factionRelationDecayLastMs = 0;
    world.elapsedMs = 1000;
    // A huge rate would blow past the target if unclamped.
    familyRelationshipSystem(world, { passiveDecayPerSecond: 1000 });

    expect(getRelation(world, goblins)).toBe(DEFAULT_RELATION);
  });

  it('leaves a family already at the default untouched (no event)', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]); // seeded at DEFAULT_RELATION
    world.factionRelationEvents.length = 0;

    world.factionRelationDecayLastMs = 0;
    world.elapsedMs = 1000;
    familyRelationshipSystem(world, { passiveDecayPerSecond: 5 });

    expect(getRelation(world, goblins)).toBe(DEFAULT_RELATION);
    expect(world.factionRelationEvents).toHaveLength(0);
  });

  it('does not decay when the rate defaults to the (zero) tuning value', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    adjustFactionRelation(world, goblins, 20); // 45 -> 65

    world.elapsedMs = 5000;
    familyRelationshipSystem(world); // no options → tuning default (0)

    expect(getRelation(world, goblins)).toBe(65);
    // Decay branch never ran, so it never stamped the world timing field.
    expect(world.factionRelationDecayLastMs).toBeNull();
  });

  it('applies no decay on the first observed tick (dt = 0)', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    adjustFactionRelation(world, goblins, 20); // 45 -> 65

    // Fresh world: factionRelationDecayLastMs is null, so prev == now → dt 0.
    world.elapsedMs = 1000;
    familyRelationshipSystem(world, { passiveDecayPerSecond: 5 });

    expect(getRelation(world, goblins)).toBe(65);
    expect(world.factionRelationDecayLastMs).toBe(1000);
  });
});

describe('familyRelationshipSystem locked state (reputationSystemActive = false)', () => {
  it('discards queued deltas without changing relations or emitting events', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins, llamas]);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [goblins, llamas],
        contestedResource: 'test-resource' as never,
        betrayerFlag: false,
        reputationSystemActive: false,
      },
    };

    queueFactionRelationDelta(world, { familyId: goblins, delta: 10, reason: 'test' });
    queueFactionRelationDelta(world, { familyId: llamas, delta: -20, reason: 'test' });

    const goblinsBefore = getRelation(world, goblins);
    const llamasBefore = getRelation(world, llamas);

    familyRelationshipSystem(world);

    // Deltas are discarded — queue is cleared.
    expect(world.factionRelationDeltas).toHaveLength(0);
    // Relations are unchanged.
    expect(getRelation(world, goblins)).toBe(goblinsBefore);
    expect(getRelation(world, llamas)).toBe(llamasBefore);
    // No events emitted.
    expect(world.factionRelationEvents).toHaveLength(0);
  });

  it('skips passive decay and does not advance the decay timestamp', () => {
    const world = createTestWorld();
    initializeFactionRelations(world, [goblins]);
    adjustFactionRelation(world, goblins, 20); // 45 -> 65
    world.factionRelationEvents.length = 0;

    world.floorExtendedState = {
      familyState: {
        presentFamilies: [goblins],
        contestedResource: 'test-resource' as never,
        betrayerFlag: false,
        reputationSystemActive: false,
      },
    };

    world.factionRelationDecayLastMs = 0;
    world.elapsedMs = 1000;

    familyRelationshipSystem(world, { passiveDecayPerSecond: 5 });

    // Relation unchanged — decay branch never ran.
    expect(getRelation(world, goblins)).toBe(65);
    // Timestamp is NOT advanced because the system returned early.
    expect(world.factionRelationDecayLastMs).toBe(0);
    // No events emitted.
    expect(world.factionRelationEvents).toHaveLength(0);
  });
});
