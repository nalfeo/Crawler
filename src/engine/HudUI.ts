/**
 * HudUI — facade that owns HudHealthBar, HudFloorTimer, and HudMinimap.
 *
 * Call sync() every frame to update all HUD elements from the current world state.
 * Call destroy() on scene shutdown to clean up all resources.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { createHudHealthBar } from './HudHealthBar.js';
import { createHudFloorTimer } from './HudFloorTimer.js';
import { createHudMinimap } from './HudMinimap.js';
import { createHudQuestTracker } from './HudQuestTracker.js';

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  isMapOverlayOpen(): boolean;
  destroy(): void;
} {
  const healthBar = createHudHealthBar(scene);
  const floorTimer = createHudFloorTimer(scene);
  const minimap = createHudMinimap(scene);
  const questTracker = createHudQuestTracker(scene);

  function sync(world: GameWorld, playerEid: number): void {
    healthBar.sync(world, playerEid);
    floorTimer.sync(world);
    minimap.sync(world, playerEid);
    questTracker.sync(world, playerEid);
  }

  function destroy(): void {
    healthBar.destroy();
    floorTimer.destroy();
    minimap.destroy();
    questTracker.destroy();
  }

  return { sync, isMapOverlayOpen: minimap.isOverlayOpen, destroy };
}
