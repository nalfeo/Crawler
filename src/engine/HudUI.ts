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

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  setAlpha(alpha: number): void;
  destroy(): void;
} {
  const healthBar = createHudHealthBar(scene);
  const floorTimer = createHudFloorTimer(scene);
  const minimap = createHudMinimap(scene);

  function sync(world: GameWorld, playerEid: number): void {
    healthBar.sync(world, playerEid);
    floorTimer.sync(world);
    minimap.sync(world, playerEid);
  }

  function setAlpha(alpha: number): void {
    healthBar.setAlpha(alpha);
    floorTimer.setAlpha(alpha);
    minimap.setAlpha(alpha);
  }

  function destroy(): void {
    healthBar.destroy();
    floorTimer.destroy();
    minimap.destroy();
  }

  return { sync, setAlpha, destroy };
}
