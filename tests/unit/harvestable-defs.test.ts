import { describe, expect, it } from 'vitest';
import {
  HARVESTABLE_DEFS,
  getHarvestableDef,
  getHarvestableDefByIndex,
} from '../../src/shared/harvestableDefs.js';

describe('HARVESTABLE_DEFS', () => {
  it('contains at least one entry', () => {
    expect(HARVESTABLE_DEFS.length).toBeGreaterThan(0);
  });

  it('every def has required fields', () => {
    for (const def of HARVESTABLE_DEFS) {
      expect(typeof def.id).toBe('string');
      expect(typeof def.label).toBe('string');
      expect(typeof def.itemId).toBe('string');
      expect(typeof def.durationMs).toBe('number');
      expect(typeof def.maxPerFloor).toBe('number');
    }
  });

  it('marks Floor 1 mushrooms as light emitters', () => {
    const crimson = getHarvestableDef('crimson-mushroom');
    const azure = getHarvestableDef('azure-mushroom');
    const sunpetal = getHarvestableDef('sunpetal-flower');

    expect(crimson?.lightEmission).toBeDefined();
    expect(azure?.lightEmission).toBeDefined();
    expect(sunpetal?.lightEmission).toBeUndefined();
  });
});

describe('getHarvestableDef', () => {
  it('returns the def for a known id', () => {
    const def = getHarvestableDef('crimson-mushroom');
    expect(def).toBeDefined();
    expect(def!.id).toBe('crimson-mushroom');
  });

  it('returns undefined for an unknown id', () => {
    expect(getHarvestableDef('no-such-node')).toBeUndefined();
  });
});

describe('getHarvestableDefByIndex', () => {
  it('returns the def at a valid index', () => {
    const def = getHarvestableDefByIndex(0);
    expect(def).toBeDefined();
    expect(def!.id).toBe(HARVESTABLE_DEFS[0]!.id);
  });

  it('returns the def at the last valid index', () => {
    const last = HARVESTABLE_DEFS.length - 1;
    const def = getHarvestableDefByIndex(last);
    expect(def).toBeDefined();
    expect(def!.id).toBe(HARVESTABLE_DEFS[last]!.id);
  });

  it('returns undefined for an out-of-bounds index', () => {
    expect(getHarvestableDefByIndex(HARVESTABLE_DEFS.length)).toBeUndefined();
    expect(getHarvestableDefByIndex(-1)).toBeUndefined();
  });
});
