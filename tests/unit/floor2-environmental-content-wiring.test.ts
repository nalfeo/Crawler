/**
 * Source wiring tests — prove that floor2Scenario.ts contains the
 * spawnFloor2HarvestableNodes call and the placePropsForFloor call so that
 * lab-only validation cannot be mistaken for real game wiring.
 *
 * Pattern mirrors tests/unit/ai-runner-lighting-controls.test.ts:
 * readFileSync + toContain, no runtime environment needed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Floor 2 environmental content wiring', () => {
  it('floor2Scenario.ts imports spawnHarvestableNode from core/helpers', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain("import { spawnHarvestableNode } from '../core/helpers.js'");
  });

  it('floor2Scenario.ts imports FLOOR2_HARVESTABLE_START_INDEX and HARVESTABLE_DEFS from harvestableDefs', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain('FLOOR2_HARVESTABLE_START_INDEX');
    expect(source).toContain("from '../shared/harvestableDefs.js'");
  });

  it('floor2Scenario.ts imports placePropsForFloor from propPlacer', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain("import { placePropsForFloor } from './systems/propPlacer.js'");
  });

  it('floor2Scenario.ts defines spawnFloor2HarvestableNodes function', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain('function spawnFloor2HarvestableNodes(world: GameWorld,');
  });

  it('floor2Scenario.ts calls spawnFloor2HarvestableNodes inside initializeFloor2Scenario', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain('spawnFloor2HarvestableNodes(world,');
  });

  it('floor2Scenario.ts calls placePropsForFloor with the manifest props config', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain('placePropsForFloor(world, world.floorMap!');
    expect(source).toContain('manifest.props');
  });

  it('floor2Scenario.ts uses FLOOR2_HARVESTABLE_START_INDEX and FLOOR2_HARVESTABLE_END_INDEX to slice Floor-2 defs', () => {
    const source = readFileSync('src/game/floor2Scenario.ts', 'utf-8');
    expect(source).toContain('FLOOR2_HARVESTABLE_START_INDEX');
    expect(source).toContain('defIndex = FLOOR2_HARVESTABLE_START_INDEX');
    expect(source).toContain('defIndex < FLOOR2_HARVESTABLE_END_INDEX');
  });

  it('floor2.manifest.json has a props block with biomeTag "cave"', () => {
    const manifest = JSON.parse(
      readFileSync('src/shared/data/floors/floor2.manifest.json', 'utf-8'),
    ) as { props?: { biomeTag?: string } };
    expect(manifest.props).toBeDefined();
    expect(manifest.props!.biomeTag).toBe('cave');
  });

  it('floorScenario.ts Floor-1 spawner uses FLOOR2_HARVESTABLE_START_INDEX as loop upper bound', () => {
    const source = readFileSync('src/game/floorScenario.ts', 'utf-8');
    // The Floor 1 spawner must NOT iterate over the full array — it must cap at
    // FLOOR2_HARVESTABLE_START_INDEX to avoid spawning ore/gem nodes on Floor 1.
    expect(source).toContain('FLOOR2_HARVESTABLE_START_INDEX');
    expect(source).toContain('defIndex < FLOOR2_HARVESTABLE_START_INDEX');
    // Must NOT use the uncapped HARVESTABLE_DEFS.length bound in the floor-1 spawner loop.
    expect(source).not.toContain('defIndex < HARVESTABLE_DEFS.length');
  });

  it('prop-lab/index.ts biome dropdown includes "cave"', () => {
    const source = readFileSync('src/labs/prop-lab/index.ts', 'utf-8');
    expect(source).toContain("'cave'");
    expect(source).toContain('biomeTag');
  });
});
