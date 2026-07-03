import { describe, expect, it, vi } from 'vitest';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import * as floorRegistry from '../../src/shared/floor-registry.js';

describe('scenario definitions', () => {
  it('returns floor1 scenario with loadout selector', () => {
    const scenario = getScenarioDefinition('floor1');
    expect(typeof scenario.configureWorld).toBe('function');
    expect(typeof scenario.selectLoadoutOption).toBe('function');
    expect(scenario.director.intro.length).toBeGreaterThan(0);
  });

  it('returns floor2 scenario with director copy', () => {
    const scenario = getScenarioDefinition('floor2');
    expect(typeof scenario.configureWorld).toBe('function');
    expect(scenario.selectLoadoutOption).toBeUndefined();
    expect(scenario.director.victory).toContain('Floor 2');
  });

  it('throws when a manifest exists but no scenario is registered', () => {
    const realGetFloorManifest = floorRegistry.getFloorManifest;
    const floor2Manifest = realGetFloorManifest('floor2');
    expect(floor2Manifest).toBeDefined();
    const manifestSpy = vi.spyOn(floorRegistry, 'getFloorManifest').mockImplementation((floorId) =>
      floorId === 'floor-test-unregistered'
        ? ({ ...floor2Manifest!, id: floorId, name: 'Floor Test Unregistered' } as never)
        : realGetFloorManifest(floorId),
    );

    expect(() => getScenarioDefinition('floor-test-unregistered')).toThrowError(
      /No scenario definition registered for floor manifest/,
    );
    manifestSpy.mockRestore();
  });
});
