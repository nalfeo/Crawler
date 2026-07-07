/**
 * CaveSystemGenerator — Floor 2 open-cavern map generator.
 *
 * Produces one large connected walkable cavern (rot-js Cellular + connect),
 * then segments the walkable area into semantic regions via distance-transform
 * seeded multi-source BFS. Assigns roles deterministically:
 *   - 1 SPAWN cavern (player-start)
 *   - `presentCount` TERRITORY caverns (indexed 0..presentCount-1)
 *   - `presentCount` BOSS_DEN sub-chambers (sealed, one per territory, same familyIndex)
 *   - 1 SETTLEMENT cavern
 *   - 1 RESOURCE_HEART cavern (centre; carries BOSS_STAIR_FLOOR terrain
 *     so Slice 5's stair-spawn plumbing works unchanged)
 *
 * Reachability from spawn to every labelled cavern is a HARD invariant.
 * If reachability fails after `maxRetries` attempts (with bumped sub-seeds),
 * generation throws.
 *
 * Consumes: `MapConfig` (width, height, seed) + presentCount via constructor
 * options. Present-count is an integer (3 or 4); this generator does NOT
 * read families.json/resources.json — Slice 8 owns roster wiring.
 *
 * See: .specify/specs/floor2-family-territories.md (FR1–FR3, Design §Map)
 * See: docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md (D6)
 * See: docs/knowledge/adr/0021-reachability-pass.md (retry-on-failure pattern)
 * See: docs/knowledge/adr/0023-generic-special-room-sealing.md (boss-den sealing)
 */

import { Map as ROTMap, RNG } from 'rot-js';
import {
  TilePresets,
  TerrainType,
  RoomRole,
  type MapConfig,
  type RoomBounds,
  type DoorLocation,
  type TerritoryZone,
} from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap, DEFAULT_FOV_SUB_FACTOR } from '../FloorMap';
import type { MapGenerator } from './types';

export interface CaveSystemOptions {
  /** Number of families present on this floor (3 or 4). Default: 4. */
  presentCount?: number;
  /** Cellular initial fill ratio. Default: 0.45. */
  initialFill?: number;
  /** Cellular smoothing passes. Default: 5. */
  smoothingPasses?: number;
  /** Boss-den side length (square). Default: 5. */
  bossDenSize?: number;
  /**
   * Minimum tile separation between region seeds.
   * Clamped to the map diagonal (corner-to-corner distance in tiles).
   * Default: auto-scaled from map size.
   */
  regionSeparationTiles?: number;
  /** Max retries with bumped sub-seed before throwing. Default: 8. */
  maxRetries?: number;
  /** Number of post-connect widening passes to open cramped caverns. Default: 2. */
  cavernWidenPasses?: number;
  /** Minimum run length to perturb straight hallways. Default: 10. */
  straightHallwayMinRun?: number;
  /**
   * Family territory diameter as a fraction of map size (min dimension).
   * radius = 0.5 × fraction × min(width,height). Default: 0.3 (30% diameter).
   */
  territoryRadiusFraction?: number;
}

const DEFAULT_OPTIONS: Required<CaveSystemOptions> = {
  presentCount: 4,
  initialFill: 0.5,
  smoothingPasses: 4,
  bossDenSize: 5,
  // 0 means "auto" — scaled from map size in tryGenerate
  regionSeparationTiles: 0,
  maxRetries: 8,
  cavernWidenPasses: 2,
  straightHallwayMinRun: 10,
  // 0.3 → territory diameter ≈ 30% of min(width,height).
  territoryRadiusFraction: 0.3,
};

interface RegionInfo {
  id: number;
  cells: number[]; // flat indices into the w*h grid
  centroidX: number;
  centroidY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SettlementClusterRoom {
  readonly bounds: RoomBounds;
  readonly label: string;
  readonly interiorCells: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly doors: DoorLocation[];
}

export class CaveSystemGenerator implements MapGenerator {
  readonly name = 'CaveSystemGenerator';
  private readonly options: Required<CaveSystemOptions>;

  constructor(options: CaveSystemOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.presentCount < 1) {
      throw new Error(
        `CaveSystemGenerator: presentCount must be >= 1 (got ${this.options.presentCount})`,
      );
    }
  }

  /** presentCount actually in use (for labs / tests). */
  get presentCount(): number {
    return this.options.presentCount;
  }

  private resolvePresentCount(config: MapConfig): number {
    const fromConfig = config.caveSystem?.presentCount;
    if (fromConfig === undefined) {
      return this.options.presentCount;
    }
    const normalized = Math.floor(fromConfig);
    if (!Number.isFinite(normalized)) {
      return this.options.presentCount;
    }
    return Math.max(1, Math.min(this.options.presentCount, normalized));
  }

  private resolveRunOptions(config: MapConfig): Required<CaveSystemOptions> {
    const cave = config.caveSystem;
    const valueOr = (value: number | undefined, fallback: number) =>
      Number.isFinite(value) ? value! : fallback;
    const maxRegionSeparationTiles = Math.max(
      1,
      Math.floor(Math.hypot(config.widthTiles - 1, config.heightTiles - 1)),
    );
    return {
      presentCount: this.resolvePresentCount(config),
      initialFill: Math.max(
        0.25,
        Math.min(0.75, valueOr(cave?.initialFill, this.options.initialFill)),
      ),
      smoothingPasses: Math.max(
        1,
        Math.min(8, Math.floor(valueOr(cave?.smoothingPasses, this.options.smoothingPasses))),
      ),
      bossDenSize: Math.max(
        5,
        Math.min(11, Math.floor(valueOr(cave?.bossDenSize, this.options.bossDenSize))),
      ),
      regionSeparationTiles: Math.max(
        0,
        Math.min(
          maxRegionSeparationTiles,
          Math.floor(valueOr(cave?.regionSeparationTiles, this.options.regionSeparationTiles)),
        ),
      ),
      maxRetries: Math.max(
        1,
        Math.min(16, Math.floor(valueOr(cave?.maxRetries, this.options.maxRetries))),
      ),
      cavernWidenPasses: Math.max(
        0,
        Math.min(4, Math.floor(valueOr(cave?.cavernWidenPasses, this.options.cavernWidenPasses))),
      ),
      straightHallwayMinRun: Math.max(
        6,
        Math.min(
          24,
          Math.floor(valueOr(cave?.straightHallwayMinRun, this.options.straightHallwayMinRun)),
        ),
      ),
      territoryRadiusFraction: Math.max(
        0.1,
        Math.min(2.0, valueOr(cave?.territoryRadiusFraction, this.options.territoryRadiusFraction)),
      ),
    };
  }

  generate(config: MapConfig, rng: SeededRandom): FloorMap {
    const runOptions = this.resolveRunOptions(config);
    const errors: string[] = [];
    for (let attempt = 0; attempt < runOptions.maxRetries; attempt++) {
      const subSeed = (config.seed + attempt * 7919) | 0;
      try {
        return this.tryGenerate(config, rng, subSeed, runOptions);
      } catch (err) {
        errors.push(`attempt ${attempt} (subSeed=${subSeed}): ${(err as Error).message}`);
      }
    }
    throw new Error(
      `CaveSystemGenerator: exhausted ${runOptions.maxRetries} attempts for seed=${config.seed}. Errors:\n  ${errors.join('\n  ')}`,
    );
  }

  private tryGenerate(
    config: MapConfig,
    _rng: SeededRandom,
    subSeed: number,
    options: Required<CaveSystemOptions>,
  ): FloorMap {
    const { widthTiles: w, heightTiles: h } = config;
    const total = w * h;
    const presentCount = options.presentCount;

    RNG.setSeed(subSeed);

    // --- 1. Cellular pass ------------------------------------------------
    const tileMap = new TileMap(w, h);
    const terrain = new Uint8Array(total);
    const roomGraph = new RoomGraph();

    const cellular = new ROTMap.Cellular(w, h, {
      born: [5, 6, 7, 8],
      survive: [4, 5, 6, 7, 8],
      topology: 8,
    });
    cellular.randomize(options.initialFill);
    for (let i = 0; i < options.smoothingPasses; i++) cellular.create();

    // Connect all floor regions, then paint tiles.
    cellular.connect((x: number, y: number, value: number) => {
      const idx = y * w + x;
      if (value === 1) {
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.CAVE_FLOOR;
      } else {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.CAVE_WALL;
      }
    }, 1);

    // Force border walls (protects flood-fill and downstream code).
    for (let x = 0; x < w; x++) {
      this.setWall(tileMap, terrain, x, 0, w);
      this.setWall(tileMap, terrain, x, h - 1, w);
    }
    for (let y = 0; y < h; y++) {
      this.setWall(tileMap, terrain, 0, y, w);
      this.setWall(tileMap, terrain, w - 1, y, w);
    }
    this.expandCaverns(tileMap, terrain, w, h, options.cavernWidenPasses);
    this.perturbStraightHallways(tileMap, terrain, w, h, options.straightHallwayMinRun, subSeed);

    // --- 2. Distance transform -----------------------------------------
    const dist = this.distanceTransform(tileMap, w, h);

    // --- 3. Pick region seeds (only need heart + settlement + a spare) --
    // Territories are placed angularly around the heart, not from segmentation.
    const needed = Math.max(3, presentCount + 1);
    const sep =
      options.regionSeparationTiles > 0
        ? options.regionSeparationTiles
        : Math.max(6, Math.floor(Math.min(w, h) / 10));
    const seeds = this.pickSeeds(dist, w, h, needed, sep);
    if (seeds.length < 2) {
      throw new Error(`only found ${seeds.length}/${needed} region seeds (sep=${sep})`);
    }

    // --- 4. Multi-source BFS segmentation ------------------------------
    const { regions } = this.segmentRegions(tileMap, w, h, seeds);
    if (regions.length < 2) {
      throw new Error(`segmentation produced ${regions.length} regions, need >=2`);
    }

    // --- 5. Role assignment (deterministic by geometry) ----------------
    // RESOURCE_HEART = region whose centroid is closest to map centre.
    const cx = w / 2;
    const cy = h / 2;
    const scored = regions
      .map((r, i) => ({ i, d: Math.hypot(r.centroidX - cx, r.centroidY - cy) }))
      .sort((a, b) => a.d - b.d);
    const heartScore = scored[0];
    if (!heartScore) throw new Error('no scored region for RESOURCE_HEART');
    const heartIdx = heartScore.i;
    const heart = regions[heartIdx];
    if (!heart) throw new Error('regions[heartIdx] missing');

    // SETTLEMENT = non-heart region whose centroid is CLOSEST to heart centroid.
    // (Settlement should be near the resource heart, a distinct but adjacent cavern.)
    const nonHeart = regions
      .map((r, i) => ({
        i,
        d: Math.hypot(r.centroidX - heart.centroidX, r.centroidY - heart.centroidY),
      }))
      .filter((s) => s.i !== heartIdx)
      .sort((a, b) => a.d - b.d);

    if (nonHeart.length === 0) {
      throw new Error('no non-heart region for SETTLEMENT');
    }
    const settlementRegion = regions[nonHeart[0]!.i];
    if (!settlementRegion) throw new Error('settlement region missing');
    const settlementCluster = this.carveSettlementCluster(
      tileMap,
      terrain,
      settlementRegion,
      w,
      h,
      subSeed,
    );

    // --- 6. Register RESOURCE_HEART (sealed circular room) + SETTLEMENT -
    const resourceHeart = this.carveSealedResourceHeartRoom(tileMap, terrain, w, h);
    const heartRoomId = roomGraph.add(
      resourceHeart.bounds,
      resourceHeart.doors,
      [],
      RoomRole.RESOURCE_HEART,
      'resource_heart',
      undefined,
      resourceHeart.interiorCells,
    );

    const settlementRoomIds: number[] = [];
    for (const room of settlementCluster) {
      settlementRoomIds.push(
        roomGraph.add(
          room.bounds,
          room.doors,
          [],
          RoomRole.SETTLEMENT,
          room.label,
          undefined,
          room.interiorCells,
        ),
      );
    }
    const settlementBarRoomId = settlementRoomIds[0];
    if (settlementBarRoomId === undefined) {
      throw new Error('settlement cluster did not produce a bar room');
    }
    roomGraph.addNeighbor(settlementBarRoomId, heartRoomId);
    roomGraph.addNeighbor(heartRoomId, settlementBarRoomId);
    for (let i = 1; i < settlementRoomIds.length; i++) {
      const annexRoomId = settlementRoomIds[i]!;
      roomGraph.addNeighbor(settlementBarRoomId, annexRoomId);
      roomGraph.addNeighbor(annexRoomId, settlementBarRoomId);
    }

    // Stamp RESOURCE_HEART centre and immediate neighbours with BOSS_STAIR_FLOOR.
    this.stampBossStairAtHeart(
      {
        id: -1,
        cells: resourceHeart.interiorCells.map((tile) => tile.y * w + tile.x),
        centroidX: resourceHeart.centerX,
        centroidY: resourceHeart.centerY,
        minX: resourceHeart.bounds.x,
        minY: resourceHeart.bounds.y,
        maxX: resourceHeart.bounds.x + resourceHeart.bounds.width - 1,
        maxY: resourceHeart.bounds.y + resourceHeart.bounds.height - 1,
      },
      terrain,
      tileMap,
      w,
      h,
    );

    // --- 7. Spawn room — carved safe room at farthest point from heart --
    const farthestFromHeart = this.findFarthestPassableFrom(
      tileMap,
      w,
      h,
      resourceHeart.centerX,
      resourceHeart.centerY,
    );
    const spawnRoom = this.carveSmallRoom(
      tileMap,
      terrain,
      farthestFromHeart.x,
      farthestFromHeart.y,
      w,
      h,
    );
    const playerSpawn = spawnRoom.spawn;
    const spawnRoomId = roomGraph.add(
      spawnRoom.bounds,
      spawnRoom.doors,
      [],
      RoomRole.SPAWN,
      'spawn_room',
      undefined,
      spawnRoom.interiorCells,
    );

    // --- 8a. Connectivity cull (before territory collection) -----------
    // Cull disconnected passable islands NOW, before we collect territory
    // blobs or carve boss dens, so that every room's interiorCells refers
    // only to tiles that survive the cull.
    const preCullReached = this.floodPassable(tileMap, w, h, playerSpawn.x, playerSpawn.y);
    this.cullDisconnectedPassable(tileMap, terrain, preCullReached, w, h);

    // --- 8b. Angular boss dens + circular TERRITORY rooms --------------
    const denTargets = this.placeAngularDenTargets(
      resourceHeart.centerX,
      resourceHeart.centerY,
      w,
      h,
      presentCount,
      tileMap,
    );

    // Family territory circles: diameter = fraction × min(width,height).
    const minDim = Math.min(w, h);
    const territoryDiameterTiles = Math.max(
      6,
      Math.min(minDim - 4, Math.round(minDim * options.territoryRadiusFraction)),
    );
    const territoryZoneRadius = Math.max(3, Math.floor(territoryDiameterTiles / 2));
    // TERRITORY semantic rooms stay compact enough that boss-den carving has
    // adjacent wall space, while territoryZones carry the larger spawn area.
    const territoryRoomRadius = Math.max(12, Math.round(Math.min(w * 0.1, h * 0.1)));

    const territoryRoomIds: number[] = [];
    const territoryZones: TerritoryZone[] = [];

    // Claimed cells set: tiles already owned by previously placed territory rooms.
    // Prevents territory interiorCells from overlapping each other.
    const claimedCells = new Set<number>();

    for (let fi = 0; fi < presentCount; fi++) {
      const target = denTargets[fi]!;

      // Circular blob of reachable passable tiles near the den target = TERRITORY semantic room.
      // Exclude cells already claimed by a prior territory to keep each territory's
      // interiorCells disjoint (later territories do NOT exclude the heart to avoid
      // blocking den targets that overlap the heart's segmentation region).
      const synthRegion = this.collectCircularRegion(
        tileMap,
        w,
        h,
        target.x,
        target.y,
        territoryRoomRadius,
        fi,
        claimedCells,
      );
      if (synthRegion.cells.length === 0) {
        throw new Error(`no passable cells for territory[${fi}] near (${target.x},${target.y})`);
      }

      // Mark these cells as claimed so subsequent territories don't overlap this one.
      for (const c of synthRegion.cells) claimedCells.add(c);

      const terrRoomId = this.addRegionAsRoom(roomGraph, synthRegion, RoomRole.TERRITORY, w, fi);
      territoryRoomIds.push(terrRoomId);

      // Wire territory ↔ heart (semantic adjacency for AI navigation).
      roomGraph.addNeighbor(terrRoomId, heartRoomId);
      roomGraph.addNeighbor(heartRoomId, terrRoomId);

      // Carve boss den adjacent to the territory blob.
      const denBounds = this.carveBossDen(
        tileMap,
        terrain,
        synthRegion,
        fi,
        w,
        h,
        options.bossDenSize,
      );
      if (!denBounds) {
        throw new Error(`could not carve boss-den for familyIndex=${fi}`);
      }
      const denRoomId = roomGraph.add(
        denBounds.bounds,
        [denBounds.door],
        [terrRoomId],
        RoomRole.BOSS_DEN,
        `boss_den_${fi}`,
        fi,
      );
      roomGraph.addNeighbor(terrRoomId, denRoomId);

      // Spawn-zone metadata (used by spawn-weighting, NOT a room).
      territoryZones.push({
        familyIndex: fi,
        centerX: target.x,
        centerY: target.y,
        radius: territoryZoneRadius,
      });
    }

    // Wire spawn room ↔ heart for semantic graph connectivity.
    roomGraph.addNeighbor(spawnRoomId, heartRoomId);
    roomGraph.addNeighbor(heartRoomId, spawnRoomId);

    // --- 9. Final reachability verification ---------------------------
    // Boss dens add new passable tiles (DOOR_OPEN + interior); flood the final map.
    const reached = this.floodPassable(tileMap, w, h, playerSpawn.x, playerSpawn.y);
    const required: Array<{ x: number; y: number; label: string }> = [
      { x: resourceHeart.centerX, y: resourceHeart.centerY, label: 'RESOURCE_HEART' },
      ...settlementRoomIds.map((roomId, idx) => {
        const room = roomGraph.get(roomId)!;
        return {
          x: room.bounds.x + Math.floor(room.bounds.width / 2),
          y: room.bounds.y + Math.floor(room.bounds.height / 2),
          label: idx === 0 ? 'SETTLEMENT_BAR' : `SETTLEMENT_ANNEX[${idx}]`,
        };
      }),
    ];
    for (let fi = 0; fi < presentCount; fi++) {
      required.push({
        x: denTargets[fi]!.x,
        y: denTargets[fi]!.y,
        label: `TERRITORY[${fi}]`,
      });
      const denRoom = roomGraph
        .getAll()
        .find((r) => r.role === RoomRole.BOSS_DEN && r.familyIndex === fi);
      const door0 = denRoom?.doors[0];
      if (door0) {
        required.push({
          x: door0.x,
          y: door0.y,
          label: `BOSS_DEN[${fi}].door`,
        });
      }
    }

    for (const req of required) {
      const near = this.findReachableWithin(reached, w, h, req.x, req.y, 3);
      if (!near) {
        throw new Error(
          `unreachable ${req.label} at (${req.x},${req.y}) from spawn (${playerSpawn.x},${playerSpawn.y})`,
        );
      }
    }
    // Connectivity invariant: no passable islands may remain after culling.
    for (let i = 0; i < total; i++) {
      const x = i % w;
      const y = (i / w) | 0;
      if (!tileMap.isPassable(x, y)) continue;
      if (reached[i] === 1) continue;
      throw new Error(`passable tile disconnected at (${x},${y}) after culling`);
    }

    return new FloorMap(
      config,
      tileMap,
      roomGraph,
      terrain,
      playerSpawn,
      DEFAULT_FOV_SUB_FACTOR,
      territoryZones,
    );
  }

  // ---------------------------------------------------------------- helpers

  private setWall(tileMap: TileMap, terrain: Uint8Array, x: number, y: number, w: number): void {
    const idx = y * w + x;
    tileMap.flags[idx] = TilePresets.WALL;
    terrain[idx] = TerrainType.CAVE_WALL;
  }

  /** Chebyshev distance-to-nearest-wall for every floor tile (walls = 0). */
  private distanceTransform(tileMap: TileMap, w: number, h: number): Int32Array {
    const dist = new Int32Array(w * h);
    const queue: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!tileMap.isPassable(x, y)) {
          dist[idx] = 0;
          queue.push(idx);
        } else {
          dist[idx] = -1;
        }
      }
    }
    // 8-connected BFS from all walls; result is Chebyshev distance to nearest wall.
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const x = idx % w;
      const y = (idx / w) | 0;
      const d = dist[idx]!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nidx = ny * w + nx;
          if (dist[nidx] === -1) {
            dist[nidx] = d + 1;
            queue.push(nidx);
          }
        }
      }
    }
    return dist;
  }

  /** Greedy farthest-point sampling on distance-transform peaks. */
  private pickSeeds(
    dist: Int32Array,
    w: number,
    h: number,
    needed: number,
    sep: number,
  ): Array<{ x: number; y: number }> {
    // Collect candidates: floor tiles with dist >= 3 (avoid edges).
    const cands: Array<{ x: number; y: number; d: number }> = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = dist[y * w + x]!;
        if (d >= 3) cands.push({ x, y, d });
      }
    }
    cands.sort((a, b) => b.d - a.d);
    const chosen: Array<{ x: number; y: number }> = [];
    const sep2 = sep * sep;
    for (const c of cands) {
      let ok = true;
      for (const p of chosen) {
        const dx = c.x - p.x;
        const dy = c.y - p.y;
        if (dx * dx + dy * dy < sep2) {
          ok = false;
          break;
        }
      }
      if (ok) {
        chosen.push({ x: c.x, y: c.y });
        if (chosen.length >= needed) break;
      }
    }
    return chosen;
  }

  /** Multi-source BFS: assign each floor tile to nearest seed. */
  private segmentRegions(
    tileMap: TileMap,
    w: number,
    h: number,
    seeds: Array<{ x: number; y: number }>,
  ): { regions: RegionInfo[]; adjacency: Map<number, Set<number>> } {
    const owner = new Int32Array(w * h).fill(-1);
    const queue: number[] = [];
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i]!;
      const idx = s.y * w + s.x;
      owner[idx] = i;
      queue.push(idx);
    }
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const x = idx % w;
      const y = (idx / w) | 0;
      const src = owner[idx]!;
      // 4-connected propagation.
      const neighbours: Array<[number, number]> = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbours) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (!tileMap.isPassable(nx, ny)) continue;
        const nidx = ny * w + nx;
        if (owner[nidx] === -1) {
          owner[nidx] = src;
          queue.push(nidx);
        }
      }
    }

    const regions: RegionInfo[] = [];
    for (let i = 0; i < seeds.length; i++) {
      regions.push({
        id: i,
        cells: [],
        centroidX: 0,
        centroidY: 0,
        minX: w,
        minY: h,
        maxX: 0,
        maxY: 0,
      });
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const o = owner[idx]!;
        if (o < 0) continue;
        const r = regions[o]!;
        r.cells.push(idx);
        r.centroidX += x;
        r.centroidY += y;
        if (x < r.minX) r.minX = x;
        if (x > r.maxX) r.maxX = x;
        if (y < r.minY) r.minY = y;
        if (y > r.maxY) r.maxY = y;
      }
    }
    for (const r of regions) {
      if (r.cells.length > 0) {
        r.centroidX = Math.round(r.centroidX / r.cells.length);
        r.centroidY = Math.round(r.centroidY / r.cells.length);
      }
    }
    // Compute inter-region adjacency by walking every passable cell and comparing
    // its 4-neighbours' owner. This is the semantic-graph counterpart to the
    // tile-level `.connect()` flood, so that Slice 3+ AI systems that navigate by
    // `RoomGraph.getConnectedRooms` see the same topology the tile map already has.
    const adjacency = new Map<number, Set<number>>();
    for (let i = 0; i < seeds.length; i++) adjacency.set(i, new Set<number>());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const a = owner[idx]!;
        if (a < 0) continue;
        const rightIdx = x + 1 < w ? idx + 1 : -1;
        const downIdx = y + 1 < h ? idx + w : -1;
        if (rightIdx >= 0) {
          const b = owner[rightIdx]!;
          if (b >= 0 && b !== a) {
            adjacency.get(a)!.add(b);
            adjacency.get(b)!.add(a);
          }
        }
        if (downIdx >= 0) {
          const b = owner[downIdx]!;
          if (b >= 0 && b !== a) {
            adjacency.get(a)!.add(b);
            adjacency.get(b)!.add(a);
          }
        }
      }
    }
    // Filter tiny regions (<25 tiles) — they'd make lousy caverns.
    const kept = regions.filter((r) => r.cells.length >= 25);
    const keptIds = new Set(kept.map((r) => r.id));
    // Drop adjacency entries pointing to filtered-out regions.
    for (const [id, set] of adjacency) {
      if (!keptIds.has(id)) {
        adjacency.delete(id);
        continue;
      }
      for (const n of Array.from(set)) if (!keptIds.has(n)) set.delete(n);
    }
    return { regions: kept, adjacency };
  }

  private addRegionAsRoom(
    roomGraph: RoomGraph,
    region: RegionInfo,
    role: RoomRole,
    w: number,
    familyIndex?: number,
  ): number {
    const bounds: RoomBounds = {
      x: region.minX,
      y: region.minY,
      width: region.maxX - region.minX + 1,
      height: region.maxY - region.minY + 1,
    };
    const interiorCells = region.cells.map((idx) => ({ x: idx % w, y: (idx / w) | 0 }));
    return roomGraph.add(bounds, [], [], role, undefined, familyIndex, interiorCells);
  }

  /**
   * Stamp the resource-heart centre + immediate 3×3 with BOSS_STAIR_FLOOR terrain
   * so Slice 5's stair-spawn logic can pick a deterministic tile.
   *
   * The heart region can be non-convex (cellular.connect() may stitch narrow arms
   * on), so the arithmetic centroid can land on a wall pocket with no passable
   * neighbours in the immediate 3×3. When that happens we fall back to the
   * region's most-interior floor cell (max distance-to-wall) and stamp a 3×3
   * around it.
   */
  private stampBossStairAtHeart(
    heart: RegionInfo,
    terrain: Uint8Array,
    tileMap: TileMap,
    w: number,
    h: number,
  ): void {
    const stampAround = (cx: number, cy: number): number => {
      let stamped = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (tileMap.isPassable(nx, ny)) {
            terrain[ny * w + nx] = TerrainType.BOSS_STAIR_FLOOR;
            stamped++;
          }
        }
      }
      return stamped;
    };

    let stamped = stampAround(heart.centroidX, heart.centroidY);
    if (stamped === 0) {
      // Fallback: pick the passable cell in the heart region farthest from any wall.
      let bestIdx = -1;
      let bestDist = -1;
      for (const idx of heart.cells) {
        const cx = idx % w;
        const cy = (idx / w) | 0;
        if (!tileMap.isPassable(cx, cy)) continue;
        // Cheap "distance to wall" proxy: min chebyshev distance to a non-passable neighbour within radius 2.
        let d = 3;
        for (let dy = -2; dy <= 2 && d > 0; dy++) {
          for (let dx = -2; dx <= 2 && d > 0; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h || !tileMap.isPassable(nx, ny)) {
              const chebyshev = Math.max(Math.abs(dx), Math.abs(dy));
              if (chebyshev < d) d = chebyshev;
            }
          }
        }
        if (d > bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }
      if (bestIdx >= 0) {
        stamped = stampAround(bestIdx % w, (bestIdx / w) | 0);
      }
    }
    if (stamped === 0) {
      // Structural failure: the reachability retry loop will bail on this attempt
      // and try the next sub-seed, but throw here so the caller diagnoses it early.
      throw new Error(
        `resource-heart region has no passable cell to stamp BOSS_STAIR_FLOOR (centroid=${heart.centroidX},${heart.centroidY}, cells=${heart.cells.length})`,
      );
    }
  }

  private expandCaverns(
    tileMap: TileMap,
    terrain: Uint8Array,
    w: number,
    h: number,
    passes: number,
  ): void {
    for (let pass = 0; pass < passes; pass++) {
      const toOpen: number[] = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (tileMap.isPassable(x, y)) continue;
          let passableNeighbours = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (tileMap.isPassable(x + dx, y + dy)) passableNeighbours++;
            }
          }
          if (passableNeighbours >= 5) {
            toOpen.push(y * w + x);
          }
        }
      }
      for (const idx of toOpen) {
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.CAVE_FLOOR;
      }
    }
  }

  private perturbStraightHallways(
    tileMap: TileMap,
    terrain: Uint8Array,
    w: number,
    h: number,
    minRun: number,
    seed: number,
  ): void {
    const carveSidePocket = (x: number, y: number, horizontal: boolean): void => {
      const preferredUpOrLeft = ((x * 73856093 + y * 19349663 + seed) & 1) === 0;
      const candidates: ReadonlyArray<readonly [number, number]> = horizontal
        ? preferredUpOrLeft
          ? [
              [0, -1],
              [0, 1],
            ]
          : [
              [0, 1],
              [0, -1],
            ]
        : preferredUpOrLeft
          ? [
              [-1, 0],
              [1, 0],
            ]
          : [
              [1, 0],
              [-1, 0],
            ];
      for (const [dx, dy] of candidates) {
        const nx1 = x + dx;
        const ny1 = y + dy;
        const nx2 = x + dx * 2;
        const ny2 = y + dy * 2;
        if (nx2 <= 0 || nx2 >= w - 1 || ny2 <= 0 || ny2 >= h - 1) continue;
        if (tileMap.isPassable(nx1, ny1) || tileMap.isPassable(nx2, ny2)) continue;
        for (const [cx, cy] of [
          [nx1, ny1],
          [nx2, ny2],
        ] as const) {
          const idx = cy * w + cx;
          tileMap.flags[idx] = TilePresets.FLOOR;
          terrain[idx] = TerrainType.CAVE_FLOOR;
        }
        return;
      }
    };

    for (let y = 1; y < h - 1; y++) {
      let x = 1;
      while (x < w - 1) {
        const isHorizontalCell =
          tileMap.isPassable(x, y) &&
          tileMap.isPassable(x - 1, y) &&
          tileMap.isPassable(x + 1, y) &&
          !tileMap.isPassable(x, y - 1) &&
          !tileMap.isPassable(x, y + 1);
        if (!isHorizontalCell) {
          x++;
          continue;
        }
        const start = x;
        let end = x;
        while (
          end + 1 < w - 1 &&
          tileMap.isPassable(end + 1, y) &&
          tileMap.isPassable(end, y) &&
          tileMap.isPassable(end + 2, y) &&
          !tileMap.isPassable(end + 1, y - 1) &&
          !tileMap.isPassable(end + 1, y + 1)
        ) {
          end++;
        }
        const len = end - start + 1;
        if (len >= minRun) {
          carveSidePocket(start + Math.floor(len / 2), y, true);
        }
        x = end + 1;
      }
    }

    for (let x = 1; x < w - 1; x++) {
      let y = 1;
      while (y < h - 1) {
        const isVerticalCell =
          tileMap.isPassable(x, y) &&
          tileMap.isPassable(x, y - 1) &&
          tileMap.isPassable(x, y + 1) &&
          !tileMap.isPassable(x - 1, y) &&
          !tileMap.isPassable(x + 1, y);
        if (!isVerticalCell) {
          y++;
          continue;
        }
        const start = y;
        let end = y;
        while (
          end + 1 < h - 1 &&
          tileMap.isPassable(x, end + 1) &&
          tileMap.isPassable(x, end) &&
          tileMap.isPassable(x, end + 2) &&
          !tileMap.isPassable(x - 1, end + 1) &&
          !tileMap.isPassable(x + 1, end + 1)
        ) {
          end++;
        }
        const len = end - start + 1;
        if (len >= minRun) {
          carveSidePocket(x, start + Math.floor(len / 2), false);
        }
        y = end + 1;
      }
    }
  }

  private carveSettlementCluster(
    tileMap: TileMap,
    terrain: Uint8Array,
    settlementRegion: RegionInfo,
    w: number,
    h: number,
    seed: number,
  ): SettlementClusterRoom[] {
    const roomCount = ((seed >>> 1) & 1) === 0 ? 2 : 3;
    const roomWidth = Math.max(8, Math.min(12, Math.floor(Math.min(w, h) / 11)));
    const roomHeight = Math.max(7, Math.min(10, Math.floor(Math.min(w, h) / 14)));
    const gap = 2;
    const clusterWidth = roomCount * roomWidth + (roomCount - 1) * gap;
    const baseX = Math.max(
      2,
      Math.min(w - clusterWidth - 2, settlementRegion.centroidX - Math.floor(clusterWidth / 2)),
    );
    const baseY = Math.max(
      2,
      Math.min(h - roomHeight - 2, settlementRegion.centroidY - Math.floor(roomHeight / 2)),
    );

    const rooms: SettlementClusterRoom[] = [];
    const addRoom = (x: number, y: number, label: string): SettlementClusterRoom => {
      const bounds: RoomBounds = { x, y, width: roomWidth, height: roomHeight };
      this.carveStoneRoom(tileMap, terrain, bounds, w);
      const interiorCells: Array<{ x: number; y: number }> = [];
      for (let iy = y + 1; iy < y + roomHeight - 1; iy++) {
        for (let ix = x + 1; ix < x + roomWidth - 1; ix++) {
          interiorCells.push({ x: ix, y: iy });
        }
      }
      return { bounds, label, interiorCells, doors: [] };
    };

    const xSlots =
      roomCount === 2
        ? [baseX, baseX + roomWidth + gap]
        : [baseX, baseX + roomWidth + gap, baseX + (roomWidth + gap) * 2];
    const barIndex = roomCount === 2 ? 0 : 1;
    const carved = xSlots.map((x, index) => {
      if (index === barIndex) return addRoom(x, baseY, 'settlement_bar');
      const annexLabel = index < barIndex ? 'settlement_annex_left' : 'settlement_annex_right';
      return addRoom(x, baseY, annexLabel);
    });
    const barRoom = carved[barIndex]!;
    const leftRoom = roomCount === 3 ? carved[0]! : null;
    const rightRoom = roomCount === 3 ? carved[2]! : carved[1]!;
    rooms.push(barRoom);
    if (leftRoom) rooms.push(leftRoom);
    rooms.push(rightRoom);

    const connectRooms = (a: SettlementClusterRoom, b: SettlementClusterRoom): void => {
      const ay = a.bounds.y + Math.floor(a.bounds.height / 2);
      const by = b.bounds.y + Math.floor(b.bounds.height / 2);
      const y = Math.round((ay + by) / 2);
      const aRight = a.bounds.x + a.bounds.width - 1;
      const bLeft = b.bounds.x;
      const doorA = { x: aRight, y, connectsTo: -1 };
      const doorB = { x: bLeft, y, connectsTo: -1 };
      const startX = Math.min(aRight, bLeft);
      const endX = Math.max(aRight, bLeft);
      for (let x = startX; x <= endX; x++) {
        const idx = y * w + x;
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.STONE_FLOOR;
        for (const sideY of [y - 1, y + 1]) {
          const sideIdx = sideY * w + x;
          if (tileMap.flags[sideIdx] === TilePresets.WALL) {
            terrain[sideIdx] = TerrainType.STONE_WALL;
          }
        }
      }
      tileMap.flags[doorA.y * w + doorA.x] = TilePresets.DOOR_OPEN;
      tileMap.flags[doorB.y * w + doorB.x] = TilePresets.DOOR_OPEN;
      terrain[doorA.y * w + doorA.x] = TerrainType.DOOR;
      terrain[doorB.y * w + doorB.x] = TerrainType.DOOR;
      a.doors.push(doorA);
      b.doors.push(doorB);
    };

    if (leftRoom) {
      connectRooms(leftRoom, barRoom);
    }
    connectRooms(barRoom, rightRoom);

    // Two exterior entries so the cluster is integrated with the surrounding cavern.
    for (const dy of [-1, 1]) {
      const x = barRoom.bounds.x + Math.floor(barRoom.bounds.width / 2);
      const y = dy < 0 ? barRoom.bounds.y : barRoom.bounds.y + barRoom.bounds.height - 1;
      const outsideY = y + dy;
      if (outsideY <= 0 || outsideY >= h - 1) continue;
      tileMap.flags[y * w + x] = TilePresets.DOOR_OPEN;
      terrain[y * w + x] = TerrainType.DOOR;
      tileMap.flags[outsideY * w + x] = TilePresets.FLOOR;
      terrain[outsideY * w + x] = TerrainType.CAVE_FLOOR;
      barRoom.doors.push({ x, y, connectsTo: -1 });
    }

    return rooms;
  }

  private carveStoneRoom(
    tileMap: TileMap,
    terrain: Uint8Array,
    bounds: RoomBounds,
    w: number,
  ): void {
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        const idx = y * w + x;
        const perimeter =
          x === bounds.x ||
          y === bounds.y ||
          x === bounds.x + bounds.width - 1 ||
          y === bounds.y + bounds.height - 1;
        if (perimeter) {
          // Preserve pre-existing passable flow so carved settlement rooms never
          // sever global cave connectivity.
          if (tileMap.isPassable(x, y)) {
            tileMap.flags[idx] = TilePresets.FLOOR;
            terrain[idx] = TerrainType.CAVE_FLOOR;
          } else {
            tileMap.flags[idx] = TilePresets.WALL;
            terrain[idx] = TerrainType.STONE_WALL;
          }
        } else {
          tileMap.flags[idx] = TilePresets.FLOOR;
          terrain[idx] = TerrainType.STONE_FLOOR;
        }
      }
    }
  }

  /**
   * Carve a sealed BOSS_DEN sub-chamber adjacent to a territory. The chamber
   * is a solid-walled bossDenSize × bossDenSize rectangle with a single
   * closed door on the shared edge with the territory.
   *
   * Strategy: iterate over the territory's boundary tiles (passable cells
   * whose neighbour is wall), and for each candidate direction try to fit
   * a wall-only chamber immediately outside that boundary. This guarantees
   * the door is adjacent to a tile that BELONGS to this territory.
   *
   * Returns the chamber bounds + door location, or null on failure.
   */
  private carveBossDen(
    tileMap: TileMap,
    terrain: Uint8Array,
    territory: RegionInfo,
    _familyIndex: number,
    w: number,
    h: number,
    denSize: number,
  ): { bounds: RoomBounds; door: DoorLocation } | null {
    const size = denSize;
    const territoryCells = new Set(territory.cells);

    // Collect (territoryCell, direction) candidate slots — the direction
    // is the offset from the territory tile through the door tile into
    // the chamber interior.
    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    // Prefer candidates closer to territory centroid for compactness.
    const candidates: Array<{ tx: number; ty: number; dx: number; dy: number; score: number }> = [];
    for (const idx of territory.cells) {
      const tx = idx % w;
      const ty = (idx / w) | 0;
      for (const [dx, dy] of dirs) {
        const wallX = tx + dx;
        const wallY = ty + dy;
        if (wallX < 1 || wallX >= w - 1 || wallY < 1 || wallY >= h - 1) continue;
        if (tileMap.isPassable(wallX, wallY)) continue; // must be wall (becomes the door)
        candidates.push({
          tx,
          ty,
          dx,
          dy,
          score: Math.hypot(tx - territory.centroidX, ty - territory.centroidY),
        });
      }
    }
    candidates.sort((a, b) => a.score - b.score);

    for (const cand of candidates) {
      // The door tile is (cand.tx + cand.dx, cand.ty + cand.dy). The chamber
      // extends further in the same direction. Pick a chamber footprint that
      // includes the door on its perimeter facing the territory.
      const doorX = cand.tx + cand.dx;
      const doorY = cand.ty + cand.dy;

      // The chamber's near edge is the door. Place the chamber so the door
      // lies on that near edge, centred perpendicular to the door direction.
      let bx: number;
      let by: number;
      if (cand.dx !== 0) {
        // Door faces horizontally — chamber extends left or right.
        bx = cand.dx > 0 ? doorX : doorX - size + 1;
        by = doorY - Math.floor(size / 2);
      } else {
        // Door faces vertically.
        bx = doorX - Math.floor(size / 2);
        by = cand.dy > 0 ? doorY : doorY - size + 1;
      }
      if (bx < 1 || by < 1 || bx + size >= w - 1 || by + size >= h - 1) continue;

      // Chamber footprint must currently be all wall.
      let allWall = true;
      for (let y = by; y < by + size && allWall; y++) {
        for (let x = bx; x < bx + size && allWall; x++) {
          if (tileMap.isPassable(x, y)) allWall = false;
        }
      }
      if (!allWall) continue;

      // Sanity check: door must be on the chamber perimeter.
      const doorOnPerim =
        doorX === bx || doorX === bx + size - 1 || doorY === by || doorY === by + size - 1;
      if (!doorOnPerim) continue;

      // Verify the door's territory-side neighbour is a cell in THIS territory.
      const outsideIdx = (doorY - cand.dy) * w + (doorX - cand.dx);
      if (!territoryCells.has(outsideIdx)) continue;

      // Carve interior floor.
      for (let y = by + 1; y < by + size - 1; y++) {
        for (let x = bx + 1; x < bx + size - 1; x++) {
          const idx = y * w + x;
          tileMap.flags[idx] = TilePresets.FLOOR;
          terrain[idx] = TerrainType.STONE_FLOOR;
        }
      }
      // Stamp the door tile — DOOR_OPEN so the den is reachable and the connectivity
      // invariant holds. The scenario can close the door on floor initialization.
      const didx = doorY * w + doorX;
      tileMap.flags[didx] = TilePresets.DOOR_OPEN;
      terrain[didx] = TerrainType.DOOR;

      const bounds: RoomBounds = { x: bx, y: by, width: size, height: size };
      const doorLoc: DoorLocation = { x: doorX, y: doorY, connectsTo: -1 };
      return { bounds, door: doorLoc };
    }

    return null;
  }

  /** 4-connected flood fill over passable tiles (walking floor + open doors). */
  private floodPassable(
    tileMap: TileMap,
    w: number,
    h: number,
    sx: number,
    sy: number,
  ): Uint8Array {
    const reached = new Uint8Array(w * h);
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return reached;
    if (!tileMap.isPassable(sx, sy)) return reached;
    const queue: number[] = [sy * w + sx];
    reached[sy * w + sx] = 1;
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const x = idx % w;
      const y = (idx / w) | 0;
      const neighbours: Array<[number, number]> = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbours) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nidx = ny * w + nx;
        if (reached[nidx]) continue;
        if (!tileMap.isPassable(nx, ny)) continue;
        reached[nidx] = 1;
        queue.push(nidx);
      }
    }
    return reached;
  }

  private cullDisconnectedPassable(
    tileMap: TileMap,
    terrain: Uint8Array,
    reached: Uint8Array,
    w: number,
    h: number,
  ): void {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (!tileMap.isPassable(x, y)) continue;
        if (reached[idx] === 1) continue;
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.CAVE_WALL;
      }
    }
  }

  /** Return the closest reached tile to (tx,ty) within a Chebyshev radius, or null. */
  private findReachableWithin(
    reached: Uint8Array,
    w: number,
    h: number,
    tx: number,
    ty: number,
    radius: number,
  ): { x: number; y: number } | null {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (reached[ny * w + nx]) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /** Find the nearest passable tile to (tx,ty) within maxRadius (Chebyshev). Returns null if none found. */
  private findNearestPassable(
    tileMap: TileMap,
    w: number,
    h: number,
    tx: number,
    ty: number,
    maxRadius = 30,
  ): { x: number; y: number } | null {
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 1 || nx >= w - 1 || ny < 1 || ny >= h - 1) continue;
          if (tileMap.isPassable(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /**
   * BFS from (sx,sy) over passable tiles; return the last tile reached (farthest).
   * Skips map-edge tiles (within 4 tiles of border) so the spawn room can fit.
   */
  private findFarthestPassableFrom(
    tileMap: TileMap,
    w: number,
    h: number,
    sx: number,
    sy: number,
  ): { x: number; y: number } {
    const visited = new Uint8Array(w * h);
    const queue: number[] = [];
    const startIdx = sy * w + sx;
    visited[startIdx] = 1;
    queue.push(startIdx);
    let head = 0;
    let lastGoodIdx = startIdx;
    const margin = 4;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const x = idx % w;
      const y = (idx / w) | 0;
      // Track the farthest tile that has enough margin for a spawn room.
      if (x >= margin && x < w - margin && y >= margin && y < h - margin) {
        lastGoodIdx = idx;
      }
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nidx = ny * w + nx;
        if (visited[nidx]) continue;
        if (!tileMap.isPassable(nx, ny)) continue;
        visited[nidx] = 1;
        queue.push(nidx);
      }
    }
    return { x: lastGoodIdx % w, y: (lastGoodIdx / w) | 0 };
  }

  /**
   * Place `count` boss-den target points around the heart.
   * For count ≤ 4, uses canonical NSEW order matching floor2Scenario's quadrantOrder
   * ['N','S','E','W'] so that familyIndex 0=N, 1=S, 2=E, 3=W.
   * For count > 4, falls back to evenly-spaced angles starting from North.
   * Returns the nearest actual passable tile to each angular target.
   */
  private placeAngularDenTargets(
    heartX: number,
    heartY: number,
    w: number,
    h: number,
    count: number,
    tileMap: TileMap,
  ): Array<{ x: number; y: number }> {
    const R = Math.max(10, Math.round(Math.min(w * 0.22, h * 0.22)));
    // Canonical NSEW angles (clockwise from North): 0=N, 1=S, 2=E, 3=W.
    // Matches floor2Scenario.ts quadrantOrder = ['N','S','E','W'].
    const NSEW_ANGLES: Record<number, number[]> = {
      1: [0],
      2: [0, Math.PI],
      3: [0, Math.PI, Math.PI / 2],
      4: [0, Math.PI, Math.PI / 2, (3 * Math.PI) / 2],
    };
    const angles: number[] =
      NSEW_ANGLES[count] ?? Array.from({ length: count }, (_, i) => (i * 2 * Math.PI) / count);

    const targets: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i++) {
      const angle = angles[i]!;
      // angle measured clockwise from North: x = heartX + R·sin(angle), y = heartY - R·cos(angle)
      const rawX = Math.round(heartX + R * Math.sin(angle));
      const rawY = Math.round(heartY - R * Math.cos(angle));
      const clampedX = Math.max(2, Math.min(w - 3, rawX));
      const clampedY = Math.max(2, Math.min(h - 3, rawY));
      const nearest = this.findNearestPassable(tileMap, w, h, clampedX, clampedY, 20);
      targets.push(nearest ?? { x: clampedX, y: clampedY });
    }
    return targets;
  }

  /**
   * Collect passable tiles within `radius` Euclidean distance of (cx,cy) into a RegionInfo.
   * Excludes cells already in `claimedCells` to prevent overlap with heart or prior territories.
   * Used to build the synthetic TERRITORY room blobs around angular boss-den targets.
   */
  private collectCircularRegion(
    tileMap: TileMap,
    w: number,
    h: number,
    cx: number,
    cy: number,
    radius: number,
    regionId: number,
    claimedCells?: ReadonlySet<number>,
  ): RegionInfo {
    const r2 = radius * radius;
    const cells: number[] = [];
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    const x0 = Math.max(1, cx - radius);
    const x1 = Math.min(w - 2, cx + radius);
    const y0 = Math.max(1, cy - radius);
    const y1 = Math.min(h - 2, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (!tileMap.isPassable(x, y)) continue;
        const idx = y * w + x;
        if (claimedCells?.has(idx)) continue;
        cells.push(idx);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // Use the target center as the centroid (stable, deterministic).
    return {
      id: regionId,
      cells,
      centroidX: cx,
      centroidY: cy,
      minX: cells.length > 0 ? minX : cx,
      minY: cells.length > 0 ? minY : cy,
      maxX: cells.length > 0 ? maxX : cx,
      maxY: cells.length > 0 ? maxY : cy,
    };
  }

  /**
   * Carve a sealed circular resource-heart chamber near map center.
   * - diameter: 20 tiles (radius 10)
   * - center: within 20% of map center (we anchor at center and clamp for bounds)
   * - one perimeter door tile (left open at generation; runtime lock wiring seals it)
   */
  private carveSealedResourceHeartRoom(
    tileMap: TileMap,
    terrain: Uint8Array,
    w: number,
    h: number,
  ): {
    centerX: number;
    centerY: number;
    bounds: RoomBounds;
    doors: DoorLocation[];
    interiorCells: Array<{ x: number; y: number }>;
  } {
    const radius = 10;
    const innerRadius = radius - 1;
    const minCenterX = radius + 2;
    const maxCenterX = w - radius - 3;
    const minCenterY = radius + 2;
    const maxCenterY = h - radius - 3;
    if (minCenterX > maxCenterX || minCenterY > maxCenterY) {
      throw new Error(
        `map too small for resource-heart room (w=${w}, h=${h}, required diameter=${radius * 2})`,
      );
    }
    const centerX = Math.max(minCenterX, Math.min(maxCenterX, Math.floor(w / 2)));
    const centerY = Math.max(minCenterY, Math.min(maxCenterY, Math.floor(h / 2)));
    const r2 = radius * radius;
    const innerR2 = innerRadius * innerRadius;

    const interiorCells: Array<{ x: number; y: number }> = [];
    for (let y = centerY - radius; y <= centerY + radius; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const idx = y * w + x;
        if (d2 <= innerR2) {
          tileMap.flags[idx] = TilePresets.FLOOR;
          terrain[idx] = TerrainType.STONE_FLOOR;
          interiorCells.push({ x, y });
        } else {
          tileMap.flags[idx] = TilePresets.WALL;
          terrain[idx] = TerrainType.STONE_WALL;
        }
      }
    }

    // Door on south perimeter; kept open in generated map for connectivity.
    const doorX = centerX;
    const doorY = centerY + radius;
    const doorIdx = doorY * w + doorX;
    tileMap.flags[doorIdx] = TilePresets.DOOR_OPEN;
    terrain[doorIdx] = TerrainType.DOOR;
    if (doorY + 1 < h - 1 && !tileMap.isPassable(doorX, doorY + 1)) {
      const outsideIdx = (doorY + 1) * w + doorX;
      tileMap.flags[outsideIdx] = TilePresets.FLOOR;
      terrain[outsideIdx] = TerrainType.CAVE_FLOOR;
    }

    return {
      centerX,
      centerY,
      bounds: {
        x: centerX - radius,
        y: centerY - radius,
        width: radius * 2 + 1,
        height: radius * 2 + 1,
      },
      doors: [{ x: doorX, y: doorY, connectsTo: -1 }],
      interiorCells,
    };
  }

  /**
   * Carve a small (6×6) safe-room stone chamber centered near (targetX, targetY).
   * Doors on north and south perimeter edges ensure the room connects to the cave.
   */
  private carveSmallRoom(
    tileMap: TileMap,
    terrain: Uint8Array,
    targetX: number,
    targetY: number,
    w: number,
    h: number,
  ): {
    spawn: { x: number; y: number };
    bounds: RoomBounds;
    doors: DoorLocation[];
    interiorCells: Array<{ x: number; y: number }>;
  } {
    const size = 6;
    const bx = Math.max(2, Math.min(w - size - 2, targetX - Math.floor(size / 2)));
    const by = Math.max(2, Math.min(h - size - 2, targetY - Math.floor(size / 2)));
    const bounds: RoomBounds = { x: bx, y: by, width: size, height: size };
    this.carveStoneRoom(tileMap, terrain, bounds, w);

    // Override interior tiles to safe-room floor.
    for (let y = by + 1; y < by + size - 1; y++) {
      for (let x = bx + 1; x < bx + size - 1; x++) {
        terrain[y * w + x] = TerrainType.SAFE_ROOM_FLOOR;
      }
    }

    // North door.
    const doorNx = bx + Math.floor(size / 2);
    const doorNy = by;
    tileMap.flags[doorNy * w + doorNx] = TilePresets.DOOR_OPEN;
    terrain[doorNy * w + doorNx] = TerrainType.DOOR;
    if (doorNy - 1 > 0) {
      const outsideN = (doorNy - 1) * w + doorNx;
      if (!tileMap.isPassable(doorNx, doorNy - 1)) {
        tileMap.flags[outsideN] = TilePresets.FLOOR;
        terrain[outsideN] = TerrainType.CAVE_FLOOR;
      }
    }

    // South door.
    const doorSx = bx + Math.floor(size / 2);
    const doorSy = by + size - 1;
    tileMap.flags[doorSy * w + doorSx] = TilePresets.DOOR_OPEN;
    terrain[doorSy * w + doorSx] = TerrainType.DOOR;
    if (doorSy + 1 < h - 1) {
      const outsideS = (doorSy + 1) * w + doorSx;
      if (!tileMap.isPassable(doorSx, doorSy + 1)) {
        tileMap.flags[outsideS] = TilePresets.FLOOR;
        terrain[outsideS] = TerrainType.CAVE_FLOOR;
      }
    }

    const doors: DoorLocation[] = [
      { x: doorNx, y: doorNy, connectsTo: -1 },
      { x: doorSx, y: doorSy, connectsTo: -1 },
    ];
    const interiorCells: Array<{ x: number; y: number }> = [];
    for (let y = by + 1; y < by + size - 1; y++) {
      for (let x = bx + 1; x < bx + size - 1; x++) {
        interiorCells.push({ x, y });
      }
    }
    return {
      spawn: { x: bx + Math.floor(size / 2), y: by + Math.floor(size / 2) },
      bounds,
      doors,
      interiorCells,
    };
  }
}
