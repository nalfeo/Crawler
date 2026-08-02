/**
 * HudUI — facade that owns HudHealthBar, HudFloorTimer, HudBossBar,
 * and HudMinimap.
 *
 * Call sync() every frame to update all HUD elements from the current world state.
 * Call destroy() on scene shutdown to clean up all resources.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { createHudHealthBar } from './HudHealthBar.js';
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
import {
  createHudFamilyRelationships,
  type HudFamilyRelationshipsState,
} from './HudFamilyRelationships.js';
import { getUiScale, onUiScaleChange } from './ui-scale.js';
import { getSafeAreaInsets, onSafeAreaChange } from './safe-area.js';
import { computeVitalsScale } from './HudVitalsLayout.js';
import { GAME } from '../shared/constants.js';
import type { FamilyRelationshipsLayout } from './HudFamilyRelationships.js';
import type { ScreenBounds } from './ui-scale.js';
import { resolveNavigationHudLayout } from './navigation-hud-layout.js';
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
 * Keep the ability bar smaller than the rest of the HUD on narrow screens so
 * bottom-center UX affordances (Talk/Descend prompt, dialogue hint area) keep
 * clear space and never collide with the slots row.
 */
const ABILITY_BAR_MAX_SCALE = 1.0;

export interface NavigationHudBounds {
  readonly radar: ScreenBounds | null;
  readonly questTracker: ScreenBounds | null;
  readonly familyPanel: ScreenBounds | null;
  readonly arrows: readonly ScreenBounds[];
  readonly mapOverlay: ScreenBounds | null;
  readonly mapClose: ScreenBounds | null;
}

export function createHudUI(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  isMapOverlayOpen(): boolean;
  closeMapOverlay(): void;
  getAbilityBarBounds(): ScreenBounds;
  getAbilitySlotBounds(index: number): ScreenBounds | null;
  getFamilyRelationshipsState(): HudFamilyRelationshipsState;
  getEncounterProbeBounds(): HudEncounterProbeBounds;
  /**
   * The currently-rendered announcement banner content (kind + exact text),
   * or `null` when no banner is showing. Real rendered projection — the same
   * content the player sees — for e2e probes to assert on directly.
   */
  getCurrentAnnouncement(): { kind: string; text: string } | null;
  setVisible(visible: boolean): void;
  getNavigationBounds(): NavigationHudBounds;
  getFamilyRelationshipsLayout(): FamilyRelationshipsLayout;
  getMinimapBounds(): ScreenBounds | null;
  getMinimapOverlayWaypointArrowBounds(): ScreenBounds | null;
  getMinimapRadarWaypointArrowBounds(): ScreenBounds | null;
  getBottomCenterBounds(): ScreenBounds;
  destroy(): void;
} {
  const depth = 1000;
  const makeGroup = (): Phaser.GameObjects.Container =>
    scene.add.container(0, 0).setScrollFactor(0).setDepth(depth);

  // Corner groups: each is scaled and re-anchored as a unit so its elements
  // keep their relative layout while growing on small screens.
  const bottomLeft = makeGroup(); // health, xp, loot
  const bottomCenter = makeGroup(); // ability bar
  const topCenter = makeGroup(); // floor timer + boss bar
  const bottomRight = makeGroup(); // family relationships (Floor 2)

  const healthBar = createHudHealthBar(scene, { parent: bottomLeft });
  const xpBar = createHudExperienceBar(scene, { parent: bottomLeft });
  const lootCounter = createHudLootCounter(scene, { parent: bottomLeft });
  const skillTracker = createHudSkillTracker(scene, { parent: bottomLeft });
  const abilityBar = createHudAbilityBar(scene, { parent: bottomCenter });
  const floorTimer = createHudFloorTimer(scene, { parent: topCenter });
  const bossBar = createHudBossBar(scene, { parent: topCenter });
  const announcementBanner = createHudAnnouncementBanner(scene, { parent: topCenter });
  const questTracker = createHudQuestTracker(scene);
  // Minimap manages its own dynamic children/overlay and screen-space layout,
  // so it scales its docked radar dial internally (see HudMinimap.updateLayout)
  // rather than being grouped into a corner container here.
  const minimap = createHudMinimap(scene);
  const familyRelationships = createHudFamilyRelationships(scene, {
    parent: bottomRight,
    getAvoidBounds: () => {
      const bounds = [minimap.getDockedBounds()];
      const b = bottomCenter.getBounds();
      bounds.push({ x: b.x, y: b.y, width: b.width, height: b.height });
      return bounds.filter((item): item is ScreenBounds => item !== null);
    },
  });

  // Off-screen quest waypoint arrows live full-screen (edge-pinned), so they
  // own their depth rather than belonging to a scaled corner group.
  const directionArrows = createHudDirectionArrows(scene);

  // Phaser containers render children in insertion order; pixel-ui builders set
  // explicit depths, so sort each group to preserve intended layering.
  for (const group of [bottomLeft, bottomCenter, topCenter, bottomRight]) {
    group.sort('depth');
  }

  // Measure the bottom-left vitals cluster's natural (unscaled, unpositioned)
  // design-space extent exactly once, right after all 5 widgets are added and
  // depth-sorted but before the first applyScale() call transforms the group.
  // Deriving the scale cap from real rendered geometry (rather than a
  // hand-maintained magic number) is what keeps this cap correct if any
  // widget's own width/height ever changes.
  const bottomLeftNaturalBounds = bottomLeft.getBounds();
  const bottomLeftRightEdge = bottomLeftNaturalBounds.right;
  const bottomLeftTopEdge = bottomLeftNaturalBounds.top;
  const abilityBarLeftEdge = bottomCenter.getBounds().left;

  function applyScale(): void {
    const s = computeVitalsScale({
      desiredScale: getUiScale(scene),
      clusterRightEdge: bottomLeftRightEdge,
      clusterTopEdge: bottomLeftTopEdge,
      neighborLeftEdge: abilityBarLeftEdge,
    });
    const bottomCenterScale = Math.min(s, ABILITY_BAR_MAX_SCALE);
    const w = GAME.WIDTH;
    const h = GAME.HEIGHT;
    const cx = w / 2;
    // Inset the edge-anchored corner groups out of the display cutout / home
    // indicator bands. Zero on desktop and on any device whose unsafe bands
    // fall inside the letterbox (see src/engine/safe-area.ts).
    const safe = getSafeAreaInsets(scene);

    bottomLeft.setScale(s).setPosition(safe.left, h * (1 - s) - safe.bottom);
    bottomCenter
      .setScale(bottomCenterScale)
      .setPosition(cx * (1 - bottomCenterScale), h * (1 - bottomCenterScale) - safe.bottom);
    topCenter.setScale(s).setPosition(cx * (1 - s), safe.top);
    bottomRight.setScale(s).setPosition(w * (1 - s) - safe.right, h * (1 - s) - safe.bottom);
  }

  applyScale();
  const offUiScaleChange = onUiScaleChange(scene, applyScale);
  const offSafeAreaChange = onSafeAreaChange(scene, applyScale);

  // When true, a full-screen panel (character/equipment/inventory screen) is
  // open, so the whole HUD is hidden and sync() is a no-op.
  let hidden = false;

  function syncFamilyRelationshipsVisibility(): void {
    familyRelationships.setVisible(!hidden && !minimap.isOverlayOpen());
  }

  function setVisible(visible: boolean): void {
    hidden = !visible;
    for (const group of [bottomLeft, bottomCenter, topCenter, bottomRight]) {
      group.setVisible(visible);
    }
    questTracker.setVisible(visible);
    minimap.setHudVisible(visible);
    directionArrows.setVisible(visible);
    syncFamilyRelationshipsVisibility();
  }

  function sync(world: GameWorld, playerEid: number): void {
    syncFamilyRelationshipsVisibility();
    if (hidden) {
      return;
    }
    healthBar.sync(world, playerEid);
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
    abilityBar.sync(world, playerEid);
    familyRelationships.sync(world);
    const mapOpen = minimap.isOverlayOpen();
    questTracker.setVisible(!mapOpen);
    directionArrows.setVisible(!mapOpen);
    if (!mapOpen) {
      questTracker.sync(world, playerEid);
      const familyLayout = familyRelationships.getLayout();
      const layout = resolveNavigationHudLayout(getUiScale(scene), world.floor);
      const forbiddenRegions = [
        ...layout.criticalHudRegions,
        layout.radarBounds,
        questTracker.getBounds(),
        familyLayout.panel,
      ].filter((bounds): bounds is ScreenBounds => bounds !== null);
      directionArrows.sync(world, playerEid, forbiddenRegions);
    }
  }

  function getNavigationBounds(): NavigationHudBounds {
    return {
      radar: minimap.getDockedBounds(),
      questTracker: questTracker.getBounds(),
      familyPanel: familyRelationships.getLayout().panel,
      arrows: directionArrows.getBounds(),
      mapOverlay: minimap.getOverlayViewportBounds(),
      mapClose: minimap.getOverlayCloseBounds(),
    };
  }

  function destroy(): void {
    offUiScaleChange();
    offSafeAreaChange();
    healthBar.destroy();
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
    return {
      timerPanel: transformBounds(timer.panel, topCenter),
      timerText: transformBounds(timer.text, topCenter),
      bossPanel: boss ? transformBounds(boss.panel, topCenter) : null,
      bossText: boss ? transformBounds(boss.text, topCenter) : null,
      announcementPanel: announcement ? transformBounds(announcement.panel, topCenter) : null,
      announcementText: announcement ? transformBounds(announcement.text, topCenter) : null,
      questPanel: questTracker.getBounds(),
      minimap: minimap.getDockedBounds(),
    };
  }

  return {
    sync,
    isMapOverlayOpen: minimap.isOverlayOpen,
    closeMapOverlay: minimap.closeOverlay,
    getAbilityBarBounds: abilityBar.getPanelScreenBounds,
    getAbilitySlotBounds: abilityBar.getSlotScreenBounds,
    getFamilyRelationshipsState: familyRelationships.getState,
    getEncounterProbeBounds,
    getCurrentAnnouncement: () => (hidden ? null : announcementBanner.getCurrentAnnouncement()),
    setVisible,
    getNavigationBounds,
    getFamilyRelationshipsLayout: familyRelationships.getLayout,
    getMinimapBounds: minimap.getDockedBounds,
    getMinimapOverlayWaypointArrowBounds: minimap.getOverlayWaypointArrowBounds,
    getMinimapRadarWaypointArrowBounds: minimap.getRadarWaypointArrowBounds,
    getBottomCenterBounds: () => {
      const b = bottomCenter.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    destroy,
  };
}
