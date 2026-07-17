import { abilitySystem, levelSystem, skillSystem, spendPoints } from '../game/systems/index.js';
import {
  enemyAISystem,
  familyFeudSystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  achievementSystem,
  emergentEventSystem,
  getScenarioDefinition,
  meetTutorialGoon,
  questSystem,
  spawnerArenaSystem,
  spawnerSystem,
  weaponSystem,
  capturePlayerCarryover,
  type ScenarioInitializationOptions,
} from '../game/index.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  getBossRewardSpellOptions,
  getNpcQuestIndicatorState,
  getShopkeeperPostQuestStock,
  getShopkeeperStage,
  hasCompletedWelcomeGoonQuest,
  meetShopkeeper,
  meetSpellQuestGiver,
  purchaseShopkeeperEquipment,
  purchaseShopkeeperPostQuestItem,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../game/floorScenario.js';
import {
  floor2VictorySystem,
  confirmFloor2StairDescend,
  meetBroker,
} from '../game/floor2Scenario.js';
import {
  statSystem,
  statusEffectSystem,
  familyRelationshipSystem,
  type GameWorld,
} from '../core/index.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';
import type { MainGameSceneTransitionOptions } from '../engine/scenes/MainGameScene.js';

export type FloorMainSceneOptions = MainGameSceneTransitionOptions;

/**
 * Create main scene options for a floor.
 * @param floorId - The floor identifier (e.g., "floor1")
 */
export function createFloorMainSceneOptions(
  floorId: string = 'floor1',
  initializationOptions?: ScenarioInitializationOptions,
): FloorMainSceneOptions {
  const scenario = getScenarioDefinition(floorId);
  const manifest = getFloorManifest(floorId);
  if (!manifest) {
    throw new Error(`Unknown floor manifest: ${floorId}`);
  }
  const floor1Callbacks = floorId === 'floor1';
  return {
    floorId,
    lightingConfig: { ambient: manifest.lighting.ambient },
    configureWorld: (world: GameWorld, playerEid: number) =>
      scenario.configureWorld(world, playerEid, initializationOptions),
    selectLoadoutOption: scenario.selectLoadoutOption,
    director: scenario.director,
    onStairDescend: floor1Callbacks ? confirmFloor1StairDescend : confirmFloor2StairDescend,
    onFloor1Cleared: floor1Callbacks
      ? (world: GameWorld, playerEid: number) => {
          const playerCarryover = capturePlayerCarryover(world, playerEid);
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.set('floor', 'floor2');
            window.history.replaceState(window.history.state, '', url);
          }
          return {
            ...createFloorMainSceneOptions('floor2', { playerCarryover }),
            worldSeed: world.seed,
          };
        }
      : undefined,
    selectSpellFromBossBattle: (world: GameWorld, playerEid: number, spellId: string) => {
      selectSpellFromBossBattle(world, playerEid, spellId as Floor1BossRewardSpellId);
    },
    getSpellRewardOptions: (world: GameWorld) => getBossRewardSpellOptions(world),
    allocateStatPoints: (
      world: GameWorld,
      _playerEid: number,
      allocations: Parameters<typeof spendPoints>[1],
    ) => {
      spendPoints(world, allocations);
    },
    shopkeeper: floor1Callbacks
      ? {
          getIndicatorState: (world: GameWorld) => getNpcQuestIndicatorState(world, 'shopkeeper'),
          getStage: getShopkeeperStage,
          meet: meetShopkeeper,
          returnPrize: returnShopkeeperPrize,
          purchase: purchaseShopkeeperEquipment,
          getPostQuestStock: getShopkeeperPostQuestStock,
          purchasePostQuestItem: purchaseShopkeeperPostQuestItem,
          equip: equipPurchasedGear,
          equipmentCost: SHOPKEEPER_EQUIPMENT_COST,
          equipmentName: MERCHANTS_CHARM_DEF.name,
          isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
        }
      : undefined,
    tutorialGoon: floor1Callbacks
      ? {
          meet: meetTutorialGoon,
          getIndicatorState: (world: GameWorld) =>
            getNpcQuestIndicatorState(world, 'tutorial-goon'),
        }
      : undefined,
    spellQuestGiver: floor1Callbacks
      ? {
          getIndicatorState: (world: GameWorld) =>
            getNpcQuestIndicatorState(world, 'spell-quest-giver'),
          meet: meetSpellQuestGiver,
          isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
        }
      : undefined,
    broker: !floor1Callbacks ? { met: meetBroker } : undefined,
    preSystems: [
      statSystem,
      // Drain queued faction-relation deltas early so any preSystem or
      // postSystem downstream this frame reads consistent post-adjust bands.
      // Always-safe: on Floor 1 the deltas queue stays empty (near-noop).
      familyRelationshipSystem,
      // Floor 2 Slice 5: per-tick dynamic victory evaluator (sole-ally or
      // all-bosses-dead). Always-safe no-op on Floor 1 / non-Floor-2 worlds.
      floor2VictorySystem,
      emergentEventSystem,
      floor1PlayerStatSystem,
      weaponSystem,
      // Floor 2 Slice 3: band-driven AI prepass runs AFTER familyRelationshipSystem
      // (so this frame's post-adjust bands are visible) and BEFORE enemyAISystem
      // (so it can plant a virtual target + hate speed ramp the AI will consume).
      // Always-safe on Floor 1 (no FamilyMembership → near-noop).
      familyFeudSystem,
      enemyAISystem,
      // statusEffectSystem runs AFTER enemyAISystem (and playerInputSystem, which
      // runs before all preSystems) so player + enemy speed folds see the same
      // pre-expiry effect set — expiry/HoT then apply before movement/damage/health.
      statusEffectSystem,
      // spawnerArenaSystem runs IMMEDIATELY BEFORE spawnerSystem so the
      // spawner ↔ director adjacency (locked by the preSystems contract test
      // in `tests/game/floor1-main-scene-options.test.ts`) stays intact.
      // Runs before spawnerSystem so any fence-tile mutation this frame is
      // visible when spawnerSystem chooses child spawn positions in the same
      // tick.
      spawnerArenaSystem,
      spawnerSystem,
      floor1EnemyDirectorSystem,
    ],
    postSystems: [
      levelSystem,
      skillSystem,
      abilitySystem,
      floorObjectiveSystem,
      questSystem,
      achievementSystem,
    ],
  };
}

/**
 * @deprecated Use createFloorMainSceneOptions instead
 */
export function createFloor1MainSceneOptions() {
  return createFloorMainSceneOptions('floor1');
}
