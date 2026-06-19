import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { isQuestComplete } from '../../src/core/systems/questSystem.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import { xpRequiredForLevel } from '../../src/shared/xpMath.js';
import { createTestWorld } from '../helpers/world-factory.js';

const STEP_MS = GAME.DELTA_MS;
const FLOOR1_OPTS = { enableFloor1: true } as const;

/** Build a Floor 1 world the same way the headless runner does. */
function setupFloor1World(seed: number) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 400, 400);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return { world, player };
}

/**
 * Regression guard for the headless `level_up` starvation bug.
 *
 * `levelSystem` sets `world.state = 'level_up'` on every level-up as a flag for
 * the UI allocation screen. The visual game (MainGameScene) clears it back to
 * `'playing'` every frame because Floor 1 exposes no stat-allocation UI. The
 * headless `runSimulationStep` originally did NOT, so after the first level-up
 * the world parked in `level_up` forever — starving every `state === 'playing'`
 * gated system (notably `floor1ObjectiveTick`), so "reach level 2" never latched
 * and the tutorial quest never completed even though XP kept climbing.
 *
 * These tests exercise the FULL pipeline (so `levelSystem` actually fires),
 * which the existing floor1-scenario tests do not — they set `playerLevel.level`
 * directly while already in `'playing'` and call the floor systems by hand.
 */
describe('runSimulationStep — level_up must not park the headless Floor 1 sim', () => {
  it('starts in the playing state after Floor 1 setup', () => {
    const { world } = setupFloor1World(42);
    expect(world.state).toBe('playing');
  });

  it('clears a pre-existing level_up flag on the next step', () => {
    const { world } = setupFloor1World(42);
    // Simulate having parked in level_up (Floor 1 has no allocation UI).
    world.state = 'level_up';

    runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);

    expect(world.state).toBe('playing');
  });

  it('returns to playing the same step a level-up fires, and latches reach-level-2', () => {
    const { world } = setupFloor1World(42);
    expect(world.playerLevel.level).toBeLessThan(2);

    // Pre-load enough XP that levelSystem advances to level 2 this step.
    world.playerLevel.xp = xpRequiredForLevel(2);
    runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);

    expect(world.playerLevel.level).toBeGreaterThanOrEqual(2);
    // The regression: without the level_up -> playing reset the world would be
    // stuck in 'level_up' and floor1ObjectiveTick would never run this step.
    expect(world.state).toBe('playing');
    expect(world.goalFlags.get('floor1-reach-level-2')).toBe(true);
  });

  it('completes the Floor 1 tutorial quest through the full pipeline once level >= 2', () => {
    const { world } = setupFloor1World(42);
    // Accept the tutorial quest the legitimate way — the same entry point the AI
    // uses when it talks to the Tutorial Goon (no proximity or flag cheat).
    meetTutorialGoon(world);
    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(false);

    world.playerLevel.xp = xpRequiredForLevel(2);
    // A few steps so floorObjectiveSystem -> questSystem can latch + complete.
    for (let i = 0; i < 3; i += 1) {
      runSimulationStep(world, createInputState(), STEP_MS, FLOOR1_OPTS);
    }

    expect(world.playerLevel.level).toBeGreaterThanOrEqual(2);
    expect(world.state).toBe('playing');
    expect(isQuestComplete(world, FLOOR1_TUTORIAL_QUEST_ID)).toBe(true);
  });
});
