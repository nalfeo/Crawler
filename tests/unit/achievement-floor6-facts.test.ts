import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  collectCurrentFloorAchievementFacts,
  evaluateAchievementUnlocksForPhase,
} from '../../src/game/systems/achievementSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

function initFloor6World() {
  const world = createTestWorld({ seed: 606 });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld?.(world, player);
  const defense = world.floorExtendedState?.floor6Defense;
  if (!defense) throw new Error('Floor 6 defense state missing');
  return { world, defense };
}

describe('Floor 6 achievement facts', () => {
  it('derives measured Floor 6 facts from goal flags and terminal state', () => {
    const { world, defense } = initFloor6World();

    for (const goalId of [
      'floor6.defense.briefed',
      'floor6.defense.firstWaveCleared',
      'floor6.defense.firstBuildPlaced',
      'floor6.defense.firstUpgradeChosen',
      'floor6.defense.breakCleared',
      'floor6.defense.deadlineDefeated',
      'floor6.defense.relaySecured',
    ]) {
      world.goalFlags.set(goalId, true);
    }
    defense.terminalOutcome = 'victory';
    defense.exit.opened = true;
    defense.exit.confirmed = true;

    const facts = collectCurrentFloorAchievementFacts(world);

    expect(facts.booleanFacts).toMatchObject({
      floor6RelayBriefed: true,
      floor6FirstWaveCleared: true,
      floor6FirstBuildPlaced: true,
      floor6FirstUpgradeChosen: true,
      floor6BreakCleared: true,
      floor6DeadlineDefeated: true,
      floor6RelaySecured: true,
      runClearedFloor: true,
    });
    expect(facts.numberFacts.clearedFloorCount).toBe(1);
    expect(facts.clearedFloorIds).toEqual([6]);
  });

  it('does not unlock the final Relay-secured achievement without terminal victory', () => {
    const { world, defense } = initFloor6World();

    world.goalFlags.set('floor6.defense.relaySecured', true);
    defense.terminalOutcome = 'defeat';
    defense.exit.opened = false;

    evaluateAchievementUnlocksForPhase(world, 'tick');

    expect(world.achievements.unlockedIds.has('floor6-relay-secured')).toBe(false);
  });
});
