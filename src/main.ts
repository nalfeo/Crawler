import Phaser from 'phaser';
import { createFloorGameConfig } from './bootstrap/floor-game-config.js';
import { resolveGameLaunchSeed } from './bootstrap/game-launch-seed.js';
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
  const searchParams =
    typeof window !== 'undefined'
      ? new URL(window.location.href).searchParams
      : new URLSearchParams();
  let floorId = (typeof window !== 'undefined' ? searchParams.get('floor') : null) ?? 'floor1';

  // Validate floorId is known by checking if we can get the manifest
  const { getFloorManifest } = await import('./shared/floor-registry.js');
  if (!getFloorManifest(floorId)) {
    logger.warn('Unknown floor ID, falling back to floor1', { floorId });
    floorId = 'floor1';
  }

  const { createFloorMainSceneOptions } = await import('./bootstrap/floor-main-scene-options.js');
  const sceneOptions = {
    ...createFloorMainSceneOptions(floorId),
    worldSeed: resolveGameLaunchSeed(searchParams),
  };
  const config = createFloorGameConfig('game-container', sceneOptions, floorId);
  new Phaser.Game(config);
}

void bootstrapGame();
