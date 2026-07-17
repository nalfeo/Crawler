/**
 * Pure arena data — safe to import in Node / headless tests.
 *
 * Contains room-geometry presets, enemy-encounter presets, archetype helpers,
 * and spawn utilities. No Phaser dependency; the visual lab (`index.ts`) is a
 * thin wrapper that imports from here.
 */
import { addComponent, set, setComponent } from 'bitecs';
import {
  Damage,
  FamilyMembership,
  Size,
  Sprite,
  type GameWorld,
  setBloodColor,
  setEnemyAppearanceKey,
  spawnBehaviorEnemy,
} from '../../core/index.js';
import { SHAPE_CIRCLE } from '../../core/physics-defs.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { AI_TYPE } from '../../game/enemyAISystem.js';
import {
  floor1EnemyPack,
  floor2EnemyPack,
  type EnemyArchetypeDef,
} from '../../shared/enemy-packs.js';
import { type SeededRandom } from '../../shared/random.js';
import {
  BiomeType,
  TerrainType,
  TilePresets,
  type MapConfig,
  RoomRole,
} from '../../shared/map-types.js';

const TILE_SIZE_FT = 4;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArenaRoomPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  buildMap(): FloorMap;
  readonly playerSpawnTile: { x: number; y: number };
}

export interface ArenaEnemyPreset {
  readonly id: string;
  readonly name: string;
  readonly floor: 'floor1' | 'floor2' | 'all';
  readonly description: string;
  readonly entries: ReadonlyArray<{ def: EnemyArchetypeDef; count: number }>;
  /**
   * Optional override spawn function used in place of `spawnPresetAroundCenter`'s
   * default archetype-loop approach. Required for boss presets that need extra
   * post-spawn setup (permanent aggro, contact damage, fire cooldown) that the
   * generic archetype system does not carry.
   */
  readonly customSpawnFn?: (
    world: GameWorld,
    map: FloorMap,
    cx: number,
    cy: number,
    rng: SeededRandom,
  ) => number[];
}

// ─── FloorMap builders ────────────────────────────────────────────────────────

function buildRoomMap(
  widthTiles: number,
  heightTiles: number,
  wallFn: (x: number, y: number) => boolean,
  playerSpawnTile: { x: number; y: number },
  biome: BiomeType = BiomeType.DUNGEON,
): FloorMap {
  const wallTerrain = biome === BiomeType.CAVE ? TerrainType.CAVE_WALL : TerrainType.STONE_WALL;
  const floorTerrain = biome === BiomeType.CAVE ? TerrainType.CAVE_FLOOR : TerrainType.STONE_FLOOR;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome,
    seed: 42,
    roomWidthRange: [4, widthTiles],
    roomHeightRange: [4, heightTiles],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  terrain.fill(floorTerrain);

  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      if (wallFn(x, y)) {
        tileMap.flags[y * widthTiles + x] = TilePresets.WALL;
        terrain[y * widthTiles + x] = wallTerrain;
      }
    }
  }

  const graph = new RoomGraph();
  graph.add({ x: 0, y: 0, width: widthTiles, height: heightTiles }, [], [], RoomRole.NORMAL);
  return new FloorMap(config, tileMap, graph, terrain, playerSpawnTile);
}

/** Large rectangular arena — ideal for boss fights. */
function makeBossArena(): FloorMap {
  const W = 34;
  const H = 24;
  const border = (x: number, y: number) => x === 0 || x === W - 1 || y === 0 || y === H - 1;
  return buildRoomMap(W, H, border, { x: W >> 1, y: H - 3 });
}

/** Compact room — tight combat with limited escape room. */
function makeSmallRoom(): FloorMap {
  const W = 16;
  const H = 14;
  const border = (x: number, y: number) => x === 0 || x === W - 1 || y === 0 || y === H - 1;
  return buildRoomMap(W, H, border, { x: W >> 1, y: H - 3 });
}

/** Medium room with four 2×2 pillars — pillars block line-of-sight and shots. */
function makeColumnsRoom(): FloorMap {
  const W = 28;
  const H = 20;
  const PILLARS: Array<{ x: number; y: number }> = [
    { x: 6, y: 5 },
    { x: 19, y: 5 },
    { x: 6, y: 13 },
    { x: 19, y: 13 },
  ];
  const isPillar = (x: number, y: number) =>
    PILLARS.some((p) => x >= p.x && x <= p.x + 1 && y >= p.y && y <= p.y + 1);
  const border = (x: number, y: number) => x === 0 || x === W - 1 || y === 0 || y === H - 1;
  return buildRoomMap(W, H, (x, y) => border(x, y) || isPillar(x, y), { x: W >> 1, y: H - 3 });
}

/** Long narrow corridor — chase and kiting scenarios. */
function makeCorridor(): FloorMap {
  const W = 34;
  const H = 8;
  const border = (x: number, y: number) => x === 0 || x === W - 1 || y === 0 || y === H - 1;
  return buildRoomMap(W, H, border, { x: 3, y: H >> 1 });
}

/** Open cave chamber with scattered rock columns. */
function makeCaveRoom(): FloorMap {
  const W = 26;
  const H = 18;
  const ROCKS = [
    [5, 4],
    [9, 7],
    [14, 4],
    [19, 7],
    [5, 12],
    [20, 12],
    [12, 14],
  ] as const;
  const isRock = (x: number, y: number) => ROCKS.some(([rx, ry]) => x === rx && y === ry);
  const border = (x: number, y: number) => x === 0 || x === W - 1 || y === 0 || y === H - 1;
  return buildRoomMap(
    W,
    H,
    (x, y) => border(x, y) || isRock(x, y),
    { x: W >> 1, y: H - 3 },
    BiomeType.CAVE,
  );
}

export const ARENA_ROOM_PRESETS: readonly ArenaRoomPreset[] = [
  {
    id: 'boss-arena',
    name: 'Boss Arena',
    description: 'Large open arena — ideal for boss encounters and high-mobility fights.',
    buildMap: makeBossArena,
    playerSpawnTile: { x: 17, y: 21 },
  },
  {
    id: 'small-room',
    name: 'Small Room',
    description: 'Compact room — tight combat with minimal escape routes.',
    buildMap: makeSmallRoom,
    playerSpawnTile: { x: 8, y: 11 },
  },
  {
    id: 'columns-room',
    name: 'Columns Room',
    description: 'Medium room with four pillars that block line-of-sight and shots.',
    buildMap: makeColumnsRoom,
    playerSpawnTile: { x: 14, y: 17 },
  },
  {
    id: 'corridor',
    name: 'Corridor',
    description: 'Long narrow passage — chase and kiting scenarios.',
    buildMap: makeCorridor,
    playerSpawnTile: { x: 3, y: 4 },
  },
  {
    id: 'cave',
    name: 'Cave Chamber',
    description: 'Open cave with scattered rock columns disrupting sight lines.',
    buildMap: makeCaveRoom,
    playerSpawnTile: { x: 13, y: 15 },
  },
];

export function getRoomPreset(id: string): ArenaRoomPreset {
  return ARENA_ROOM_PRESETS.find((p) => p.id === id) ?? ARENA_ROOM_PRESETS[0]!;
}

// ─── Archetype helpers ────────────────────────────────────────────────────────

/**
 * Maps archetype aiType + id to AI_TYPE constant.
 * Mirrors the logic in `resolveFloor2ArchetypeAIType` from floor2Scenario.ts
 * without importing that module's heavy dependency chain.
 */
export function archetypeToAiType(def: EnemyArchetypeDef): number {
  if (def.aiType === 'ranged') return AI_TYPE.RANGED;
  if (def.id.includes('slime')) return AI_TYPE.LEAPER;
  return AI_TYPE.CHASE;
}

/**
 * Stable ordered list of floor-2 family IDs (one entry per family, in pack order).
 * Used as the source for the numeric FamilyMembership.familyId index so the arena
 * lab matches the family-ID ordering the AI systems expect.
 */
export const FLOOR2_FAMILY_IDS: readonly string[] = [
  ...new Set(
    floor2EnemyPack.archetypes.filter((a) => a.familyId !== undefined).map((a) => a.familyId!),
  ),
];

// ─── Floor 1 boss constants ───────────────────────────────────────────────────

/** Green ichor blood color used for slime-type enemies (mirrors floorScenario.ts). */
const BLOOD_COLOR_SLIME = 0x22aa44;

/**
 * Canonical Floor 1 boss stats, sourced from floor1.manifest.json / floor1Config.
 * Kept as inline constants so arena-data.ts stays import-free of the full
 * floorScenario module (which requires floorScenario.ts's heavy dependency chain).
 *
 * Update these when the floor manifest's `bossVariants` block changes.
 */
const F1_BOSS_STAIR = {
  /** RatSlime — the stair-room boss. Large, high-HP, fires acid every 5 s. */
  hp: 280,
  speed: 0.14375,
  detectRange: 67.5,
  /** Must be non-zero so the AI treats this as a shooter, not a pure chaser. */
  attackRange: 280,
  spriteWidth: 3.75,
  spriteHeight: 3.75,
  fireballCooldownMs: 5000,
  contactDamage: 12,
  appearanceKey: 'rat-slime',
} as const;

const F1_BOSS_SLIMERAT = {
  /** SlimeRat — the side-quest boss. Smaller, fires acid every 7 s. */
  hp: 140,
  speed: 0.125,
  detectRange: 55.0,
  attackRange: 220,
  spriteWidth: 3.25, // ratSlime.spriteWidth − 0.5 per production code
  spriteHeight: 3.25,
  fireballCooldownMs: 7000,
  contactDamage: 8,
  appearanceKey: 'slime-rat',
} as const;

/**
 * Spawn the two canonical Floor 1 bosses for the arena lab.
 *
 * Replicates the full configuration from `spawnFloor1StairBoss` and
 * `spawnFloor1SlimeRatBoss` in `floorScenario.ts` — including contact damage,
 * permanent aggro, fire cooldown, and correct sprite/size — without requiring
 * the floor-scenario objective state those functions need.
 */
function spawnFloor1BossesArena(
  world: GameWorld,
  map: FloorMap,
  cx: number,
  cy: number,
  rng: SeededRandom,
): number[] {
  const slimeTextureId = F1_SLIME.spriteTexture;

  function spawnBoss(
    cfg: typeof F1_BOSS_STAIR | typeof F1_BOSS_SLIMERAT,
    offsetX: number,
    offsetY: number,
  ): number {
    const pos = findWalkablePosition(map, cx + offsetX, cy + offsetY, rng);
    const eid = spawnBehaviorEnemy(
      world,
      pos.x,
      pos.y,
      cfg.hp,
      AI_TYPE.CHASE,
      cfg.speed,
      cfg.detectRange,
      cfg.attackRange,
    );
    setComponent(world.ecs, eid, Sprite, {
      textureId: slimeTextureId,
      width: cfg.spriteWidth,
      height: cfg.spriteHeight,
    });
    setComponent(world.ecs, eid, Size, {
      radius: Math.max(cfg.spriteWidth, cfg.spriteHeight) * 0.5,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    });
    setComponent(world.ecs, eid, Damage, { amount: cfg.contactDamage });
    setBloodColor(world, eid, BLOOD_COLOR_SLIME);
    world.stores.enemyBehavior.aggroedPermanently[eid] = 1;
    world.stores.enemyBehavior.fireCooldownMs[eid] = cfg.fireballCooldownMs;
    setEnemyAppearanceKey(world, eid, cfg.appearanceKey);
    return eid;
  }

  return [spawnBoss(F1_BOSS_STAIR, -6, -4), spawnBoss(F1_BOSS_SLIMERAT, 6, -4)];
}

/**
 * Spawn a single enemy from an archetype definition.
 *
 * Production-representative wiring:
 * - AI type resolved via `archetypeToAiType` (leaper, ranged, chase).
 * - `attackRange` set for ranged archetypes (`detectRange × 0.65`) so the AI
 *   maintains ranged distance instead of closing to melee.
 * - `FamilyMembership` added for floor-2 archetypes that carry a `familyId`.
 *
 * Returns the entity id. Safe to call in Node/headless (no Phaser dependency).
 */
export function spawnFromArchetype(
  world: GameWorld,
  x: number,
  y: number,
  def: EnemyArchetypeDef,
  hpScale = 1.0,
): number {
  const aiType = archetypeToAiType(def);
  const attackRange = aiType === AI_TYPE.RANGED ? def.detectRange * 0.65 : 0;

  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    Math.round(def.hp * hpScale),
    aiType,
    def.speed,
    def.detectRange,
    attackRange,
  );
  setComponent(world.ecs, eid, Sprite, {
    textureId: def.spriteTexture,
    width: def.spriteWidth,
    height: def.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius: Math.max(def.spriteWidth, def.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, def.id);

  // Tag with FamilyMembership so family-aware AI systems (e.g. in a full-floor
  // scenario) can distinguish families. The numeric index mirrors the ordering
  // in FLOOR2_FAMILY_IDS which is consistent with the game's floor-2 assignment.
  if (def.familyId !== undefined) {
    const familyIdIndex = FLOOR2_FAMILY_IDS.indexOf(def.familyId);
    addComponent(
      world.ecs,
      eid,
      set(FamilyMembership, {
        familyId: familyIdIndex >= 0 ? familyIdIndex : 0,
        isBoss: def.isBoss ? 1 : 0,
      }),
    );
  }

  return eid;
}

/**
 * Find a walkable position near (cx, cy) on the given FloorMap.
 *
 * Tries the original position first. If it is inside a wall/pillar, searches
 * 8 cardinal/diagonal neighbors at one tile distance, then falls back to random
 * positions in the interior. Always returns a valid point inside the map.
 */
export function findWalkablePosition(
  map: FloorMap,
  cx: number,
  cy: number,
  rng: SeededRandom,
): { x: number; y: number } {
  if (map.isPassableAt(cx, cy)) return { x: cx, y: cy };

  // Try 8 neighbor offsets at one tile distance
  const offsets: Array<[number, number]> = [
    [0, -TILE_SIZE_FT],
    [0, TILE_SIZE_FT],
    [-TILE_SIZE_FT, 0],
    [TILE_SIZE_FT, 0],
    [-TILE_SIZE_FT, -TILE_SIZE_FT],
    [TILE_SIZE_FT, -TILE_SIZE_FT],
    [-TILE_SIZE_FT, TILE_SIZE_FT],
    [TILE_SIZE_FT, TILE_SIZE_FT],
  ];
  for (const [dx, dy] of offsets) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (map.isPassableAt(nx, ny)) return { x: nx, y: ny };
  }

  // Random fallback: try 16 positions in the map interior (1-tile margin)
  const margin = TILE_SIZE_FT;
  for (let i = 0; i < 16; i += 1) {
    const rx = margin + rng.next() * (map.widthFt - 2 * margin);
    const ry = margin + rng.next() * (map.heightFt - 2 * margin);
    if (map.isPassableAt(rx, ry)) return { x: rx, y: ry };
  }

  // Last resort: map center (open in all our preset rooms)
  return { x: map.widthFt / 2, y: map.heightFt / 2 };
}

// ─── Enemy Presets ────────────────────────────────────────────────────────────

const F1_RAT = floor1EnemyPack.archetypes.find((a) => a.id === 'rat')!;
const F1_SLIME = floor1EnemyPack.archetypes.find((a) => a.id === 'slime')!;

function buildFloor2FamilyPreset(familyId: string): ArenaEnemyPreset {
  const boss = floor2EnemyPack.archetypes.find((a) => a.familyId === familyId && a.isBoss === true);
  const trash = floor2EnemyPack.archetypes.filter(
    (a) => a.familyId === familyId && a.isBoss !== true,
  );
  const entries: Array<{ def: EnemyArchetypeDef; count: number }> = [];
  if (boss) entries.push({ def: boss, count: 1 });
  // Include up to 3 non-elite trash mobs for cleaner packs
  const nonElite = trash.filter((a) => !a.id.includes('-elite-'));
  for (const t of nonElite.slice(0, 3)) {
    entries.push({ def: t, count: 2 });
  }
  const label = familyId.charAt(0).toUpperCase() + familyId.slice(1);
  return {
    id: `f2-${familyId}`,
    name: `F2: ${label} Pack`,
    floor: 'floor2',
    description: `${label} family: boss + trash mobs.`,
    entries,
  };
}

export const ARENA_ENEMY_PRESETS: readonly ArenaEnemyPreset[] = [
  // ── Floor 1 ──────────────────────────────────────────────────────────────
  {
    id: 'f1-mixed',
    name: 'F1: Mixed Pack',
    floor: 'floor1',
    description: 'A mix of floor-1 rats and slimes.',
    entries: [
      { def: F1_RAT, count: 3 },
      { def: F1_SLIME, count: 2 },
    ],
  },
  {
    id: 'f1-rats',
    name: 'F1: Rat Horde',
    floor: 'floor1',
    description: 'Six rats closing in fast.',
    entries: [{ def: F1_RAT, count: 6 }],
  },
  {
    id: 'f1-slimes',
    name: 'F1: Slime Cluster',
    floor: 'floor1',
    description: 'Four leaping slimes.',
    entries: [{ def: F1_SLIME, count: 4 }],
  },
  {
    id: 'f1-boss',
    name: 'F1: Boss Encounter',
    floor: 'floor1',
    description:
      'RatSlime (stair boss) + SlimeRat (quest boss) with canonical HP, contact damage, permanent aggro, and fire cooldowns.',
    entries: [],
    customSpawnFn: spawnFloor1BossesArena,
  },
  // ── Floor 2 (one per family) ─────────────────────────────────────────────
  ...FLOOR2_FAMILY_IDS.map(buildFloor2FamilyPreset),
  // ── Custom / blank ───────────────────────────────────────────────────────
  {
    id: 'custom',
    name: 'Custom (blank)',
    floor: 'all',
    description: 'Empty arena — use "Spawn Custom Mob" or enable Custom Mode to place enemies.',
    entries: [],
  },
];

export function getEnemyPreset(id: string): ArenaEnemyPreset {
  return ARENA_ENEMY_PRESETS.find((p) => p.id === id) ?? ARENA_ENEMY_PRESETS[0]!;
}

/** All mob archetypes selectable for custom placement (floor1 + floor2). */
export const ALL_ARCHETYPES: readonly EnemyArchetypeDef[] = [
  ...floor1EnemyPack.archetypes,
  ...floor2EnemyPack.archetypes,
];

/**
 * Spawn an enemy preset scattered around a center point.
 * All spawn positions are validated against the FloorMap to avoid
 * placing enemies inside walls or pillars.
 */
export function spawnPresetAroundCenter(
  world: GameWorld,
  map: FloorMap,
  preset: ArenaEnemyPreset,
  cx: number,
  cy: number,
  rng: SeededRandom,
  radiusFt = 12,
): number[] {
  // Boss presets (and any preset that needs post-spawn config beyond archetypes)
  // supply their own spawn function.
  if (preset.customSpawnFn) {
    return preset.customSpawnFn(world, map, cx, cy, rng);
  }

  const eids: number[] = [];
  let angle = rng.next() * Math.PI * 2;
  const totalEntities = preset.entries.reduce((sum, e) => sum + e.count, 0);
  const angleStep = totalEntities > 0 ? (Math.PI * 2) / totalEntities : 0;

  for (const entry of preset.entries) {
    for (let i = 0; i < entry.count; i += 1) {
      const spread = radiusFt * (0.5 + rng.next() * 0.5);
      const jitter = (rng.next() - 0.5) * (angleStep * 0.6);
      const rawX = cx + Math.cos(angle + jitter) * spread;
      const rawY = cy + Math.sin(angle + jitter) * spread;
      const pos = findWalkablePosition(map, rawX, rawY, rng);
      eids.push(spawnFromArchetype(world, pos.x, pos.y, entry.def));
      angle += angleStep;
    }
  }
  return eids;
}
