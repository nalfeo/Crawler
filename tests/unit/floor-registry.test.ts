import { afterEach, describe, expect, it } from 'vitest';
import {
  getOverriddenBuiltInFloorManifestIds,
  getAvailableFloorIds,
  getFloorManifest,
  getNextFloorId,
  hasFloorManifest,
  registerFloorManifest,
  resetBuiltInFloorManifests,
} from '../../src/shared/floor-registry';
import {
  floor1Manifest,
  floor2Manifest,
  type FloorManifestDef,
} from '../../src/shared/floor-manifest';

function makeManifest(id: string): FloorManifestDef {
  return { ...floor1Manifest, id };
}

describe('floor-registry', () => {
  // The registry is module-level singleton state; track ids we add so each test
  // cleans up after itself and the suite stays order-independent.
  const addedIds: string[] = [];

  afterEach(() => {
    resetBuiltInFloorManifests();
    addedIds.length = 0;
  });

  it('resolves the built-in floor1 manifest', () => {
    expect(getFloorManifest('floor1')).toEqual(floor1Manifest);
    expect(hasFloorManifest('floor1')).toBe(true);
  });

  it('resolves the built-in floor2 manifest', () => {
    expect(getFloorManifest('floor2')).toEqual(floor2Manifest);
    expect(hasFloorManifest('floor2')).toBe(true);
  });

  it('returns undefined for an unknown floor id', () => {
    expect(getFloorManifest('does-not-exist')).toBeUndefined();
    expect(hasFloorManifest('does-not-exist')).toBe(false);
  });

  it('lists available floor ids including the built-in floor', () => {
    expect(getAvailableFloorIds()).toContain('floor1');
    expect(getAvailableFloorIds()).toContain('floor2');
  });

  it('registers a new manifest and makes it discoverable', () => {
    const manifest = makeManifest('floor-test-register');
    addedIds.push('floor-test-register');
    registerFloorManifest('floor-test-register', manifest);

    expect(hasFloorManifest('floor-test-register')).toBe(true);
    expect(getFloorManifest('floor-test-register')).toBe(manifest);
    expect(getAvailableFloorIds()).toContain('floor-test-register');
  });

  it('overwrites an existing registration', () => {
    const first = makeManifest('floor-test-overwrite');
    const second = makeManifest('floor-test-overwrite');
    addedIds.push('floor-test-overwrite');

    registerFloorManifest('floor-test-overwrite', first);
    registerFloorManifest('floor-test-overwrite', second);

    expect(getFloorManifest('floor-test-overwrite')).toBe(second);
  });

  it('restores built-in manifests while preserving custom registrations', () => {
    const contaminatedFloor2 = structuredClone(floor2Manifest);
    contaminatedFloor2.timer.durationMs += 1;
    const customManifest = makeManifest('floor-test-custom');
    addedIds.push('floor-test-custom');

    registerFloorManifest('floor2', contaminatedFloor2);
    registerFloorManifest('floor-test-custom', customManifest);

    expect(getOverriddenBuiltInFloorManifestIds()).toEqual(['floor2']);

    resetBuiltInFloorManifests();

    expect(getFloorManifest('floor2')).toEqual(floor2Manifest);
    expect(getFloorManifest('floor-test-custom')).toBe(customManifest);
    expect(getOverriddenBuiltInFloorManifestIds()).toEqual([]);
  });

  it('detects and restores in-place built-in manifest mutation', () => {
    const floor1 = getFloorManifest('floor1');
    expect(floor1).toBeDefined();
    floor1!.timer.durationMs += 1;

    expect(getOverriddenBuiltInFloorManifestIds()).toEqual(['floor1']);

    resetBuiltInFloorManifests();

    expect(getFloorManifest('floor1')).toEqual(floor1Manifest);
    expect(getOverriddenBuiltInFloorManifestIds()).toEqual([]);
  });

  describe('getNextFloorId', () => {
    it('returns undefined for the last floor in sequence', () => {
      const ids = getAvailableFloorIds();
      expect(getNextFloorId(ids.at(-1)!)).toBeUndefined();
    });

    it('returns undefined for an unknown floor id', () => {
      expect(getNextFloorId('unknown-floor')).toBeUndefined();
    });

    it('returns the next floor when one exists', () => {
      addedIds.push('floor-test-next-a', 'floor-test-next-b');
      registerFloorManifest('floor-test-next-a', makeManifest('floor-test-next-a'));
      registerFloorManifest('floor-test-next-b', makeManifest('floor-test-next-b'));

      const ids = getAvailableFloorIds();
      expect(getNextFloorId('floor-test-next-a')).toBe(ids[ids.indexOf('floor-test-next-a') + 1]);
    });
  });
});
