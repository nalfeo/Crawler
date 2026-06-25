import Phaser from 'phaser';
import { createFloor1GameConfig } from './bootstrap/floor1-game-config.js';
import { GAME } from './shared/constants.js';
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

async function bootstrapGame(): Promise<void> {
  const { createFloor1MainSceneOptions } = await import('./bootstrap/floor1-main-scene-options.js');
  const config = createFloor1GameConfig('game-container', createFloor1MainSceneOptions());
  new Phaser.Game(config);
}

void bootstrapGame();
