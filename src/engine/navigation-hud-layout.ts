import { GAME } from '../shared/constants.js';
import type { ScreenBounds } from './ui-scale.js';

export const NAV_RADAR_DIAMETER = 152;
export const NAV_RADAR_MARGIN = 12;
export const NAV_RADAR_MAX_SCALE = 1.4;
export const NAV_QUEST_WIDTH = 312;
export const NAV_QUEST_MAX_HEIGHT = 196;
export const NAV_QUEST_MAX_SCALE = 1.45;

const RADAR_LABEL_HEIGHT = 22;
const PANEL_GAP = 14;
const HUD_MAX_SCALE = 1.6;
const FAMILY_PANEL_WIDTH = 232;
const FAMILY_PANEL_HEIGHT = 174;
const FAMILY_PANEL_RIGHT_OFFSET = 244;
const FAMILY_PANEL_BOTTOM_OFFSET = 334;

export interface NavigationHudLayout {
  readonly radarScale: number;
  readonly radarBounds: ScreenBounds;
  readonly questScale: number;
  readonly questPosition: { readonly x: number; readonly y: number };
  readonly questMaxHeight: number;
  readonly criticalHudRegions: readonly ScreenBounds[];
}

export function boundsOverlap(a: ScreenBounds, b: ScreenBounds, padding = 0): boolean {
  return (
    a.x < b.x + b.width + padding &&
    a.x + a.width + padding > b.x &&
    a.y < b.y + b.height + padding &&
    a.y + a.height + padding > b.y
  );
}

export function resolveNavigationHudLayout(uiScale: number, floor: number): NavigationHudLayout {
  const radarScale = Math.min(Math.max(1, uiScale), NAV_RADAR_MAX_SCALE);
  const radarDiameter = NAV_RADAR_DIAMETER * radarScale;
  const radarBounds: ScreenBounds = {
    x: GAME.WIDTH - NAV_RADAR_MARGIN - radarDiameter,
    y: NAV_RADAR_MARGIN,
    width: radarDiameter,
    height: radarDiameter + RADAR_LABEL_HEIGHT * radarScale,
  };

  const questScale = Math.min(Math.max(1, uiScale), NAV_QUEST_MAX_SCALE);
  const hudScale = Math.min(Math.max(1, uiScale), HUD_MAX_SCALE);
  const floorTwo = floor >= 2;

  // Top-center critical region: scales with hudScale (topCenter group uses same
  // anchored transform as HudUI.applyScale). At scale 1 the content spans
  // x=410..870 (width 460), y=0..118. Anchored at (cx*(1−s), 0) with scale s.
  const topCenterRegion: ScreenBounds = {
    x: GAME.WIDTH / 2 - 230 * hudScale,
    y: 0,
    width: 460 * hudScale,
    height: 118 * hudScale,
  };

  // For Floor 2 the tracker uses the upper-left navigation lane.  It must clear
  // the scaled top-center critical band (boss bar / announcement) at all scales.
  const floorTwoY = Math.ceil(topCenterRegion.height) + 8;
  const questPosition = floorTwo
    ? { x: 16, y: floorTwoY }
    : {
        x: GAME.WIDTH - 16 - NAV_QUEST_WIDTH * questScale,
        y: radarBounds.y + radarBounds.height + PANEL_GAP,
      };

  // Bottom-left critical region: scales with hudScale (bottomLeft group anchored
  // at (0, h*(1−s)) with scale s). At scale 1: x=0..390, y=496..720.
  const bottomLeftRegion: ScreenBounds = {
    x: 0,
    y: GAME.HEIGHT - 224 * hudScale,
    width: 390 * hudScale,
    height: 224 * hudScale,
  };

  // Floor 2 max panel height is clamped so the tracker (including scale) never
  // overlaps the bottom-left critical band.  Uses design-space units; the tracker
  // will multiply by questScale when computing its panel height.
  const questMaxHeight = floorTwo
    ? Math.min(
        NAV_QUEST_MAX_HEIGHT,
        Math.floor((bottomLeftRegion.y - questPosition.y - 1) / questScale),
      )
    : NAV_QUEST_MAX_HEIGHT;

  const floorTwoFamilyRegion: ScreenBounds[] =
    floor >= 2
      ? [
          {
            x: GAME.WIDTH - FAMILY_PANEL_RIGHT_OFFSET * hudScale,
            y: GAME.HEIGHT - FAMILY_PANEL_BOTTOM_OFFSET * hudScale,
            width: FAMILY_PANEL_WIDTH * hudScale,
            height: FAMILY_PANEL_HEIGHT * hudScale,
          },
        ]
      : [];

  return {
    radarScale,
    radarBounds,
    questScale,
    questPosition,
    questMaxHeight,
    criticalHudRegions: [
      topCenterRegion,
      bottomLeftRegion,
      // Bottom-center: ability bar is always scale 1 (ABILITY_BAR_MAX_SCALE = 1).
      { x: GAME.WIDTH / 2 - 310, y: GAME.HEIGHT - 122, width: 620, height: 122 },
      ...floorTwoFamilyRegion,
    ],
  };
}
