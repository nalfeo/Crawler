import Phaser from 'phaser';
import { BootScene, MainGameScene } from './engine/index.js';
import { GAME } from './shared/constants.js';
import { abilitySystem, levelSystem, skillSystem, statsSystem } from './game/systems/index.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
  questSystem,
  weaponSystem,
} from './game/index.js';
import { confirmFloor1StairDescend } from './game/floor1Scenario.js';
import {
  getShopkeeperStage,
  meetShopkeeper,
  returnShopkeeperPrize,
  purchaseShopkeeperEquipment,
  equipPurchasedGear,
  SHOPKEEPER_EQUIPMENT_COST,
} from './game/floor1Scenario.js';
import { MERCHANTS_CHARM_DEF } from './shared/equipmentDefs.js';
import {
  createLogger,
  getGlobalLogLevel,
  setGlobalLogLevel,
  type LogLevel,
} from './shared/logger.js';

const logger = createLogger('main');

declare global {
  interface Window {
    crawlerLogs?: {
      setLevel: (level: LogLevel) => void;
      getLevel: () => LogLevel;
    };
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: GAME.WIDTH,
  height: GAME.HEIGHT,
  backgroundColor: '#111111',
  pixelArt: true,
  roundPixels: true,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },
  scene: [
    BootScene,
    new MainGameScene({
      configureWorld: initializeFloor1Scenario,
      selectLoadoutOption: selectFloor1StarterWeapon,
      onStairDescend: confirmFloor1StairDescend,
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
    }),
  ],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

new Phaser.Game(config);

if (typeof window !== 'undefined') {
  window.crawlerLogs = {
    setLevel: setGlobalLogLevel,
    getLevel: getGlobalLogLevel,
  };
}

logger.info('Game bootstrapped', {
  width: GAME.WIDTH,
  height: GAME.HEIGHT,
  logLevel: getGlobalLogLevel(),
});
