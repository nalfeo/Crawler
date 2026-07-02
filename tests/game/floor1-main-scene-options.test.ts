import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  initializeFloor1Scenario,
  spawnerSystem,
} from '../../src/game/index.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('createFloor1MainSceneOptions', () => {
  it('wires every quest-giver meet callback the browser scene relies on', () => {
    const options = createFloor1MainSceneOptions();
    expect(typeof options.tutorialGoon.meet).toBe('function');
    expect(typeof options.tutorialGoon.getIndicatorState).toBe('function');
    expect(typeof options.spellQuestGiver.meet).toBe('function');
    expect(typeof options.spellQuestGiver.getIndicatorState).toBe('function');
    expect(typeof options.shopkeeper.meet).toBe('function');
    expect(typeof options.shopkeeper.getIndicatorState).toBe('function');
    expect(typeof options.shopkeeper.getPostQuestStock).toBe('function');
    expect(typeof options.shopkeeper.purchasePostQuestItem).toBe('function');
  });

  it("passes the floor's per-floor ambient lighting default to the scene", () => {
    const options = createFloor1MainSceneOptions();
    expect(options.lightingConfig?.ambient).toBe(0.2);
  });

  it('runs spawnerSystem exactly once, immediately before floor1EnemyDirectorSystem', () => {
    // Ordering contract (VISUAL pipeline): the Floor 1 enemy director counts living
    // Enemy entities that lack the Spawner component (i.e. spawner-owned children)
    // when deciding how much ambient pressure to top up. spawnerSystem must run
    // BEFORE floor1EnemyDirectorSystem so the director caps against this frame's
    // children instead of over-populating on top of them. In the visual preSystems
    // array we keep them IMMEDIATELY ADJACENT so nothing can slip between them.
    //
    // The headless gate pipeline (src/game/ai/simulation-step.ts) guarantees only
    // the weaker "spawner before director" ordering -- there spawnerSystem runs
    // pre-movement and the director runs post-core, so they are NOT adjacent (the
    // director's absolute position differs between the two hand-maintained
    // pipelines, a tracked approximation, issue #663). Both pipelines' spawn->cap
    // behavior is covered by tests/integration/floor1-spawners-pipeline.test.ts.
    const preSystems = createFloor1MainSceneOptions().preSystems ?? [];
    const aiIndex = preSystems.indexOf(enemyAISystem);
    const spawnerIndex = preSystems.indexOf(spawnerSystem);
    const directorIndex = preSystems.indexOf(floor1EnemyDirectorSystem);

    expect(aiIndex).toBeGreaterThanOrEqual(0);
    expect(spawnerIndex).toBeGreaterThanOrEqual(0);
    expect(directorIndex).toBeGreaterThanOrEqual(0);
    // Each system appears exactly once (no accidental duplicate wiring).
    expect(preSystems.filter((s) => s === spawnerSystem)).toHaveLength(1);
    expect(preSystems.filter((s) => s === floor1EnemyDirectorSystem)).toHaveLength(1);
    expect(aiIndex).toBeLessThan(spawnerIndex);
    // Immediate adjacency: nothing runs between the spawner and the director.
    expect(directorIndex).toBe(spawnerIndex + 1);
  });

  it('accepts the boss-battle quest when the Spell Broker is met through the scene options', () => {
    const options = createFloor1MainSceneOptions();
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    expect(world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)).toBe(false);

    // The Spell Broker only offers the quest once the welcome Goon quest is done.
    world.playerLevel.level = 2;
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    options.spellQuestGiver.meet(world);

    expect(world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)).toBe(true);
  });
});
