import { describe, expect, it } from 'vitest';
import { EnemyProjectile } from '../../src/core/components.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { query } from 'bitecs';
import { movementSystem, spawnBehaviorEnemy, spawnPlayer } from '../../src/core/index.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { AI_TYPE, PATH_PERSONA, enemyAISystem } from '../../src/game/index.js';
import { makeFlankTargets } from '../../src/game/enemyAISystem.js';
import { asFamilyId } from '../../src/core/faction-relations.js';
import { getWorldFloorBehavior } from '../../src/core/floor-behavior.js';
import { createTestWorld } from '../helpers/world-factory.js';

const TILE = 4;

function mkConfig(width: number, height: number): MapConfig {
  return {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: TILE,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
}

/** Open arena: solid floor interior ringed by a one-tile wall border. */
function openArena(width = 24, height = 18): FloorMap {
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < width; x += 1) {
    tileMap.setFlags(x, 0, TilePresets.WALL);
    tileMap.setFlags(x, height - 1, TilePresets.WALL);
  }
  for (let y = 0; y < height; y += 1) {
    tileMap.setFlags(0, y, TilePresets.WALL);
    tileMap.setFlags(width - 1, y, TilePresets.WALL);
  }
  return new FloorMap(
    mkConfig(width, height),
    tileMap,
    new RoomGraph(),
    new Uint8Array(width * height),
    {
      x: 2,
      y: 2,
    },
  );
}

/** Open arena whose right half is tagged a SAFE room (tiles x>=12). */
function safeRoomArena(): FloorMap {
  const width = 24;
  const height = 18;
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < width; x += 1) {
    tileMap.setFlags(x, 0, TilePresets.WALL);
    tileMap.setFlags(x, height - 1, TilePresets.WALL);
  }
  for (let y = 0; y < height; y += 1) {
    tileMap.setFlags(0, y, TilePresets.WALL);
    tileMap.setFlags(width - 1, y, TilePresets.WALL);
  }
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 12, y: 1, width: 11, height: 16 }, [], [], RoomRole.SAFE);
  return new FloorMap(mkConfig(width, height), tileMap, roomGraph, new Uint8Array(width * height), {
    x: 2,
    y: 2,
  });
}

/** Every tile is a wall — no navigation step is ever passable. */
function fullyWalledArena(width = 10, height = 10): FloorMap {
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.WALL);
  return new FloorMap(
    mkConfig(width, height),
    tileMap,
    new RoomGraph(),
    new Uint8Array(width * height),
    {
      x: 1,
      y: 1,
    },
  );
}

/** A single small walkable island surrounded by walls. */
function islandArena(): FloorMap {
  const width = 40;
  const height = 12;
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.WALL);
  for (let y = 3; y <= 8; y += 1) {
    for (let x = 3; x <= 8; x += 1) {
      tileMap.setFlags(x, y, TilePresets.FLOOR);
    }
  }
  return new FloorMap(
    mkConfig(width, height),
    tileMap,
    new RoomGraph(),
    new Uint8Array(width * height),
    {
      x: 4,
      y: 4,
    },
  );
}

function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

function speedOf(world: ReturnType<typeof createTestWorld>, eid: number): number {
  return Math.hypot(world.stores.velocity.x[eid] ?? 0, world.stores.velocity.y[eid] ?? 0);
}

describe('enemyAISystem — branch coverage hardening', () => {
  it('uses the default enemy speed when a behavior enemy has speed 0', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // speed 0 forces getEnemySpeed()'s fallback to DEFAULT_ENEMY_SPEED (0.1875).
    const enemy = spawnBehaviorEnemy(world, 5, 0, 20, AI_TYPE.CHASE, 0, 25, 0);

    enemyAISystem(world);

    expect(speedOf(world, enemy)).toBeCloseTo(0.1875, 5);
  });

  it('reuses a wander direction across consecutive idle frames', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const player = spawnPlayer(world, ...spread(tileCenter(2, 2)));
    // Out of aggro range so the enemy idles and wanders, with a floor map so the
    // passability + safe-space wander guards are evaluated (not short-circuited).
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(8, 8)),
      20,
      AI_TYPE.CHASE,
      0.25,
      2,
      0,
    );

    world.frameCount = 1;
    enemyAISystem(world);
    const firstVx = world.stores.velocity.x[enemy] ?? 0;
    const firstVy = world.stores.velocity.y[enemy] ?? 0;
    expect(Math.hypot(firstVx, firstVy)).toBeGreaterThan(0.05);

    // Next frame, still inside the chosen wander window and heading into open
    // floor: the enemy keeps its existing direction instead of re-rolling.
    world.frameCount = 2;
    enemyAISystem(world);
    const secondVx = world.stores.velocity.x[enemy] ?? 0;
    const secondVy = world.stores.velocity.y[enemy] ?? 0;
    expect(Math.sign(secondVx)).toBe(Math.sign(firstVx));
    expect(Math.sign(secondVy)).toBe(Math.sign(firstVy));
    void player;
  });

  it('keeps an idle wanderer out of an adjacent safe room', () => {
    const world = createTestWorld();
    world.floorMap = safeRoomArena();
    // Player parked far away in the safe half so the enemy stays de-aggroed.
    spawnPlayer(world, ...spread(tileCenter(20, 8)));
    const safeBoundaryFt = 12 * TILE;
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(9, 8)),
      20,
      AI_TYPE.CHASE,
      0.25,
      3,
      0,
    );

    for (let i = 0; i < 90; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      enemyAISystem(world);
      movementSystem(world);
      // The wander steering actively avoids the safe room; the enemy must never
      // cross into it.
      expect(world.stores.position.x[enemy] ?? 0).toBeLessThan(safeBoundaryFt);
    }
  });

  it('falls back to a random jiggle when every unstuck angle is blocked', () => {
    const world = createTestWorld();
    world.floorMap = fullyWalledArena();
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(5, 4)),
      20,
      AI_TYPE.CHASE,
      0.25,
      50,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    // The enemy can detect the player but cannot path anywhere, so it stays still
    // and accrues stuck frames. Past STUCK_FRAMES_THRESHOLD the unstuck routine
    // exhausts its wide arc (all walls) and emits a last-resort random jiggle —
    // the only possible source of motion in a fully walled arena.
    let sawJiggle = false;
    for (let i = 0; i < 40; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      enemyAISystem(world);
      if (speedOf(world, enemy) > 0.1) {
        sawJiggle = true;
      }
    }
    expect(sawJiggle).toBe(true);
  });

  it('pathing ranged enemies path toward the player while outside attack range', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const player = spawnPlayer(world, ...spread(tileCenter(4, 8)));
    // Distance (~9 tiles) far exceeds the 8 ft attack range, so the ranged path
    // target resolves to the player's tile.
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(13, 8)),
      20,
      AI_TYPE.RANGED,
      0.25,
      100,
      8,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    enemyAISystem(world);

    // Heads left, toward the player.
    expect(world.stores.velocity.x[enemy] ?? 0).toBeLessThan(-0.1);
    void player;
  });

  it('pathing ranged enemies retreat to a standoff tile when too close', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    spawnPlayer(world, ...spread(tileCenter(12, 8)));
    const start = tileCenter(12, 8);
    // ~5 ft from the player with a 15 ft attack range → inside the 7.5 ft retreat
    // band, so the ranged path target is pushed away from the player.
    const enemy = spawnBehaviorEnemy(
      world,
      start.x + 5,
      start.y,
      20,
      AI_TYPE.RANGED,
      0.25,
      100,
      15,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    enemyAISystem(world);

    // Retreats to the right, away from the player.
    expect(world.stores.velocity.x[enemy] ?? 0).toBeGreaterThan(0.1);
  });

  it('pathing ranged enemies strafe inside the band for both tangent signs', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    spawnPlayer(world, ...spread(tileCenter(12, 9)));
    const player = tileCenter(12, 9);
    // ~11.25 ft away with a 15 ft attack range and 7.5 ft retreat band → strafe regime.
    // Two enemies guarantee both even/odd eids (the tangent sign branch).
    const enemyA = spawnBehaviorEnemy(
      world,
      player.x - 11.25,
      player.y,
      20,
      AI_TYPE.RANGED,
      0.25,
      100,
      15,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );
    const enemyB = spawnBehaviorEnemy(
      world,
      player.x + 11.25,
      player.y,
      20,
      AI_TYPE.RANGED,
      0.25,
      100,
      15,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    enemyAISystem(world);

    // Strafing means meaningful vertical (tangential) motion for both.
    expect(Math.abs(world.stores.velocity.y[enemyA] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.abs(world.stores.velocity.y[enemyB] ?? 0)).toBeGreaterThan(0.1);
  });

  it('holds ranged enemies still when no path target is reachable', () => {
    const world = createTestWorld();
    world.floorMap = islandArena();
    // Player marooned in the wall field, unreachable from the island.
    spawnPlayer(world, ...spread(tileCenter(35, 6)));
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(5, 5)),
      20,
      AI_TYPE.RANGED,
      0.25,
      625,
      18.75,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    enemyAISystem(world);

    // Ranged enemies maintain spacing rather than hard-chasing, so with no
    // reachable target they stay put.
    expect(speedOf(world, enemy)).toBe(0);
  });

  it('approaches with pathing when a leaper is outside the pounce band', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const player = spawnPlayer(world, ...spread(tileCenter(4, 8)));
    // Well beyond SLIME_LEAP_RANGE (5 ft) but inside aggro: the leaper hands off
    // to the normal pathing chase branch.
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(14, 8)),
      20,
      AI_TYPE.LEAPER,
      0.1875,
      100,
      0,
      {
        persona: PATH_PERSONA.NAVIGATOR,
      },
    );

    const startX = world.stores.position.x[enemy] ?? 0;
    for (let i = 0; i < 30; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      enemyAISystem(world);
      movementSystem(world);
    }
    expect(world.stores.position.x[enemy] ?? 0).toBeLessThan(startX - 1);
    void player;
  });

  it('reverts a leaper to a normal chase after the player leaves the pounce band', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Start inside the pounce band so a full prep→leap→recover cycle runs.
    const enemy = spawnBehaviorEnemy(world, 10, 0, 20, AI_TYPE.LEAPER, 0.15, 50, 0);

    // Let the slime complete at least one leap+recovery cycle.
    for (let i = 0; i < 70; i += 1) {
      enemyAISystem(world);
      world.frameCount += 1;
      world.elapsedMs += 16;
    }

    // Player escapes far outside the pounce band; the slime must abandon the
    // pounce loop and resume a normal approach.
    world.stores.position.x[player] = 112.5;
    let movedTowardPlayer = false;
    for (let i = 0; i < 60; i += 1) {
      enemyAISystem(world);
      if ((world.stores.velocity.x[enemy] ?? 0) > 0.05) {
        movedTowardPlayer = true;
      }
      world.frameCount += 1;
      world.elapsedMs += 16;
    }
    expect(movedTowardPlayer).toBe(true);
  });

  it('separates a large overlapping pack via the spatial-priority path (>48 mobs)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 25, 0);
    const stacked: number[] = [];
    // 60 > MAX_PAIRWISE_SEPARATION_ENEMIES (48) forces the sort-by-distance,
    // slice-to-cap path; identical positions force the zero-distance push.
    for (let i = 0; i < 60; i += 1) {
      stacked.push(spawnBehaviorEnemy(world, 6.25, 0, 20, AI_TYPE.CHASE, 0.25, 50, 0));
    }

    expect(() => enemyAISystem(world)).not.toThrow();

    // Every velocity is clamped to the speed cap, and at least some mobs were
    // pushed apart (diverging velocities).
    const velocities = stacked.map((eid) => ({
      vx: world.stores.velocity.x[eid] ?? 0,
      vy: world.stores.velocity.y[eid] ?? 0,
    }));
    for (const v of velocities) {
      expect(Math.hypot(v.vx, v.vy)).toBeLessThanOrEqual(0.25 + 0.01);
    }
    const distinct = new Set(velocities.map((v) => `${v.vx.toFixed(3)},${v.vy.toFixed(3)}`));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('handles an enemy sharing the exact player position under the overlap clamp', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const center = tileCenter(12, 9);
    spawnPlayer(world, center.x, center.y);
    // Same point as the player exercises the zero-toward-vector fallback inside
    // the floor-map overlap clamp.
    const enemy = spawnBehaviorEnemy(world, center.x, center.y, 20, AI_TYPE.CHASE, 0.25, 50, 0, {
      persona: PATH_PERSONA.NAVIGATOR,
    });

    expect(() => enemyAISystem(world)).not.toThrow();
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    expect(Number.isFinite(vx)).toBe(true);
    expect(Number.isFinite(vy)).toBe(true);
  });

  it('resolves flank targets for a flanker sitting on the player tile', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const center = tileCenter(12, 9);
    spawnPlayer(world, center.x, center.y);
    // Zero player-offset takes makeFlankTargets()'s degenerate-direction branch.
    const enemy = spawnBehaviorEnemy(world, center.x, center.y, 20, AI_TYPE.CHASE, 0.25, 50, 0, {
      persona: PATH_PERSONA.FLANKER,
    });

    // The degenerate branch must collapse to a single candidate — the player's
    // own tile — rather than fabricating a flank from a zero direction vector.
    const degenerateTargets = makeFlankTargets(
      world,
      enemy,
      center.x,
      center.y,
      center.x,
      center.y,
    );
    expect(degenerateTargets).toHaveLength(1);
    expect(degenerateTargets[0]).toEqual(world.floorMap.worldToTile(center.x, center.y));

    expect(() => enemyAISystem(world)).not.toThrow();
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    // Resolving to its own tile means the flanker stays put — a finite velocity
    // alone would also pass for a regression that drifted the enemy off-tile.
    expect(Number.isFinite(vx)).toBe(true);
    expect(Number.isFinite(vy)).toBe(true);
    expect(speedOf(world, enemy)).toBe(0);
  });

  it('aims a non-degenerate flanker past and to the side of the player', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const playerCenter = tileCenter(12, 9);
    spawnPlayer(world, playerCenter.x, playerCenter.y);
    // Flanker several tiles to the player's left on the same row: a straight
    // chase would target the player's own tile (same row, no lateral offset).
    const enemyCenter = tileCenter(4, 9);
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(enemyCenter),
      20,
      AI_TYPE.CHASE,
      0.25,
      100,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
      },
    );

    const targets = makeFlankTargets(
      world,
      enemy,
      enemyCenter.x,
      enemyCenter.y,
      playerCenter.x,
      playerCenter.y,
    );
    const playerTile = world.floorMap.worldToTile(playerCenter.x, playerCenter.y);

    expect(targets).toHaveLength(4);
    // Only the final fallback is the player's own tile; the earlier candidates
    // must be genuine flanks, otherwise this collapses to a straight chase.
    expect(targets[3]).toEqual(playerTile);
    // Candidate 2 drives straight through the player's row but beyond them.
    expect(targets[2]?.y).toBe(playerTile.y);
    expect(targets[2]?.x).toBeGreaterThan(playerTile.x);
    // Candidates 0 and 1 are the lateral flanks: beyond the player in x AND
    // offset to opposite sides of the player's row (a real lateral approach).
    for (const flank of [targets[0], targets[1]]) {
      expect(flank?.x).toBeGreaterThan(playerTile.x);
      expect(Math.abs((flank?.y ?? playerTile.y) - playerTile.y)).toBeGreaterThanOrEqual(1);
    }
    expect(Math.sign((targets[0]?.y ?? 0) - playerTile.y)).toBe(
      -Math.sign((targets[1]?.y ?? 0) - playerTile.y),
    );
  });

  it('commits a non-degenerate flanker to pursuit instead of stalling', () => {
    const world = createTestWorld();
    world.floorMap = openArena();
    const playerCenter = tileCenter(12, 9);
    spawnPlayer(world, playerCenter.x, playerCenter.y);
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(4, 9)),
      20,
      AI_TYPE.CHASE,
      0.25,
      100,
      0,
      {
        persona: PATH_PERSONA.FLANKER,
      },
    );

    enemyAISystem(world);

    // The flank target sits past the player, so the flanker must actually move
    // toward the player's side with a finite, non-zero velocity (no stall).
    expect(speedOf(world, enemy)).toBeGreaterThan(0);
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    expect(Number.isFinite(vx)).toBe(true);
    expect(Number.isFinite(vy)).toBe(true);
    expect(vx).toBeGreaterThan(0);
  });

  it('fires an enemy projectile from a stationary ranged attacker in range (no floor map)', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    // In attack range, off the cooldown clock, so the accuracy roll and spawn run.
    spawnBehaviorEnemy(world, 15, 0, 20, AI_TYPE.RANGED, 0.1875, 50, 25);
    world.elapsedMs = 10_000;

    let fired = false;
    for (let i = 0; i < 12 && !fired; i += 1) {
      enemyAISystem(world);
      if (query(world.ecs, [EnemyProjectile]).length > 0) {
        fired = true;
      }
      world.frameCount += 1;
      world.elapsedMs += 500;
    }
    expect(fired).toBe(true);
  });
});

/** Spread a {x, y} point into a positional argument pair. */
function spread(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}

describe('enemyAISystem — out-of-aggro enemy still wanders', () => {
  it('runs idle/wander AI for an enemy outside its aggro range', () => {
    // Enemy at ~12 tiles from player (48ft), aggroRange=2ft — it can never
    // detect the player, so it must fall through to idle/wander AI and move,
    // rather than sitting frozen. (This exercises the !canDetectPlayer path.)
    const world = createTestWorld();
    world.floorMap = openArena(24, 18);

    // Player at center, enemy 12 tiles away.
    spawnPlayer(world, ...spread(tileCenter(2, 2)));
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(14, 2)),
      20,
      AI_TYPE.CHASE,
      0.25,
      2, // aggroRange = 2ft — tiny, enemy can never detect player
      0,
    );

    world.frameCount = 1;
    enemyAISystem(world);

    // After one tick the enemy should be executing idle/wander (non-zero velocity).
    const vx = world.stores.velocity.x[enemy] ?? 0;
    const vy = world.stores.velocity.y[enemy] ?? 0;
    expect(Math.hypot(vx, vy)).toBeGreaterThan(0.05);
  });
});

describe('enemyAISystem — Floor 2 boss gating', () => {
  /** Floor-2 family state carrying a single boss encounter for `bossEid`. */
  function withBossEncounter(
    world: ReturnType<typeof createTestWorld>,
    bossEid: number | null,
    started: boolean,
  ): void {
    const familyId = asFamilyId('imps');
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [familyId],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: true,
        trashKillsByFamily: new Map([[familyId, 0]]),
        bossEncounters: new Map([
          [
            familyId,
            {
              familyId,
              roomId: -1,
              doorEids: [],
              activeGoalId: 'floor2-den-imps-boss-active',
              started,
              bossEid,
              defeated: false,
              displayName: 'Imp Boss',
              lootTableId: 'boss',
            },
          ],
        ]),
      },
    };
  }

  it('freezes a den boss whose encounter has not started', () => {
    // A den boss stands dormant in its den until the player triggers the
    // encounter. Without this gate the boss would chase the player through the
    // den door the moment it entered aggro range, before the intro ever ran.
    const world = createTestWorld({ floor: 2 });
    world.floorMap = openArena(24, 18);
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    const boss = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(6, 4)),
      200,
      AI_TYPE.CHASE,
      0.25,
      200, // aggro range easily covers the player
      2,
    );
    withBossEncounter(world, boss, false);

    world.frameCount = 1;
    enemyAISystem(world);

    expect(speedOf(world, boss)).toBe(0);
  });

  it('lets the same den boss move once its encounter has started', () => {
    const world = createTestWorld({ floor: 2 });
    world.floorMap = openArena(24, 18);
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    const boss = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(6, 4)),
      200,
      AI_TYPE.CHASE,
      0.25,
      200,
      2,
    );
    withBossEncounter(world, boss, true);

    world.frameCount = 1;
    enemyAISystem(world);

    expect(speedOf(world, boss)).toBeGreaterThan(0);
  });

  it('ignores an unstarted encounter that has no spawned boss entity', () => {
    // `bossEid: null` means the boss was never spawned; the freeze set must
    // stay empty so ordinary mobs keep acting instead of being frozen by a
    // null entry colliding with a real eid.
    const world = createTestWorld({ floor: 2 });
    world.floorMap = openArena(24, 18);
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    const enemy = spawnBehaviorEnemy(
      world,
      ...spread(tileCenter(6, 4)),
      20,
      AI_TYPE.CHASE,
      0.25,
      200,
      2,
    );
    withBossEncounter(world, null, false);

    world.frameCount = 1;
    enemyAISystem(world);

    expect(speedOf(world, enemy)).toBeGreaterThan(0);
  });
});

describe('enemyAISystem — line-of-sight aggro (Floor 2 opt-in)', () => {
  /**
   * Arena holding a sealed-door room (tiles x 8..14) the enemy stands in, so
   * `hasOpenRoomDoor` and `playerSharesRoom` are both false and only the
   * line-of-sight check can grant detection. `blockingWallX`, when given, adds a
   * full-height wall column between the player and that room.
   */
  function sealedRoomArena(blockingWallX?: number): FloorMap {
    const width = 24;
    const height = 18;
    const tileMap = new TileMap(width, height);
    tileMap.fill(TilePresets.FLOOR);
    for (let x = 0; x < width; x += 1) {
      tileMap.setFlags(x, 0, TilePresets.WALL);
      tileMap.setFlags(x, height - 1, TilePresets.WALL);
    }
    for (let y = 0; y < height; y += 1) {
      tileMap.setFlags(0, y, TilePresets.WALL);
      tileMap.setFlags(width - 1, y, TilePresets.WALL);
      if (blockingWallX !== undefined) {
        tileMap.setFlags(blockingWallX, y, TilePresets.WALL);
      }
    }
    // The room's only door is walled off, so isEnemyRoomDoorOpen() is false.
    tileMap.setFlags(8, 12, TilePresets.WALL);
    const roomGraph = new RoomGraph();
    roomGraph.add({ x: 8, y: 1, width: 7, height: 16 }, [{ x: 8, y: 12, connectsTo: -1 }]);
    return new FloorMap(
      mkConfig(width, height),
      tileMap,
      roomGraph,
      new Uint8Array(width * height),
      {
        x: 2,
        y: 2,
      },
    );
  }

  it('is enabled on Floor 2 and disabled on Floor 1', () => {
    expect(getWorldFloorBehavior(createTestWorld({ floor: 2 })).lineOfSightAggro).toBe(true);
    expect(getWorldFloorBehavior(createTestWorld({ floor: 1 })).lineOfSightAggro).toBe(false);
  });

  it('aggroes an in-range enemy with clear sight but no shared room', () => {
    // A detected ranged mob fires; an undetected one only wanders, so the
    // projectile is an unambiguous detection signal (unlike a wander velocity,
    // which can point at the player by chance).
    const world = createTestWorld({ floor: 2 });
    world.floorMap = sealedRoomArena();
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    spawnBehaviorEnemy(world, ...spread(tileCenter(9, 4)), 20, AI_TYPE.RANGED, 0.25, 200, 40);
    world.elapsedMs = 10_000;

    expect(firesWithin(world, 12)).toBe(true);
  });

  it('does not aggro through a wall that blocks line of sight', () => {
    const world = createTestWorld({ floor: 2 });
    world.floorMap = sealedRoomArena(7);
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    spawnBehaviorEnemy(world, ...spread(tileCenter(9, 4)), 20, AI_TYPE.RANGED, 0.25, 200, 40);
    world.elapsedMs = 10_000;

    expect(firesWithin(world, 12)).toBe(false);
  });

  it('ignores line of sight on Floor 1, where the opt-in is off', () => {
    const world = createTestWorld({ floor: 1 });
    world.floorMap = sealedRoomArena();
    spawnPlayer(world, ...spread(tileCenter(4, 4)));
    spawnBehaviorEnemy(world, ...spread(tileCenter(9, 4)), 20, AI_TYPE.RANGED, 0.25, 200, 40);
    world.elapsedMs = 10_000;

    expect(firesWithin(world, 12)).toBe(false);
  });
});

/** Tick the AI up to `frames` times, reporting whether any enemy projectile spawned. */
function firesWithin(world: ReturnType<typeof createTestWorld>, frames: number): boolean {
  for (let i = 0; i < frames; i += 1) {
    enemyAISystem(world);
    if (query(world.ecs, [EnemyProjectile]).length > 0) {
      return true;
    }
    world.frameCount += 1;
    world.elapsedMs += 500;
  }
  return false;
}
