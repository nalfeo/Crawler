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
  const mobileFloorTwo = floor >= 2 && uiScale > 1.2;
  const questPosition = mobileFloorTwo
    ? { x: 16, y: 78 }
    : {
        x: GAME.WIDTH - 16 - NAV_QUEST_WIDTH * questScale,
        y: radarBounds.y + radarBounds.height + PANEL_GAP,
      };

  return {
    radarScale,
    radarBounds,
    questScale,
    questPosition,
    questMaxHeight: NAV_QUEST_MAX_HEIGHT,
    criticalHudRegions: [
      { x: GAME.WIDTH / 2 - 230, y: 0, width: 460, height: 118 },
      { x: 0, y: GAME.HEIGHT - 224, width: 390, height: 224 },
      { x: GAME.WIDTH / 2 - 310, y: GAME.HEIGHT - 122, width: 620, height: 122 },
    ],
  };
}
