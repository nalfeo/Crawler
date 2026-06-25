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
  initializeFloor1Scenario,
  meetTutorialGoon,
  questSystem,
  selectFloor1StarterWeapon,
  weaponSystem,
} from '../game/index.js';
import {
  confirmFloor1StairDescend,
  equipPurchasedGear,
  getShopkeeperStage,
  hasCompletedWelcomeGoonQuest,
  meetShopkeeper,
  meetSpellQuestGiver,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../game/floor1Scenario.js';
import { statSystem, type GameWorld } from '../core/index.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';

export function createFloor1MainSceneOptions() {
  return {
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
      getStage: getShopkeeperStage,
      meet: meetShopkeeper,
      returnPrize: returnShopkeeperPrize,
      purchase: purchaseShopkeeperEquipment,
      equip: equipPurchasedGear,
      equipmentCost: SHOPKEEPER_EQUIPMENT_COST,
      equipmentName: MERCHANTS_CHARM_DEF.name,
      isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
    },
    tutorialGoon: { meet: meetTutorialGoon },
    spellQuestGiver: {
      meet: meetSpellQuestGiver,
      isLocked: (world: GameWorld) => !hasCompletedWelcomeGoonQuest(world),
    },
    preSystems: [
      statsSystem,
      statSystem,
      floor1PlayerStatSystem,
      weaponSystem,
      enemyAISystem,
      floor1EnemyDirectorSystem,
    ],
    postSystems: [levelSystem, skillSystem, abilitySystem, floorObjectiveSystem, questSystem],
  };
}
