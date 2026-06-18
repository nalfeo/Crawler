import { query } from 'bitecs';
import { abilitySystem, levelSystem, skillSystem, statsSystem } from '../game/systems/index.js';
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
  meetShopkeeper,
  purchaseShopkeeperEquipment,
  returnShopkeeperPrize,
  selectSpellFromBossBattle,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../game/floor1Scenario.js';
import { Player, type GameWorld } from '../core/index.js';
import { MERCHANTS_CHARM_DEF } from '../shared/equipmentDefs.js';
import type { Floor1BossRewardSpellId } from '../shared/abilities.js';

export function createFloor1MainSceneOptions() {
  return {
    configureWorld: initializeFloor1Scenario,
    selectLoadoutOption: selectFloor1StarterWeapon,
    onStairDescend: confirmFloor1StairDescend,
    selectSpellFromBossBattle: (world: GameWorld, spellId: Floor1BossRewardSpellId) => {
      const playerEntities = query(world.ecs, [Player]);
      const playerEid = [...playerEntities][0];
      if (playerEid !== undefined) {
        selectSpellFromBossBattle(world, playerEid, spellId);
      }
    },
    shopkeeper: {
      getStage: getShopkeeperStage,
      meet: meetShopkeeper,
      returnPrize: returnShopkeeperPrize,
      purchase: purchaseShopkeeperEquipment,
      equip: equipPurchasedGear,
      equipmentCost: SHOPKEEPER_EQUIPMENT_COST,
      equipmentName: MERCHANTS_CHARM_DEF.name,
    },
    tutorialGoon: { meet: meetTutorialGoon },
    preSystems: [
      statsSystem,
      floor1PlayerStatSystem,
      weaponSystem,
      enemyAISystem,
      floor1EnemyDirectorSystem,
    ],
    postSystems: [levelSystem, skillSystem, abilitySystem, floorObjectiveSystem, questSystem],
  };
}
