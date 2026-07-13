import { GAME } from '../shared/constants.js';
import type { ScreenBounds } from './ui-scale.js';

export const NAV_RADAR_DIAMETER = 152;
const NAV_RADAR_MARGIN = 12;
export const NAV_RADAR_MAX_SCALE = 1.4;
export const NAV_QUEST_WIDTH = 312;
export const NAV_QUEST_MAX_HEIGHT = 196;
const NAV_QUEST_MAX_SCALE = 1.45;

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
  // Floor 2 uses the upper-left navigation lane to keep the family panel (bottom-right)
  // and the radar (top-right) clear. Y is derived from the scaled top-center critical
  // band so the tracker always starts below it regardless of uiScale.
  const questPosition = floorTwo
    ? { x: 16, y: Math.ceil(118 * hudScale) + 8 }
    : {
        x: GAME.WIDTH - 16 - NAV_QUEST_WIDTH * questScale,
        y: radarBounds.y + radarBounds.height + PANEL_GAP,
      };
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
    questMaxHeight: NAV_QUEST_MAX_HEIGHT,
    criticalHudRegions: [
      // topCenter: scales around cx, matching HudUI.applyScale() anchor at (cx*(1-s), 0)
      { x: GAME.WIDTH / 2 - 230 * hudScale, y: 0, width: 460 * hudScale, height: 118 * hudScale },
      // bottomLeft: anchors at bottom-left, matching HudUI.applyScale() anchor at (0, h*(1-s))
      { x: 0, y: GAME.HEIGHT - 224 * hudScale, width: 390 * hudScale, height: 224 * hudScale },
      // bottomCenter: ability bar is capped at scale 1.0 so this region remains unscaled
      { x: GAME.WIDTH / 2 - 310, y: GAME.HEIGHT - 122, width: 620, height: 122 },
      ...floorTwoFamilyRegion,
    ],
  };
}
