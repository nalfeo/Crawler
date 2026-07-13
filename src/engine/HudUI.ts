/**
 * HudUI — facade that owns HudHealthBar, HudManaBar, HudFloorTimer, HudBossBar,
 * and HudMinimap.
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
import { createHudBossBar } from './HudBossBar.js';
import { createHudAnnouncementBanner } from './HudAnnouncementBanner.js';
import { createHudLootCounter } from './HudLootCounter.js';
import { createHudMinimap } from './HudMinimap.js';
import { createHudQuestTracker } from './HudQuestTracker.js';
import { createHudAbilityBar } from './HudAbilityBar.js';
import { createHudSkillTracker } from './HudSkillTracker.js';
import { createHudDirectionArrows } from './HudDirectionArrows.js';
import { createHudFamilyRelationships } from './HudFamilyRelationships.js';
import { getUiScale, onUiScaleChange } from './ui-scale.js';
import { GAME } from '../shared/constants.js';
import type { ScreenBounds } from './ui-scale.js';
import { ENCOUNTER_FIRST_ROW_Y, resolveEncounterStackLayout } from './hud-encounter-layout.js';

export interface HudEncounterProbeBounds {
  timerPanel: ScreenBounds;
  timerText: ScreenBounds;
  bossPanel: ScreenBounds | null;
  bossText: ScreenBounds | null;
  announcementPanel: ScreenBounds | null;
  announcementText: ScreenBounds | null;
  questPanel: ScreenBounds | null;
  minimap: ScreenBounds | null;
}

/**
 * Upper bound on HUD magnification. The HUD is authored to fill the full 1280px
 * design width, so independently-anchored corner groups would collide if scaled
 * too aggressively. A conservative cap keeps mobile text/icons larger while
 * avoiding overlap. At scale 1 (desktop) the layout is pixel-identical.
 */
const HUD_MAX_SCALE = 1.6;
/**
 * Keep the ability bar smaller than the rest of the HUD on narrow screens so
 * bottom-center UX affordances (Talk/Descend prompt, dialogue hint area) keep
 * clear space and never collide with the slots row.
 */
const ABILITY_BAR_MAX_SCALE = 1.0;

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  isMapOverlayOpen(): boolean;
  closeMapOverlay(): void;
  getEncounterProbeBounds(): HudEncounterProbeBounds;
  setVisible(visible: boolean): void;
  destroy(): void;
} {
  const depth = 1000;
  const makeGroup = (): Phaser.GameObjects.Container =>
    scene.add.container(0, 0).setScrollFactor(0).setDepth(depth);

  // Corner groups: each is scaled and re-anchored as a unit so its elements
  // keep their relative layout while growing on small screens.
  const bottomLeft = makeGroup(); // health, mana, xp, loot
  const bottomCenter = makeGroup(); // ability bar
  const topCenter = makeGroup(); // floor timer + boss bar
  const topRight = makeGroup(); // quest tracker
  const bottomRight = makeGroup(); // family relationships (Floor 2)

  const healthBar = createHudHealthBar(scene, { parent: bottomLeft });
  const manaBar = createHudManaBar(scene, { parent: bottomLeft });
  const xpBar = createHudExperienceBar(scene, { parent: bottomLeft });
  const lootCounter = createHudLootCounter(scene, { parent: bottomLeft });
  const skillTracker = createHudSkillTracker(scene, { parent: bottomLeft });
  const abilityBar = createHudAbilityBar(scene, { parent: bottomCenter });
  const floorTimer = createHudFloorTimer(scene, { parent: topCenter });
  const bossBar = createHudBossBar(scene, { parent: topCenter });
  const announcementBanner = createHudAnnouncementBanner(scene, { parent: topCenter });
  const questTracker = createHudQuestTracker(scene, { parent: topRight });
  const familyRelationships = createHudFamilyRelationships(scene, { parent: bottomRight });

  // Minimap manages its own dynamic children/overlay and screen-space layout,
  // so it scales its docked radar dial internally (see HudMinimap.updateLayout)
  // rather than being grouped into a corner container here.
  const minimap = createHudMinimap(scene);

  // Off-screen quest waypoint arrows live full-screen (edge-pinned), so they
  // own their depth rather than belonging to a scaled corner group.
  const directionArrows = createHudDirectionArrows(scene);

  // Phaser containers render children in insertion order; pixel-ui builders set
  // explicit depths, so sort each group to preserve intended layering.
  for (const group of [bottomLeft, bottomCenter, topCenter, topRight, bottomRight]) {
    group.sort('depth');
  }

  function applyScale(): void {
    const s = Math.min(getUiScale(scene), HUD_MAX_SCALE);
    const bottomCenterScale = Math.min(s, ABILITY_BAR_MAX_SCALE);
    const w = GAME.WIDTH;
    const h = GAME.HEIGHT;
    const cx = w / 2;

    bottomLeft.setScale(s).setPosition(0, h * (1 - s));
    bottomCenter
      .setScale(bottomCenterScale)
      .setPosition(cx * (1 - bottomCenterScale), h * (1 - bottomCenterScale));
    topCenter.setScale(s).setPosition(cx * (1 - s), 0);
    topRight.setScale(s).setPosition(w * (1 - s), 0);
    bottomRight.setScale(s).setPosition(w * (1 - s), h * (1 - s));
  }

  applyScale();
  const offUiScaleChange = onUiScaleChange(scene, applyScale);

  // When true, a full-screen panel (character/equipment/inventory screen) is
  // open, so the whole HUD is hidden and sync() is a no-op.
  let hidden = false;

  function setVisible(visible: boolean): void {
    hidden = !visible;
    for (const group of [bottomLeft, bottomCenter, topCenter, topRight, bottomRight]) {
      group.setVisible(visible);
    }
    minimap.setHudVisible(visible);
    directionArrows.setVisible(visible);
  }

  function sync(world: GameWorld, playerEid: number): void {
    if (hidden) {
      return;
    }
    healthBar.sync(world, playerEid);
    manaBar.sync(world);
    xpBar.sync(world);
    floorTimer.sync(world);
    bossBar.sync(world);
    announcementBanner.sync(world);
    const encounterLayout = resolveEncounterStackLayout(
      bossBar.getLayoutBounds() !== null,
      announcementBanner.getLayoutBounds() !== null,
    );
    bossBar.setTop(encounterLayout.bossTop ?? ENCOUNTER_FIRST_ROW_Y);
    announcementBanner.setTop(encounterLayout.announcementTop ?? ENCOUNTER_FIRST_ROW_Y);
    lootCounter.sync(world);
    skillTracker.sync(world, playerEid);
    minimap.sync(world, playerEid);
    questTracker.sync(world, playerEid);
    directionArrows.sync(world, playerEid);
    abilityBar.sync(world, playerEid);
    familyRelationships.sync(world);
  }

  function destroy(): void {
    offUiScaleChange();
    healthBar.destroy();
    manaBar.destroy();
    xpBar.destroy();
    floorTimer.destroy();
    bossBar.destroy();
    announcementBanner.destroy();
    lootCounter.destroy();
    skillTracker.destroy();
    minimap.destroy();
    questTracker.destroy();
    directionArrows.destroy();
    abilityBar.destroy();
    familyRelationships.destroy();
    bottomLeft.destroy();
    bottomCenter.destroy();
    topCenter.destroy();
    topRight.destroy();
    bottomRight.destroy();
  }

  function transformBounds(
    bounds: ScreenBounds,
    group: Phaser.GameObjects.Container,
  ): ScreenBounds {
    return {
      x: group.x + bounds.x * group.scaleX,
      y: group.y + bounds.y * group.scaleY,
      width: bounds.width * group.scaleX,
      height: bounds.height * group.scaleY,
    };
  }

  function getEncounterProbeBounds(): HudEncounterProbeBounds {
    const timer = floorTimer.getLayoutBounds();
    const boss = bossBar.getLayoutBounds();
    const announcement = announcementBanner.getLayoutBounds();
    const quest = questTracker.getLayoutBounds();
    return {
      timerPanel: transformBounds(timer.panel, topCenter),
      timerText: transformBounds(timer.text, topCenter),
      bossPanel: boss ? transformBounds(boss.panel, topCenter) : null,
      bossText: boss ? transformBounds(boss.text, topCenter) : null,
      announcementPanel: announcement ? transformBounds(announcement.panel, topCenter) : null,
      announcementText: announcement ? transformBounds(announcement.text, topCenter) : null,
      questPanel: quest ? transformBounds(quest, topRight) : null,
      minimap: minimap.getDockedBounds(),
    };
  }

  return {
    sync,
    isMapOverlayOpen: minimap.isOverlayOpen,
    closeMapOverlay: minimap.closeOverlay,
    getEncounterProbeBounds,
    setVisible,
    destroy,
  };
}
