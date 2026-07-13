/**
 * Natural Floor-1 caging test — asserts that the dynamic barrier primitive
 * physically cages the player when a spawner arena arms during a real
 * Floor-1 run.
 *
 * This is the hard-requirement backstop for the rule-12 miss on PR #764:
 * regardless of whether the arena's ring lands on floor tiles, walls, or a
 * mix, the player CANNOT walk through a barrier tile until the spawner
 * dies. The test drives the real Floor-1 map + real simulation-step pipeline
 * across a range of natural seeds (1..8) — a bug that only cages on lucky
 * geometry would fail on at least one seed. Floor 1 is intentionally
 * spawner-free on main, so the test deterministically injects one real spawner
 * at the player's spawn tile (a fixture-placement hook, not a per-tick cheat);
 * every caging assertion still runs against the real map + real pipeline.
 *
 * Assertions (per seed):
 *   - Arena arms on tick 1, barrier registry is populated.
 *   - The player's tile is NEVER a barrier tile while driving outward.
 *   - The player's containment area holds:
 *       open-fence: distance(player, spawner) <= radiusFt + tileSize * 1.5
 *       sealed-room: player's tile is still inside the spawner's room
 *   - On spawner kill, arena resolves to state 2, barrier registry drops
 *     the entry, and every previously-blocked tile is now passable via
 *     floorMap.isPassableAt.
 */
import { describe, expect, it } from 'vitest';
import { setComponent } from 'bitecs';
import { Position } from '../../src/core/components.js';
import { createGameWorld, spawnPlayer } from '../../src/core/index.js';
import { spawnSpawner } from '../../src/core/helpers.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { getScenarioDefinition } from '../../src/game/scenarioDefinitions.js';
import { createFloor1MainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import type { GameWorld } from '../../src/core/world.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

function distance(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x0 - x1, y0 - y1);
}

function roomIdAt(world: GameWorld, xFt: number, yFt: number): number {
  const floorMap = world.floorMap!;
  const t = floorMap.worldToTile(xFt, yFt);
  return floorMap.roomGraph.getRoomAt(t.x, t.y);
}

function tileIndexAt(world: GameWorld, xFt: number, yFt: number): number {
  const floorMap = world.floorMap!;
  const t = floorMap.worldToTile(xFt, yFt);
  return t.y * floorMap.tileMap.width + t.x;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe.each(SEEDS)('spawner-arena caging on natural Floor-1 (seed %i)', (seed) => {
  it('physically cages the player once armed; releases on spawner kill', () => {
    // ── (1) Boot real Floor 1.
    const world = createGameWorld({ seed });
    const playerEid = spawnPlayer(world, 400, 400);
    const scenario = getScenarioDefinition('floor1');
    scenario.configureWorld(world, playerEid);
    if (world.state === 'loadout' && world.floor) {
      scenario.selectLoadoutOption?.(world, 0);
    }
    expect(world.floorMap).not.toBeNull();
    const floorMap = world.floorMap!;

    // ── (2) Inject a real spawner onto the REAL Floor-1 map.
    // Floor 1 is intentionally spawner-free on main (see floorScenario.ts:
    // FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS === []), so a real run places no
    // Spawner entities. To exercise the barrier primitive against real map
    // geometry + the real simulation-step pipeline we deterministically place a
    // single real spawner at the player's spawn tile (guaranteed passable, in a
    // real room) via the same spawnSpawner API the scenario machinery uses.
    // This is a fixture-placement hook, NOT a per-tick cheat — the caging
    // assertions below still run entirely against the real pipeline.
    const spawnX = world.stores.position.x[playerEid]!;
    const spawnY = world.stores.position.y[playerEid]!;
    const spawnerEid = spawnSpawner(world, spawnX, spawnY, RATS_NEST.hp, {
      defIndex: RATS_NEST_INDEX,
      contactDamage: RATS_NEST.contactDamage,
      arenaRadiusFt: RATS_NEST.arenaRadiusFt,
    });
    const sx = world.stores.position.x[spawnerEid]!;
    const sy = world.stores.position.y[spawnerEid]!;
    const radiusFt = world.stores.spawner.arenaRadiusFt[spawnerEid]!;
    expect(radiusFt).toBeGreaterThan(0);

    // ── (3) Scenario hook: place the player one foot outside the spawner so
    // the arena arms on tick 1. This is the acceptance-§8 scenario hook
    // (deterministic placement, NOT a per-tick cheat) — the caging
    // assertion below runs against the real pipeline.
    setComponent(world.ecs, playerEid, Position, { x: sx + 1, y: sy });
    const inputState = createInputState();

    // Canonical pre/post systems from the shared source of truth (same as the
    // visual pipeline uses). spawnerArenaSystem in preSystems is what arms the
    // arena; without it the spawner stays idle.
    const sceneSystems = createFloor1MainSceneOptions();
    const simOpts = {
      preSystems: sceneSystems.preSystems,
      postSystems: sceneSystems.postSystems,
    } as const;

    // Give the player near-invulnerable HP so ambient enemies don't end the
    // run before the caging assertions land — we're testing the barrier
    // primitive, not survival. Refresh every tick to counter any damage.
    const KEEP_ALIVE_HP = 100_000;
    world.stores.health.max[playerEid] = KEEP_ALIVE_HP;
    world.stores.health.current[playerEid] = KEEP_ALIVE_HP;

    // Tick once to arm the arena.
    runSimulationStep(world, inputState, GAME.DELTA_MS, simOpts);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);

    // arenaKind 0 = sealed-room (doorway barrier → blocked TILES),
    // 1 = open-fence (analytic ring WALL → a sub-tile shape, zero tiles).
    const arenaKind = world.stores.spawner.arenaKind[spawnerEid]!;
    if (arenaKind === 0) {
      expect(world.barriers.blockedTiles.size).toBeGreaterThan(0);
    } else {
      // Open-fence cages with a smooth 1 ft ring wall, not tiles.
      expect(world.barriers.ringShapes.size).toBeGreaterThan(0);
      expect(world.barriers.blockedTiles.size).toBe(0);
    }

    const barrierTilesSnapshot = Array.from(world.barriers.blockedTiles);
    // Every barrier tile is currently non-passable — primitive contract.
    for (const idx of barrierTilesSnapshot) {
      const tx = idx % floorMap.tileMap.width;
      const ty = Math.floor(idx / floorMap.tileMap.width);
      const wx = (tx + 0.5) * floorMap.config.tileSizeFt;
      const wy = (ty + 0.5) * floorMap.config.tileSizeFt;
      expect(floorMap.isPassableAt(wx, wy)).toBe(false);
    }

    // ── (4) Compute containment area based on arenaKind.
    const spawnerRoomId = arenaKind === 0 ? roomIdAt(world, sx, sy) : -1;
    const tileSizeFt = floorMap.config.tileSizeFt;
    const containmentBudget = radiusFt + tileSizeFt * 1.5;

    // Drive the real pipeline, pushing input radially OUTWARD every tick.
    for (let tick = 0; tick < 240; tick += 1) {
      world.stores.health.current[playerEid] = KEEP_ALIVE_HP;
      const px = world.stores.position.x[playerEid]!;
      const py = world.stores.position.y[playerEid]!;
      const dx = px - sx;
      const dy = py - sy;
      const len = Math.hypot(dx, dy) || 1;
      inputState.moveX = dx / len;
      inputState.moveY = dy / len;
      runSimulationStep(world, inputState, GAME.DELTA_MS, simOpts);

      const npx = world.stores.position.x[playerEid]!;
      const npy = world.stores.position.y[playerEid]!;
      // (a) Player never occupies a barrier tile (impenetrability) and never
      // ends a tick standing INSIDE a barrier — for the analytic ring this is
      // the sub-tile check the tile test can't express.
      const playerTileIdx = tileIndexAt(world, npx, npy);
      expect(world.barriers.blockedTiles.has(playerTileIdx)).toBe(false);
      expect(floorMap.isPassableAt(npx, npy)).toBe(true);
      // (b) Containment area holds.
      if (arenaKind === 1) {
        // open-fence: disc containment.
        expect(distance(npx, npy, sx, sy)).toBeLessThanOrEqual(containmentBudget);
      } else {
        // sealed-room: player stays in the spawner's room (or lands on a
        // tile whose room id is -1 only transiently at a doorway — but the
        // doorway barrier plugs it, so this shouldn't happen).
        expect(roomIdAt(world, npx, npy)).toBe(spawnerRoomId);
      }
    }
    // Arena still armed after the outbound drive.
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);
    if (arenaKind === 0) {
      expect(world.barriers.blockedTiles.size).toBeGreaterThan(0);
    } else {
      expect(world.barriers.ringShapes.size).toBeGreaterThan(0);
    }

    // ── (5) Kill the spawner and tick until the arena system resolves
    // (spawnerArenaSystem waits for deathResolved before dropping barriers).
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    inputState.moveX = 0;
    inputState.moveY = 0;
    for (let tick = 0; tick < 20; tick += 1) {
      world.stores.health.current[playerEid] = KEEP_ALIVE_HP;
      runSimulationStep(world, inputState, GAME.DELTA_MS, simOpts);
      if ((world.stores.spawner.arenaState[spawnerEid] ?? 0) === 2) break;
    }
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect(world.spawnerArenaBarriers.has(spawnerEid)).toBe(false);
    // Both barrier representations are fully released on resolve.
    expect(world.barriers.ringShapes.size).toBe(0);

    // Every tile that was previously part of the arena barrier and whose
    // underlying tile is passable is now passable again — the primitive
    // released the cage. (Walls that happen to sit under the ring remain
    // walls, but those weren't passable to begin with.)
    let stillCagedByBarrier = 0;
    for (const idx of barrierTilesSnapshot) {
      const tx = idx % floorMap.tileMap.width;
      const ty = Math.floor(idx / floorMap.tileMap.width);
      if (!floorMap.tileMap.isPassable(tx, ty)) continue;
      const wx = (tx + 0.5) * tileSizeFt;
      const wy = (ty + 0.5) * tileSizeFt;
      if (!floorMap.isPassableAt(wx, wy)) stillCagedByBarrier += 1;
    }
    expect(stillCagedByBarrier).toBe(0);
  });
});
