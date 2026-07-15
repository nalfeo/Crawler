import { describe, expect, it } from 'vitest';
import {
  BOSS_PANEL_HEIGHT,
  ENCOUNTER_FIRST_ROW_Y,
  ENCOUNTER_ROW_GAP,
  ellipsizeEncounterLabel,
  resolveEncounterStackLayout,
} from '../../src/engine/hud-encounter-layout.js';

describe('resolveEncounterStackLayout', () => {
  it('reuses the first transient row when only one encounter widget is visible', () => {
    expect(resolveEncounterStackLayout(true, false)).toEqual({
      bossTop: ENCOUNTER_FIRST_ROW_Y,
      announcementTop: null,
    });
    expect(resolveEncounterStackLayout(false, true)).toEqual({
      bossTop: null,
      announcementTop: ENCOUNTER_FIRST_ROW_Y,
    });
  });

  it('stacks announcements below the boss with a fixed breathing gap', () => {
    expect(resolveEncounterStackLayout(true, true)).toEqual({
      bossTop: ENCOUNTER_FIRST_ROW_Y,
      announcementTop: ENCOUNTER_FIRST_ROW_Y + BOSS_PANEL_HEIGHT + ENCOUNTER_ROW_GAP,
    });
  });
});

describe('ellipsizeEncounterLabel', () => {
  it('normalizes whitespace and preserves labels that fit', () => {
    expect(ellipsizeEncounterLabel('  Slime   Rat  ', 20)).toBe('Slime Rat');
  });

  it('truncates extreme names with a visible ellipsis inside the budget', () => {
    const label = ellipsizeEncounterLabel('Grand Matriarch of the Razor-Beaked Geese', 20);
    expect(label).toBe('Grand Matriarch of…');
    expect(label.length).toBeLessThanOrEqual(20);
  });
});
