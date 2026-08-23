import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  createFloor1MainSceneOptions,
  createFloorMainSceneOptions,
} from '../../src/bootstrap/floor-main-scene-options.js';
import {
  companionAISystem,
  enemyAISystem,
  emergentEventSystem,
  familyFeudSystem,
  floor1EnemyDirectorSystem,
  floor1PlayerStatSystem,
  floor3WildDirectorSystem,
  initializeFloor1Scenario,
  spawnerArenaSystem,
  spawnerSystem,
} from '../../src/game/index.js';
import {
  familyRelationshipSystem,
  mobAbilitySystem,
  statSystem,
  statusEffectSystem,
} from '../../src/core/index.js';
import { floor2VictorySystem } from '../../src/game/floor2Scenario.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { weaponSystem } from '../../src/game/weaponSystem.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('createFloor1MainSceneOptions', () => {
  it.each([
    {
      floorId: 'floor1',
      beforeWeaponSystems: [floor1PlayerStatSystem],
      beforeEnemyAISystems: [companionAISystem],
      afterSpawnerSystems: [floor1EnemyDirectorSystem],
      foreignSystems: [floor2VictorySystem, emergentEventSystem, familyFeudSystem],
    },
    {
      floorId: 'floor2',
      beforeWeaponSystems: [floor2VictorySystem, emergentEventSystem],
      beforeEnemyAISystems: [companionAISystem, familyFeudSystem],
      afterSpawnerSystems: [],
      foreignSystems: [floor1PlayerStatSystem, floor1EnemyDirectorSystem],
    },
    {
      floorId: 'floor3',
      beforeWeaponSystems: [],
      beforeEnemyAISystems: [companionAISystem],
      afterSpawnerSystems: [floor3WildDirectorSystem],
      foreignSystems: [
        floor1PlayerStatSystem,
        floor1EnemyDirectorSystem,
        floor2VictorySystem,
        emergentEventSystem,
        familyFeudSystem,
      ],
    },
  ])(
    'assembles only $floorId scenario systems at their canonical slots',
    ({
      floorId,
      beforeWeaponSystems,
      beforeEnemyAISystems,
      afterSpawnerSystems,
      foreignSystems,
    }) => {
      // The expected slot contents below are hardcoded independently of
      // scenarioDefinitions.ts, so deleting or misplacing a registration
      // there changes only the assembled preSystems and fails this test.
      const scenario = getScenarioDefinition(floorId);
      expect(scenario.beforeWeaponSystems ?? []).toEqual(beforeWeaponSystems);
      expect(scenario.beforeEnemyAISystems ?? []).toEqual(beforeEnemyAISystems);
      expect(scenario.afterSpawnerSystems ?? []).toEqual(afterSpawnerSystems);

      const preSystems = createFloorMainSceneOptions(floorId).preSystems ?? [];
      const localSystems = [
        ...beforeWeaponSystems,
        ...beforeEnemyAISystems,
        ...afterSpawnerSystems,
      ];
      const sharedSystems = [
        statSystem,
        familyRelationshipSystem,
        weaponSystem,
        enemyAISystem,
        statusEffectSystem,
        mobAbilitySystem,
        spawnerArenaSystem,
        spawnerSystem,
      ];

      for (const system of [...sharedSystems, ...localSystems]) {
        expect(preSystems.filter((entry) => entry === system)).toHaveLength(1);
      }
      for (const system of foreignSystems) {
        expect(preSystems).not.toContain(system);
      }

      expect(
        preSystems.slice(
          preSystems.indexOf(familyRelationshipSystem) + 1,
          preSystems.indexOf(weaponSystem),
        ),
      ).toEqual(beforeWeaponSystems);
      expect(
        preSystems.slice(preSystems.indexOf(weaponSystem) + 1, preSystems.indexOf(enemyAISystem)),
      ).toEqual(beforeEnemyAISystems);
      expect(preSystems.slice(preSystems.indexOf(spawnerSystem) + 1)).toEqual(afterSpawnerSystems);
      expect(preSystems.indexOf(spawnerSystem)).toBe(preSystems.indexOf(spawnerArenaSystem) + 1);
    },
  );

  it('wires every quest-giver meet callback the browser scene relies on', () => {
    const options = createFloor1MainSceneOptions();
    expect(typeof options.tutorialGoon?.meet).toBe('function');
    expect(typeof options.tutorialGoon?.getIndicatorState).toBe('function');
    expect(typeof options.spellQuestGiver?.meet).toBe('function');
    expect(typeof options.spellQuestGiver?.getIndicatorState).toBe('function');
    expect(typeof options.shopkeeper?.meet).toBe('function');
    expect(typeof options.shopkeeper?.getIndicatorState).toBe('function');
    expect(typeof options.shopkeeper?.getPostQuestStock).toBe('function');
    expect(typeof options.shopkeeper?.purchasePostQuestItem).toBe('function');
  });

  it("passes the floor's per-floor ambient lighting default to the scene", () => {
    const options = createFloor1MainSceneOptions();
    expect(options.lightingConfig?.ambient).toBe(0.2);
  });

  it('wires spawnerSystem for floor1 immediately after spawnerArenaSystem', () => {
    // Floor 1 is spawner-free by config (empty static-spawner table in
    // floorScenario.ts), so spawnerSystem is wired uniformly and runs as a
    // harmless no-op rather than being stripped from the Floor 1 pipeline.
    // Lock the spawnerArena → spawner adjacency the preSystems comment relies on.
    const preSystems = createFloor1MainSceneOptions().preSystems ?? [];
    const aiIndex = preSystems.indexOf(enemyAISystem);
    const arenaIndex = preSystems.indexOf(spawnerArenaSystem);
    const spawnerIndex = preSystems.indexOf(spawnerSystem);
    const directorIndex = preSystems.indexOf(floor1EnemyDirectorSystem);

    expect(aiIndex).toBeGreaterThanOrEqual(0);
    expect(arenaIndex).toBeGreaterThanOrEqual(0);
    expect(spawnerIndex).toBeGreaterThanOrEqual(0);
    expect(directorIndex).toBeGreaterThanOrEqual(0);
    expect(aiIndex).toBeLessThan(directorIndex);
    // spawnerArenaSystem must run immediately before spawnerSystem in both pipelines.
    expect(spawnerIndex).toBe(arenaIndex + 1);
  });

  /**
   * Pipeline-parity contract (issue #663).
   *
   * The two divergences that existed before pipeline unification:
   *   1. weaponSystem ran post-movement in headless, pre-movement in visual.
   *   2. floor1EnemyDirectorSystem ran post-core in headless, pre-core in visual.
   *
   * Both must be in preSystems (pre-movement = pre-core) in the canonical
   * definition. Since the headless runner now derives its ordering from
   * createFloorMainSceneOptions(), this single assertion covers both pipelines.
   */
  it('weaponSystem and floor1EnemyDirectorSystem are both in preSystems (pre-movement)', () => {
    const preSystems = createFloor1MainSceneOptions().preSystems ?? [];
    const weaponIdx = preSystems.indexOf(weaponSystem);
    const directorIdx = preSystems.indexOf(floor1EnemyDirectorSystem);

    // Both must be present in preSystems (not post-core / post-movement).
    expect(weaponIdx).toBeGreaterThanOrEqual(0);
    expect(directorIdx).toBeGreaterThanOrEqual(0);
    // spawnerSystem immediately precedes the director (true adjacency, issue #663 comment).
    const spawnerIdx = preSystems.indexOf(spawnerSystem);
    expect(directorIdx).toBe(spawnerIdx + 1);
  });

  it('keeps spawnerSystem wired for floor2+', () => {
    const preSystems = createFloorMainSceneOptions('floor2').preSystems ?? [];
    expect(preSystems.filter((s) => s === spawnerSystem)).toHaveLength(1);
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
    options.spellQuestGiver?.meet(world);

    expect(world.questLog.has(FLOOR1_BOSS_BATTLE_QUEST_ID)).toBe(true);
  });

  it('wires onFloor1Cleared for floor1 to enable floor 1→2 transition', () => {
    const options = createFloor1MainSceneOptions();
    expect(typeof options.onFloor1Cleared).toBe('function');
  });

  it('does not wire onFloor1Cleared for floor2', () => {
    const options = createFloorMainSceneOptions('floor2');
    expect(options.onFloor1Cleared).toBeUndefined();
  });

  it("injects each scenario's presentation contract so the scene never branches on floor identity", () => {
    // Regression guard: the contract shipped once as an injected-but-unread
    // field, which left the engine's Floor 1/Floor 2 branches alive. Every
    // surface the scene renders must be reachable from these options.
    for (const floorId of ['floor1', 'floor2', 'floor3'] as const) {
      const options = createFloorMainSceneOptions(floorId);
      const scenario = getScenarioDefinition(floorId);
      const presentation = options.scenarioPresentation;

      expect(presentation).toBeDefined();
      expect(presentation!.director).toBe(scenario.director);
      expect(presentation!.getRunOutcome).toBe(scenario.getRunOutcome);
      expect(presentation!.getCompletionCopy).toBe(scenario.getCompletionCopy);
      expect(presentation!.getStairMarkerState).toBe(scenario.getStairMarkerState);
      expect(presentation!.stairConfirmation).toBe(scenario.stairConfirmation);
      expect(presentation!.nextFloorId).toBe(scenario.nextFloorId);
    }

    // A transition-capable floor must advertise a next floor, since the scene
    // selects its completion variant from that field plus the callback.
    const floor1Options = createFloorMainSceneOptions('floor1');
    expect(floor1Options.scenarioPresentation!.nextFloorId).toBeDefined();
    expect(typeof floor1Options.onFloor1Cleared).toBe('function');
  });

  it('routes NPC and stair callbacks from the scenario definition, not a floor branch', () => {
    const floor1 = createFloorMainSceneOptions('floor1');
    const floor2 = createFloorMainSceneOptions('floor2');

    // Floor 1 owns the quest-giver trio and no broker; Floor 2 is the inverse.
    expect(floor1.broker).toBeUndefined();
    expect(typeof floor2.broker?.met).toBe('function');
    expect(floor2.shopkeeper).toBeUndefined();
    expect(floor2.tutorialGoon).toBeUndefined();
    expect(floor2.spellQuestGiver).toBeUndefined();

    // Both floors declare their own stair-descend confirmation.
    expect(typeof floor1.onStairDescend).toBe('function');
    expect(typeof floor2.onStairDescend).toBe('function');
    expect(floor1.onStairDescend).not.toBe(floor2.onStairDescend);
  });
});
