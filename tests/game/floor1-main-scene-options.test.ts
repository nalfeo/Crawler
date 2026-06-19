import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor1-main-scene-options.js';
import { initializeFloor1Scenario } from '../../src/game/floor1Scenario.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('createFloor1MainSceneOptions', () => {
  it('wires every quest-giver meet callback the browser scene relies on', () => {
    const options = createFloor1MainSceneOptions();
    expect(typeof options.tutorialGoon.meet).toBe('function');
    expect(typeof options.spellQuestGiver.meet).toBe('function');
    expect(typeof options.shopkeeper.meet).toBe('function');
  });

  it('accepts the boss-battle quest when the Spell Broker is met through the scene options', () => {
    const options = createFloor1MainSceneOptions();
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    expect(world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)).toBe(false);

    options.spellQuestGiver.meet(world);

    expect(world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)).toBe(true);
  });
});
