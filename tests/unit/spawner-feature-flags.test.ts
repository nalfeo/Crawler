import { describe, expect, it } from 'vitest';
import { isFloorSpawnerArenaExperimentEnabled } from '../../src/shared/spawner-feature-flags.js';

describe('isFloorSpawnerArenaExperimentEnabled', () => {
  it('returns false when query params are missing', () => {
    expect(isFloorSpawnerArenaExperimentEnabled(undefined)).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('')).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?foo=bar')).toBe(false);
  });

  it('accepts truthy flag values', () => {
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=1')).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=true')).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=YES')).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=on')).toBe(true);
  });

  it('rejects non-truthy flag values', () => {
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=0')).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=false')).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=no')).toBe(false);
  });
});
