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

  // Load both modules in parallel so the floor-main-scene-options chunk does
  // not wait for the small floor-registry chunk to resolve first.
  const [{ getFloorManifest }, { createFloorMainSceneOptions }] = await Promise.all([
    import('./shared/floor-registry.js'),
    import('./bootstrap/floor-main-scene-options.js'),
  ]);

  // Validate floorId is known by checking if we can get the manifest
  if (!getFloorManifest(floorId)) {
    logger.warn('Unknown floor ID, falling back to floor1', { floorId });
    floorId = 'floor1';
  }

  const sceneOptions = {
    ...createFloorMainSceneOptions(floorId),
    worldSeed: resolveGameLaunchSeed(searchParams),
  };
  const config = createFloorGameConfig('game-container', sceneOptions, floorId);
  new Phaser.Game(config);
}

void bootstrapGame();
