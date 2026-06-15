/**
 * HudUI — facade that owns HudHealthBar, HudFloorTimer, and HudMinimap.
 *
 * Call sync() every frame to update all HUD elements from the current world state.
 * Call destroy() on scene shutdown to clean up all resources.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { createHudHealthBar } from './HudHealthBar.js';
import { createHudExperienceBar } from './HudExperienceBar.js';
import { createHudFloorTimer } from './HudFloorTimer.js';
import { createHudLootCounter } from './HudLootCounter.js';
import { createHudMinimap } from './HudMinimap.js';
import { createHudQuestTracker } from './HudQuestTracker.js';

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  isMapOverlayOpen(): boolean;
  destroy(): void;
} {
  const healthBar = createHudHealthBar(scene);
  const xpBar = createHudExperienceBar(scene);
  const floorTimer = createHudFloorTimer(scene);
  const lootCounter = createHudLootCounter(scene);
  const minimap = createHudMinimap(scene);
  const questTracker = createHudQuestTracker(scene);

  function sync(world: GameWorld, playerEid: number): void {
    healthBar.sync(world, playerEid);
    xpBar.sync(world);
    floorTimer.sync(world);
    lootCounter.sync(world);
    minimap.sync(world, playerEid);
    questTracker.sync(world, playerEid);
  }

  function destroy(): void {
    healthBar.destroy();
    xpBar.destroy();
    floorTimer.destroy();
    lootCounter.destroy();
    minimap.destroy();
    questTracker.destroy();
  }

  return { sync, isMapOverlayOpen: minimap.isOverlayOpen, destroy };
}
