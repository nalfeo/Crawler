import { describe, expect, it } from 'vitest';
import {
  isFloorSpawnerArenaExperimentEnabled,
  resolveFloorSpawnerCountOverride,
} from '../../src/shared/spawner-feature-flags.js';

describe('isFloorSpawnerArenaExperimentEnabled', () => {
  it('returns false when query params are missing', () => {
    expect(isFloorSpawnerArenaExperimentEnabled(undefined, {})).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('', {})).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?foo=bar', {})).toBe(false);
  });

  it('accepts truthy flag values', () => {
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=1', {})).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=true', {})).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=YES', {})).toBe(true);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=on', {})).toBe(true);
  });

  it('rejects non-truthy flag values', () => {
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=0', {})).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=false', {})).toBe(false);
    expect(isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=no', {})).toBe(false);
  });

  it('falls back to env when query param is absent', () => {
    expect(isFloorSpawnerArenaExperimentEnabled(undefined, { FLOOR_SPAWNER_ARENAS: '1' })).toBe(
      true,
    );
  });

  it('prefers query value over env value', () => {
    expect(
      isFloorSpawnerArenaExperimentEnabled('?floorSpawnerArenas=0', { FLOOR_SPAWNER_ARENAS: '1' }),
    ).toBe(false);
  });
});

describe('resolveFloorSpawnerCountOverride', () => {
  it('returns null when no valid override exists', () => {
    expect(resolveFloorSpawnerCountOverride(undefined, {})).toBeNull();
    expect(resolveFloorSpawnerCountOverride('?floorSpawnerCount=', {})).toBeNull();
    expect(resolveFloorSpawnerCountOverride('?floorSpawnerCount=-1', {})).toBeNull();
  });

  it('reads a valid query override', () => {
    expect(resolveFloorSpawnerCountOverride('?floorSpawnerCount=4', {})).toBe(4);
    expect(resolveFloorSpawnerCountOverride('?floorSpawnerCount= 2 ', {})).toBe(2);
  });

  it('falls back to env override when query is absent', () => {
    expect(resolveFloorSpawnerCountOverride(undefined, { FLOOR_SPAWNER_COUNT: '3' })).toBe(3);
  });

  it('prefers query override over env override', () => {
    expect(
      resolveFloorSpawnerCountOverride('?floorSpawnerCount=1', { FLOOR_SPAWNER_COUNT: '4' }),
    ).toBe(1);
  });
});
