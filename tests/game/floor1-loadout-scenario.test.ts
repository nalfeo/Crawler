import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { getActiveWeapon } from '../../src/game/weaponSystem.js';
import {
  DEFAULT_FLOOR1_LOADOUT_CHOICE,
  applyFloor1LoadoutChoice,
  createFloor1LoadoutScenario,
} from '../../src/game/scenarios/floorLoadoutScenario.js';

describe('floor1LoadoutScenario', () => {
  it('builds an extensible picker scenario with selectable options', () => {
    const scenario = createFloor1LoadoutScenario();

    expect(scenario.title).toContain('loadout');
    expect(scenario.options.length).toBeGreaterThanOrEqual(3);
    expect(scenario.allowCancel).toBe(true);
    expect(scenario.defaultOptionId).toBe(DEFAULT_FLOOR1_LOADOUT_CHOICE);
  });

  it('applies selected loadout choice by equipping active weapon', () => {
    const world = createTestWorld();

    const selected = applyFloor1LoadoutChoice(world, 'bow');
    expect(selected).toBe('bow');
    expect(getActiveWeapon(world)?.id).toBe('bow');
  });

  it('applies baseball-bat loadout choice', () => {
    const world = createTestWorld();

    const selected = applyFloor1LoadoutChoice(world, 'baseball-bat');
    expect(selected).toBe('baseball-bat');
    expect(getActiveWeapon(world)?.id).toBe('baseball-bat');
  });

  it('falls back to default when choice id is unknown', () => {
    const world = createTestWorld();

    const selected = applyFloor1LoadoutChoice(world, 'unknown-choice');
    expect(selected).toBe(DEFAULT_FLOOR1_LOADOUT_CHOICE);
    expect(getActiveWeapon(world)?.id).toBe(DEFAULT_FLOOR1_LOADOUT_CHOICE);
  });

  it('uses default loadout when scenario is cancelled', () => {
    const world = createTestWorld();
    const scenario = createFloor1LoadoutScenario();

    scenario.onCancel?.(world);
    expect(getActiveWeapon(world)?.id).toBe(DEFAULT_FLOOR1_LOADOUT_CHOICE);
  });
});
