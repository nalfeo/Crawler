import { afterEach, describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../src/shared/constants.js';
import { initializeFloor2Scenario } from '../../src/game/floor2Scenario.js';
import { getFloorManifest, registerFloorManifest } from '../../src/shared/floor-registry.js';
import { createTestWorld } from '../helpers/world-factory.js';

const originalFloor2Manifest = structuredClone(getFloorManifest('floor2')!);

function createScenarioWorld() {
  const world = createTestWorld({ seed: 42, floor: 2 });
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
}

afterEach(() => {
  registerFloorManifest('floor2', structuredClone(originalFloor2Manifest));
});

describe('initializeFloor2Scenario manifest validation', () => {
  it('throws an actionable error when familyPool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['unknown-family'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.familyPool contains unknown family ids/,
    );
  });

  it('throws an actionable error when familyPool resolves below roster minimum', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['goblins', 'llamas', 'pandas'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(/minimum 4 required/);
  });

  it('throws an actionable error when resourcePool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      resourcePool: ['unknown-resource'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.resourcePool contains unknown resource ids/,
    );
  });

  it('throws an actionable error when settlement shopArchetypes contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      settlement: {
        ...badManifest.floor2!.settlement,
        shopCountRange: badManifest.floor2!.settlement?.shopCountRange ?? [1, 1],
        shopArchetypes: ['unknown-archetype'],
      },
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.settlement\.shopArchetypes contains unknown ids/,
    );
  });
});

describe('Floor 2 stair marker radius', () => {
  it('keeps FLOOR2_STAIR_MARKER_RADIUS_FT in lockstep with the floor2 manifest markerRadiusFt', () => {
    // Floor 2 is not yet fully data-driven: the engine/game read the radius from
    // the shared constant, while the manifest carries its own markerRadiusFt.
    // This assertion is the drift guard promised by the constant's doc comment.
    expect(FLOOR2_STAIR_MARKER_RADIUS_FT).toBe(originalFloor2Manifest.objectives.markerRadiusFt);
  });
});
