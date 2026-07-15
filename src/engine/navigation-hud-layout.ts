import { GAME } from '../shared/constants.js';
import type { ScreenBounds } from './ui-scale.js';
import { ENCOUNTER_PANEL_WIDTH, ENCOUNTER_STACK_HEIGHT } from './hud-encounter-layout.js';

export const NAV_RADAR_DIAMETER = 152;
const NAV_RADAR_MARGIN = 12;
const NAV_RADAR_MAX_SCALE = 1.4;
export const NAV_QUEST_WIDTH = 312;
export const NAV_QUEST_MAX_HEIGHT = 196;
const NAV_QUEST_MAX_SCALE = 1.45;

const RADAR_LABEL_HEIGHT = 22;
const PANEL_GAP = 14;
const HUD_MAX_SCALE = 1.6;
const FAMILY_PANEL_WIDTH = 244;
const FAMILY_PANEL_HEIGHT = 216;
const FAMILY_PANEL_MARGIN_RIGHT = 12;
const FAMILY_PANEL_MARGIN_BOTTOM = 160;
const FAMILY_PANEL_RIGHT_OFFSET = FAMILY_PANEL_WIDTH + FAMILY_PANEL_MARGIN_RIGHT;
const FAMILY_PANEL_BOTTOM_OFFSET = FAMILY_PANEL_HEIGHT + FAMILY_PANEL_MARGIN_BOTTOM;

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

function reserveScaledTopCenterRegion(uiScale: number): ScreenBounds {
  const scale = Math.min(Math.max(1, uiScale), HUD_MAX_SCALE);
  const width = ENCOUNTER_PANEL_WIDTH * scale;
  return {
    x: GAME.WIDTH / 2 - width / 2,
    y: 0,
    width,
    height: ENCOUNTER_STACK_HEIGHT * scale,
  };
}

function reserveScaledBottomRightRegion(uiScale: number): ScreenBounds {
  const scale = Math.min(Math.max(1, uiScale), HUD_MAX_SCALE);
  return {
    x: GAME.WIDTH - FAMILY_PANEL_RIGHT_OFFSET * scale,
    y: GAME.HEIGHT - FAMILY_PANEL_BOTTOM_OFFSET * scale,
    width: FAMILY_PANEL_RIGHT_OFFSET * (scale - 1) + FAMILY_PANEL_WIDTH,
    height: FAMILY_PANEL_BOTTOM_OFFSET * (scale - 1) + FAMILY_PANEL_HEIGHT,
  };
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

  const topCenterReservation = reserveScaledTopCenterRegion(uiScale);
  const bottomLeftReservation = { x: 0, y: GAME.HEIGHT - 224, width: 390, height: 224 };
  const bottomCenterReservation = {
    x: GAME.WIDTH / 2 - 310,
    y: GAME.HEIGHT - 122,
    width: 620,
    height: 122,
  };
  const questScaleBase = Math.min(Math.max(1, uiScale), NAV_QUEST_MAX_SCALE);
  const floorTwo = floor >= 2;
  const floorTwoQuestY = Math.ceil(topCenterReservation.height + PANEL_GAP);
  const floorTwoQuestMaxScale = Math.max(
    1,
    (bottomLeftReservation.y - floorTwoQuestY) / NAV_QUEST_MAX_HEIGHT,
  );
  const questScale = floorTwo ? Math.min(questScaleBase, floorTwoQuestMaxScale) : questScaleBase;
  const questPosition = floorTwo
    ? { x: 16, y: floorTwoQuestY }
    : {
        x: GAME.WIDTH - 16 - NAV_QUEST_WIDTH * questScale,
        y: radarBounds.y + radarBounds.height + PANEL_GAP,
      };
  const floorTwoFamilyRegion: ScreenBounds[] =
    floor >= 2 ? [reserveScaledBottomRightRegion(uiScale)] : [];

  return {
    radarScale,
    radarBounds,
    questScale,
    questPosition,
    questMaxHeight: NAV_QUEST_MAX_HEIGHT,
    criticalHudRegions: [
      topCenterReservation,
      bottomLeftReservation,
      bottomCenterReservation,
      ...floorTwoFamilyRegion,
    ],
  };
}
