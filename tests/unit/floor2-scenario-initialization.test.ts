import { afterEach, describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
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
      familyPool: ['pack-rats', 'slimes', 'sovran-goons'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /minimum 4 required/,
    );
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
