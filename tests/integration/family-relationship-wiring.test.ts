import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { runSimulationStep as runVisualStep } from '../../src/engine/sim/simulation-step.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  adjustFactionRelation,
  asFamilyId,
  initializeFactionRelations,
  queueFactionRelationDelta,
  DEFAULT_RELATION,
} from '../../src/core/faction-relations.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Runtime-observation proof that `familyRelationshipSystem` is actually invoked
 * by BOTH real pipelines — the headless Floor-1 win-rate gate
 * (`src/game/ai/simulation-step.ts`) and the visual pipeline
 * (`src/engine/sim/simulation-step.ts` + `preSystems` from
 * `src/bootstrap/floor-main-scene-options.ts`).
 *
 * This is the "observe before done" evidence per rule #10 that the system is
 * NOT lab-only: a queued delta gets applied by the pipeline itself with no
 * direct `familyRelationshipSystem(world)` call in the test body.
 */

const goblins = asFamilyId('goblins');

describe('familyRelationshipSystem is wired into the headless pipeline', () => {
  it('drains queued deltas during a headless Floor 1 tick', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    initializeFactionRelations(world, [goblins]);
    queueFactionRelationDelta(world, { familyId: goblins, delta: 10, reason: 'wiring proof' });

    expect(world.factionRelationDeltas).toHaveLength(1);
    runHeadlessStep(world, createInputState(), 16, { enableFloor1: true });
    expect(world.factionRelationDeltas).toHaveLength(0);
    expect(world.factionRelations.get(goblins)).toBe(DEFAULT_RELATION + 10);
  });
});

describe('familyRelationshipSystem is wired into the visual pipeline', () => {
  it('drains queued deltas during a visual pipeline tick via preSystems', () => {
    const options = createFloor1MainSceneOptions();
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    initializeFactionRelations(world, [goblins]);
    // Bump past the default first so both a positive and a negative delta land
    // in the same visual tick, proving the drain runs, not the classic
    // "empty queue -> vacuously true" branch.
    adjustFactionRelation(world, goblins, 20); // baseline 45 -> 65
    queueFactionRelationDelta(world, { familyId: goblins, delta: -15, reason: 'visual proof' });

    runVisualStep(world, createInputState(), { preSystems: options.preSystems });
    expect(world.factionRelationDeltas).toHaveLength(0);
    expect(world.factionRelations.get(goblins)).toBe(50);
  });
});
