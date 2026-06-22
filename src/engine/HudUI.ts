/**
 * HudUI — facade that owns HudHealthBar, HudManaBar, HudFloorTimer, and HudMinimap.
 *
 * Call sync() every frame to update all HUD elements from the current world state.
 * Call destroy() on scene shutdown to clean up all resources.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { createHudHealthBar } from './HudHealthBar.js';
import { createHudManaBar } from './HudManaBar.js';
import { createHudExperienceBar } from './HudExperienceBar.js';
import { createHudFloorTimer } from './HudFloorTimer.js';
import { createHudLootCounter } from './HudLootCounter.js';
import { createHudMinimap } from './HudMinimap.js';
import { createHudQuestTracker } from './HudQuestTracker.js';
import { createHudAbilityBar } from './HudAbilityBar.js';
import { createHudSkillsPanel } from './HudSkillsPanel.js';
import { getUiScale, onUiScaleChange } from './ui-scale.js';

/**
 * Upper bound on HUD magnification. The HUD is authored to fill the full 1280px
 * design width, so independently-anchored corner groups would collide if scaled
 * too aggressively. A conservative cap keeps mobile text/icons larger while
 * avoiding overlap. At scale 1 (desktop) the layout is pixel-identical.
 */
const HUD_MAX_SCALE = 1.6;

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  isMapOverlayOpen(): boolean;
  destroy(): void;
} {
  const depth = 1000;
  const makeGroup = (): Phaser.GameObjects.Container =>
    scene.add.container(0, 0).setScrollFactor(0).setDepth(depth);

  // Corner groups: each is scaled and re-anchored as a unit so its elements
  // keep their relative layout while growing on small screens.
  const bottomLeft = makeGroup(); // health, mana, xp, loot
  const bottomCenter = makeGroup(); // ability bar
  const topCenter = makeGroup(); // floor timer
  const topRight = makeGroup(); // quest tracker

  const healthBar = createHudHealthBar(scene, { parent: bottomLeft });
  const manaBar = createHudManaBar(scene, { parent: bottomLeft });
  const xpBar = createHudExperienceBar(scene, { parent: bottomLeft });
  const lootCounter = createHudLootCounter(scene, { parent: bottomLeft });
  const abilityBar = createHudAbilityBar(scene, { parent: bottomCenter });
  const floorTimer = createHudFloorTimer(scene, { parent: topCenter });
  const questTracker = createHudQuestTracker(scene, { parent: topRight });

  // Minimap manages its own dynamic children/overlay and screen-space layout,
  // so it scales its docked radar dial internally (see HudMinimap.updateLayout)
  // rather than being grouped into a corner container here.
  const minimap = createHudMinimap(scene);

  // Skills panel: standalone (not in a corner group) so it is not scaled by the
  // corner-group mechanism; it manages its own visibility based on activeWeaponId.
  const skillsPanel = createHudSkillsPanel(scene);

  // Phaser containers render children in insertion order; pixel-ui builders set
  // explicit depths, so sort each group to preserve intended layering.
  for (const group of [bottomLeft, bottomCenter, topCenter, topRight]) {
    group.sort('depth');
  }

  function applyScale(): void {
    const s = Math.min(getUiScale(scene), HUD_MAX_SCALE);
    const w = scene.scale.width;
    const h = scene.scale.height;
    const cx = w / 2;

    bottomLeft.setScale(s).setPosition(0, h * (1 - s));
    bottomCenter.setScale(s).setPosition(cx * (1 - s), h * (1 - s));
    topCenter.setScale(s).setPosition(cx * (1 - s), 0);
    topRight.setScale(s).setPosition(w * (1 - s), 0);
  }

  applyScale();
  const offUiScaleChange = onUiScaleChange(scene, applyScale);

  function sync(world: GameWorld, playerEid: number): void {
    healthBar.sync(world, playerEid);
    manaBar.sync(world);
    xpBar.sync(world);
    floorTimer.sync(world);
    lootCounter.sync(world);
    minimap.sync(world, playerEid);
    questTracker.sync(world, playerEid);
    abilityBar.sync(world, playerEid);
    skillsPanel.sync(world, playerEid);
  }

  function destroy(): void {
    offUiScaleChange();
    healthBar.destroy();
    manaBar.destroy();
    xpBar.destroy();
    floorTimer.destroy();
    lootCounter.destroy();
    minimap.destroy();
    questTracker.destroy();
    abilityBar.destroy();
    skillsPanel.destroy();
    bottomLeft.destroy();
    bottomCenter.destroy();
    topCenter.destroy();
    topRight.destroy();
  }

  return { sync, isMapOverlayOpen: minimap.isOverlayOpen, destroy };
}
