export const ENCOUNTER_FIRST_ROW_Y = 60;
export const ENCOUNTER_ROW_GAP = 6;
export const ENCOUNTER_PANEL_WIDTH = 420;
export const BOSS_PANEL_HEIGHT = 60;
export const ANNOUNCEMENT_PANEL_HEIGHT = 50;
export const ENCOUNTER_STACK_HEIGHT =
  ENCOUNTER_FIRST_ROW_Y + BOSS_PANEL_HEIGHT + ENCOUNTER_ROW_GAP + ANNOUNCEMENT_PANEL_HEIGHT;

export interface EncounterStackLayout {
  readonly bossTop: number | null;
  readonly announcementTop: number | null;
}

export function resolveEncounterStackLayout(
  bossVisible: boolean,
  announcementVisible: boolean,
): EncounterStackLayout {
  return {
    bossTop: bossVisible ? ENCOUNTER_FIRST_ROW_Y : null,
    announcementTop: announcementVisible
      ? bossVisible
        ? ENCOUNTER_FIRST_ROW_Y + BOSS_PANEL_HEIGHT + ENCOUNTER_ROW_GAP
        : ENCOUNTER_FIRST_ROW_Y
      : null,
  };
}

export function ellipsizeEncounterLabel(value: string, maxCharacters: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxCharacters) return normalized;
  if (maxCharacters <= 1) return '…';
  return `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`;
}
