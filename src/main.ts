import Phaser from 'phaser';
import { BootScene, MainGameScene } from './engine/index.js';
import { GAME } from './shared/constants.js';
import { abilitySystem, levelSystem, skillSystem, statsSystem } from './game/systems/index.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floor1ObjectiveSystem,
  floor1PlayerStatSystem,
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
  weaponSystem,
} from './game/index.js';
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
      preSystems: [
        statsSystem,
        floor1PlayerStatSystem,
        weaponSystem,
        enemyAISystem,
        floor1EnemyDirectorSystem,
      ],
      postSystems: [levelSystem, skillSystem, abilitySystem, floor1ObjectiveSystem],
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
