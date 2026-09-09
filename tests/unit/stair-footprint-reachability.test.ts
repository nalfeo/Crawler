/**
 * Floor-exit stairs — 2x2-tile footprint and interaction reachability.
 *
 * The stairs must RENDER as exactly two tiles across and stay reachable from
 * every approach inside that footprint. Both properties are driven by the same
 * `radiusFt` the scenario contract publishes, so this suite pins that value on
 * every real stair projection (Floor 1, Floor 2, Floor 3, every Floor 4 Green
 * Room exit, Floor 6), runs it through the REAL render fit
 * (`resolveStairsContainFit`, what `MainGameScene.renderStaircaseMarker` calls)
 * and through the REAL interaction predicate (`isPlayerWithinStairMarker`, what
 * the scene's descend affordance and the AI-runner lab call) at the footprint
 * boundary.
 */
import { describe, expect, it } from 'vitest';
import { spawnPlayer, recruitPartyCompanion } from '../../src/core/helpers.js';
import { AI_TYPE } from '../../src/game/index.js';
import { resolveStairsContainFit } from '../../src/engine/sprites/stairs-visuals.js';
import { asFamilyId, asResourceId } from '../../src/core/faction-relations.js';
import {
  initializeFloor1Scenario,
  confirmFloor1StairDescend,
} from '../../src/game/floorScenario.js';
import { initializeFloor3Scenario } from '../../src/game/floor3Scenario.js';
import {
  arenaDirectorSystem,
  confirmFloor4GreenRoomInteraction,
  initializeFloor4Scenario,
} from '../../src/game/floor4Scenario.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { STAIR_FOOTPRINT_RADIUS_FT, TeamId } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import {
  isPlayerWithinStairMarker,
  type ScenarioStairMarkerState,
} from '../../src/shared/scenario-presentation.js';
import { ftToPx } from '../../src/shared/units.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import type { OpaqueBounds } from '../../src/shared/generated-assets.js';

/** The real measured shape of `the-stairs-var-0`: a full-bleed square tile. */
const STAIRS_BOUNDS: OpaqueBounds = {
  x: 0,
  y: 0,
  width: 512,
  height: 512,
  canvasWidth: 512,
  canvasHeight: 512,
};

/** Every shipped floor manifest authors 4 ft tiles; the stairs cover 2x2 of them. */
const TILE_SIZE_FT = 4;
const FOOTPRINT_TILES = 2;

/** Drawn size (px) of the stairs art for a marker of `radiusFt`, via the real fit. */
function drawnFootprintPx(radiusFt: number): { widthPx: number; heightPx: number } {
  const fit = resolveStairsContainFit({
    bounds: STAIRS_BOUNDS,
    canvasWidth: STAIRS_BOUNDS.canvasWidth,
    canvasHeight: STAIRS_BOUNDS.canvasHeight,
    markerRadiusPx: ftToPx(radiusFt),
  });
  return {
    widthPx: STAIRS_BOUNDS.width * fit.scale,
    heightPx: STAIRS_BOUNDS.height * fit.scale,
  };
}

/** Assert a live marker renders two tiles across and is reachable across that square. */
function expectTwoTileFootprintAndReachability(
  marker: ScenarioStairMarkerState | null | undefined,
): void {
  expect(marker).toBeTruthy();
  const radiusFt = marker!.radiusFt;
  expect(radiusFt).toBe(STAIR_FOOTPRINT_RADIUS_FT);
  expect(radiusFt * 2).toBe(FOOTPRINT_TILES * TILE_SIZE_FT);

  // Rendered dimensions: the art fills exactly a 2-tile square in render px.
  const expectedPx = ftToPx(FOOTPRINT_TILES * TILE_SIZE_FT);
  expect(drawnFootprintPx(radiusFt)).toEqual({ widthPx: expectedPx, heightPx: expectedPx });

  // Interaction reachability at every intended approach: dead centre, each
  // cardinal edge of the footprint, and the diagonal corner all read as
  // inside; a step beyond the footprint reads as outside. Edge probes sit a
  // hair inside the radius so the assertion tests the footprint, not
  // floating-point rounding of the marker's fractional world position.
  const { x, y } = marker!.positionFt;
  const edge = radiusFt * 0.999;
  const diagonal = edge / Math.SQRT2;
  const inside: ReadonlyArray<readonly [number, number]> = [
    [x, y],
    [x + edge, y],
    [x - edge, y],
    [x, y + edge],
    [x, y - edge],
    [x + diagonal, y + diagonal],
    [x - diagonal, y - diagonal],
  ];
  for (const [px, py] of inside) {
    expect(isPlayerWithinStairMarker(marker, px, py)).toBe(true);
  }
  const outside: ReadonlyArray<readonly [number, number]> = [
    [x + radiusFt + 0.5, y],
    [x, y - radiusFt - 0.5],
    [x + radiusFt, y + radiusFt],
  ];
  for (const [px, py] of outside) {
    expect(isPlayerWithinStairMarker(marker, px, py)).toBe(false);
  }
}

describe('floor-exit stairs render as a 2x2-tile footprint and stay reachable across it', () => {
  it('floor1', () => {
    const scenario = getScenarioDefinition('floor1');
    const { world } = createFloor1World();
    expectTwoTileFootprintAndReachability(scenario.getStairMarkerState?.(world));
  });

  it('floor2', () => {
    const scenario = getScenarioDefinition('floor2');
    const world = createTestWorld({ seed: 4285, floor: 2 });
    spawnPlayer(world, 0, 0);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [asFamilyId('rats')],
        contestedResource: asResourceId('cheese'),
        betrayerFlag: false,
        staircasePos: { x: 40, y: 60 },
        staircaseSpawned: true,
        staircaseUnlocked: true,
      },
    } as GameWorld['floorExtendedState'];
    expectTwoTileFootprintAndReachability(scenario.getStairMarkerState?.(world));
  });

  it('floor3', () => {
    const scenario = getScenarioDefinition('floor3');
    const world = createTestWorld({ seed: 4285, floor: 3 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, player);
    const state = world.floorExtendedState!.floor3Studios!;
    state.staircasePos = { x: 52, y: 24 };
    state.staircaseSpawned = true;
    state.staircaseUnlocked = true;
    state.staircaseDiscovered = false;
    state.keptCompanionEid = recruitPartyCompanion(world, {
      x: 0,
      y: 0,
      hp: 10,
      aiType: AI_TYPE.CHASE,
      speed: 0.1,
      aggroRange: 999,
      attackRange: 0,
      speciesToken: 0,
      level: 1,
      ownerTeam: TeamId.PLAYER,
    });
    expectTwoTileFootprintAndReachability(scenario.getStairMarkerState?.(world));
  });

  it('floor4 green room exit (every intermission)', () => {
    const scenario = getScenarioDefinition('floor4');
    const world = createTestWorld({ seed: 4285, floor: 4 });
    const player = spawnPlayer(world, 0, 0);
    const phase = getFloorManifest('floor4')!.floor4!.phase;
    initializeFloor4Scenario(world, player);

    world.elapsedMs += phase.countdownMs;
    arenaDirectorSystem(world);
    for (let act = 1; act <= phase.actCount; act += 1) {
      world.elapsedMs += phase.waveWindowMs;
      arenaDirectorSystem(world);
      const headliner = world.floorExtendedState?.floor4Arena?.activeHeadliner?.bossEid;
      expect(headliner).toBeDefined();
      world.stores.health.current[headliner!] = 0;
      arenaDirectorSystem(world);
      world.elapsedMs += phase.headlineWindowMs;
      arenaDirectorSystem(world);
      world.elapsedMs += phase.intermissionMs;
      arenaDirectorSystem(world);

      const marker = scenario.getStairMarkerState?.(world);
      expectTwoTileFootprintAndReachability(marker);

      // The confirmation runs the same footprint predicate, so standing at the
      // footprint boundary must advance the act, and a step outside must not.
      world.playerInSafeRoom = true;
      world.stores.position.x[player] = marker!.positionFt.x + marker!.radiusFt + 0.5;
      world.stores.position.y[player] = marker!.positionFt.y;
      expect(confirmFloor4GreenRoomInteraction(world, player)).toBe(false);
      world.stores.position.x[player] = marker!.positionFt.x + marker!.radiusFt * 0.999;
      expect(confirmFloor4GreenRoomInteraction(world, player)).toBe(true);
    }
  });

  it('floor6 relay exit', () => {
    const scenario = getScenarioDefinition('floor6');
    const world = createTestWorld({ seed: 4285, floor: 6 });
    const player = spawnPlayer(world, 0, 0);
    scenario.configureWorld(world, player);
    const defense = world.floorExtendedState!.floor6Defense!;
    defense.phase = { kind: 'VICTORY' };
    defense.exit.opened = true;
    expectTwoTileFootprintAndReachability(scenario.getStairMarkerState?.(world));
  });
});

describe('floor1 stair footprint is independent of the generic objective marker radius', () => {
  it('descends from the footprint boundary while safe-room discovery keeps its own radius', () => {
    const { world, player } = createFloor1World();
    const objective = world.floorScenario!.objective;

    // The generic objective radius still drives unrelated discovery checks
    // (safe-room discovery) and must NOT have been shrunk to size the stairs.
    expect(objective.markerRadiusFt).toBeGreaterThan(STAIR_FOOTPRINT_RADIUS_FT);

    const marker = getScenarioDefinition('floor1').getStairMarkerState!(world);
    const boundaryX = marker!.positionFt.x + marker!.radiusFt * 0.999;
    const boundaryY = marker!.positionFt.y;
    world.stores.position.x[player] = boundaryX;
    world.stores.position.y[player] = boundaryY;
    expect(isPlayerWithinStairMarker(marker, boundaryX, boundaryY)).toBe(true);
    expect(confirmFloor1StairDescend(world, player)).toBe(true);
  });
});

function createFloor1World(): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed: 4285, floor: 1 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  const objective = world.floorScenario!.objective;
  objective.staircaseSpawned = true;
  objective.staircaseUnlocked = true;
  objective.staircaseDiscovered = false;
  world.state = 'playing';
  return { world, player };
}
