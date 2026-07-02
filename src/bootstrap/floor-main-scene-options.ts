import {
  abilitySystem,
  levelSystem,
  skillSystem,
  spendPoints,
  statsSystem,
} from '../game/systems/index.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  achievementSystem,
  initializeFloor1Scenario,
  meetTutorialGoon,
  questSystem,
  selectFloor1StarterWeapon,
  spawnerSystem,
  weaponSystem,
} from '../game/index.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
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
import { statSystem, manaSystem, statusEffectSystem, type GameWorld } from '../core/index.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import { getFloorConfig } from '../shared/floor-config.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';

/**
 * Create main scene options for a floor.
 * @param floorId - The floor identifier (e.g., "floor1")
 */
export function createFloorMainSceneOptions(_floorId: string = 'floor1') {
  // The world scenario + systems below are floor1-specific, so this helper only
  // supports floor1 today; `_floorId` is reserved for when multi-floor boot lands
  // (thread it through both getFloorConfig and the scenario wiring at that point).
  // Per-floor ambient lighting (see FloorConfig.lighting) is sourced from the
  // floor1 manifest so the scene ships the authored ambient rather than the
  // engine's global fallback.
  const { lighting } = getFloorConfig('floor1');
  return {
    lightingConfig: { ambient: lighting.ambient },
    configureWorld: initializeFloor1Scenario,
    selectLoadoutOption: selectFloor1StarterWeapon,
    onStairDescend: confirmFloor1StairDescend,
    selectSpellFromBossBattle: (world: GameWorld, playerEid: number, spellId: string) => {
      selectSpellFromBossBattle(world, playerEid, spellId as Floor1BossRewardSpellId);
    },
    allocateStatPoints: (
      world: GameWorld,
      _playerEid: number,
      allocations: Parameters<typeof spendPoints>[1],
    ) => {
      spendPoints(world, allocations);
    },
    shopkeeper: {
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
    },
    tutorialGoon: {
      meet: meetTutorialGoon,
      getIndicatorState: (world: GameWorld) => getNpcQuestIndicatorState(world, 'tutorial-goon'),
    },
    spellQuestGiver: {
      getIndicatorState: (world: GameWorld) =>
        getNpcQuestIndicatorState(world, 'spell-quest-giver'),
      meet: meetSpellQuestGiver,
      isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
    },
    preSystems: [
      statsSystem,
      statSystem,
      manaSystem,
      floor1PlayerStatSystem,
      weaponSystem,
      statusEffectSystem,
      enemyAISystem,
      // spawnerSystem MUST run before floor1EnemyDirectorSystem in the same frame:
      // the director's countDirectorEnemies/countEngagingEnemies count Spawner-owned
      // children (Enemy without Spawner), so spawning first lets the director cap
      // against this frame's children. In THIS visual pipeline we keep the two
      // immediately adjacent (locked by the preSystems contract test). The headless
      // gate pipeline (src/game/ai/simulation-step.ts) guarantees only the weaker
      // "spawner before director" ordering -- there spawnerSystem runs pre-movement
      // while the director runs post-core, so the core ECS pipeline runs between
      // them. That absolute-position divergence is a known, tracked approximation
      // (see issue #663). Reordering these so the director runs first would let the
      // visual game transiently overshoot the enemy cap.
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
