/**
 * Floor 4 — "The Main Event" scenario, slice 3 (venue + deterministic waves).
 *
 * Slice 2 booted the authored venue and ran an empty-arena rehearsal timeline.
 * Slice 3 makes the wave windows physical: each act arms immutable, seeded wave
 * manifests, `arenaDirectorSystem` releases them at the fixed feed gates on the
 * act clock, a live-enemy cap and bounded FIFO spawn debt bound the arena, and
 * the wave-window boundary *cuts* whatever survived. Headliners, the Green Room
 * transaction and shops remain later slices, so the rehearsal hand-off (headline
 * windows auto-clear, intermissions auto-advance) is retained underneath.
 *
 * Key contracts:
 *
 * - **The stairs stay gated by `INTERMISSION(5)` (FR8.3).** Slice 2 exposes the
 *   same phase-gated `confirmFloor4StairDescend` contract used by later slices.
 * - **No generic countdown timer is shown (FR5.6/FR8.4).** `timer.durationMs`
 *   remains a raw stall backstop, so `world.hideFloorTimer` suppresses the
 *   generic floor HUD timer.
 * - **Intermissions wait for the public scene confirmation.** Until Green
 *   Room/shop slices ship, the break transaction is still only the authored
 *   hold, but leaving it goes through the scenario stair/exit contract instead
 *   of an invisible timer.
 * - **Waves never touch `world.rng` (FR3.2/FR7.1/FR7.4).** Manifests come from
 *   per-wave derived streams in `src/shared/floor4-waves.ts`; releasing,
 *   debting and cutting consume no randomness at all, so cap pressure and
 *   player skill cannot shift a seed's downstream draws.
 */
import {
  addComponent,
  entityExists,
  hasComponent,
  query,
  removeEntity,
  setComponent,
  set,
} from 'bitecs';
import {
  BloodColor,
  BroadcastScore,
  Damage,
  DeathTimer,
  Enemy,
  EnemyBehavior,
  Health,
  Player,
  Position,
  Size,
  Sprite,
  Team,
  type GameWorld,
} from '../core/index.js';
import { applyDamage, clearEntityStores } from '../core/helpers.js';
import { spawnRosterCompanion } from '../core/spawners/companions.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import {
  computeShowcaseArenaLayout,
  showcaseArenaOptionsFromConfig,
} from '../core/map/generators/ShowcaseArenaGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import {
  getFloorEnemyPack,
  type EnemyArchetypeDef,
  type EnemyPackDef,
} from '../shared/enemy-packs.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { buildFloor4HeadlinerCard } from '../shared/floor4-headliners.js';
import {
  buildFloor4ActWaveManifests,
  type Floor4WaveScheduleConfig,
} from '../shared/floor4-waves.js';
import { BiomeType, type ArenaFeedGate, type MapConfig } from '../shared/map-types.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import { pushAnnouncement } from '../shared/announcement-events.js';
import { pushVfxEvent } from '../shared/vfx-events.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT, TeamId } from '../shared/constants.js';
import type { ScenarioStairMarkerState } from '../shared/scenario-presentation.js';
import {
  ABILITY_MILESTONE_LEVELS,
  formForLevel,
  getPetSpecies,
  speciesTokenForId,
  type PetSpeciesDef,
} from '../shared/data/floor3/species.js';
import { openFloor4GreenRoomVisit, retireFloor4GreenRoomVisit } from './floor4GreenRoom.js';
import {
  createBossChestId,
  openBossChest,
  spawnBossChestForDefeatedBoss,
} from './boss-chest-resolver.js';
import { AI_TYPE } from './enemyAISystem.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import type {
  Floor4ActIndex,
  Floor4ArenaPhase,
  Floor4ArenaRunStats,
  Floor4ArenaState,
  Floor4GateTelegraph,
  Floor4HeadlinerEncounterState,
  Floor4HeadlinerTelemetry,
  Floor4PendingWaveSpawn,
  Floor4PendingWaveWindow,
  Floor4WaveManifest,
  Floor4WaveSpawnEntry,
  Floor4WaveTelemetry,
  Floor4WaveWindowState,
} from '../shared/floor-types.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';

/**
 * Set when the raw elapsed-time stall backstop (FR8.4) fires. This is NOT an
 * ordinary floor timeout: it means the floor failed to terminate or the run was
 * abandoned, and it is recorded explicitly so a run that hits it is
 * distinguishable from a player who simply ran out of time.
 */
export const FLOOR4_STALL_BACKSTOP_GOAL_ID = 'floor4-stall-backstop';

const FLOOR4_PLAYER_STAT_SOURCE_ID = 'floor4-manifest-player';
const FLOOR4_ACTS: readonly Floor4ActIndex[] = [1, 2, 3, 4, 5];
const FLOOR4_KEPT_COMPANION_LEVEL: number =
  ABILITY_MILESTONE_LEVELS[ABILITY_MILESTONE_LEVELS.length - 1] ?? 0;

function getFloor4Manifest() {
  const manifest = getFloorManifest('floor4');
  if (!manifest) {
    throw new Error('Missing floor4 manifest');
  }
  return manifest;
}

function getFloor4Config() {
  const floor4 = getFloor4Manifest().floor4;
  if (!floor4) {
    throw new Error('Missing floor4 geometry/phase config');
  }
  return floor4;
}

/** Build the authored-venue map config from the manifest's `floor4` geometry block. */
function buildFloor4MapConfig(): MapConfig {
  const manifest = getFloor4Manifest();
  const geometry = manifest.floor4;
  return {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.SHOWCASE_ARENA,
    // The authored venue ignores the seed; it is carried so the map config
    // stays a complete, replayable record of what generated the floor.
    seed: manifest.map.seed,
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    showcaseArena: geometry
      ? {
          arenaWidthTiles: geometry.arena.widthTiles,
          arenaHeightTiles: geometry.arena.heightTiles,
          greenRoomWidthTiles: geometry.greenRoom.widthTiles,
          greenRoomHeightTiles: geometry.greenRoom.heightTiles,
          tunnelLengthTiles: geometry.tunnel.lengthTiles,
          tunnelWidthTiles: geometry.tunnel.widthTiles,
          pillarSizeTiles: geometry.arena.pillarSizeTiles,
          pillarInsetTiles: geometry.arena.pillarInsetTiles,
          borderThicknessTiles: geometry.arena.borderThicknessTiles,
        }
      : undefined,
  };
}

/**
 * Raw elapsed-time stall backstop (FR8.4). Sized to cover the bounded worst
 * case plus untimed Green Room visits; reaching it is a bug or an abandoned
 * run, never ordinary play.
 *
 * Deliberately compares raw `world.elapsedMs` rather than the safe-room-credited
 * deadline other floors use: a backstop that can be paused indefinitely by
 * standing still is not a backstop. Floor 4's manifest therefore sets
 * `behavior.safeRoomPausesFloorTimer: false`.
 */
function floor4ObjectiveTick(world: GameWorld): void {
  const manifest = getFloorManifest('floor4');
  if (manifest?.timer && world.elapsedMs >= manifest.timer.durationMs) {
    world.goalFlags.set(FLOOR4_STALL_BACKSTOP_GOAL_ID, true);
    world.state = 'game_over';
  }
}

function cloneFloor4Phase(phase: Floor4ArenaPhase): Floor4ArenaPhase {
  return { ...phase };
}

function createFloor4WaveTelemetry(): Floor4WaveTelemetry {
  return {
    wavesReleased: 0,
    enemiesSpawned: 0,
    enemiesCut: 0,
    debtDiscarded: 0,
    gateTelegraphsArmed: 0,
  };
}

function createFloor4HeadlinerTelemetry(): Floor4HeadlinerTelemetry {
  return {
    spawned: 0,
    defeated: 0,
    appearanceFeeGoldGranted: 0,
    chestsSpawned: 0,
    chestsForceResolved: 0,
    overtimeStarted: 0,
    overtimeStepsApplied: 0,
  };
}

/**
 * Bank the act's realised income at the break (spec FR10.3 / slice 7).
 *
 * `waveGold` is the `goldLedger.earnedFromDrops` delta over the act window, so
 * only wave/drop income is budgeted. Non-drop sources (e.g. achievement loot
 * boxes) and the guaranteed appearance fee stay separable.
 */
function recordFloor4ActIncome(
  world: GameWorld,
  state: Floor4ArenaState,
  act: Floor4ActIndex,
): void {
  const card = state.headlinerCard.find((entry) => entry.act === act);
  const appearanceFeeGold = card && state.activeHeadliner?.feeGranted ? card.appearanceFeeGold : 0;
  const dropDelta = world.goldLedger.earnedFromDrops - state.actBaseline.dropGold;
  const waveGold = Math.max(0, dropDelta);
  state.actIncome.push({
    act,
    waveGold,
    appearanceFeeGold,
    totalGold: waveGold + appearanceFeeGold,
  });
}

function recordFloor4PhaseTransition(
  world: GameWorld,
  state: Floor4ArenaState,
  phase: Floor4ArenaPhase,
  reason: string,
): void {
  // Every transition is a hard boundary for wave release state: the surviving
  // trash is cut when the wave window ends (FR3.6), and outstanding spawn debt
  // plus armed gate telegraphs are discarded at EVERY boundary (FR3.5) so no
  // act can leak pressure into the headline window or the next act.
  if (state.phase.kind === 'WAVES') {
    cutFloor4WaveEnemies(world, state);
  }
  if (state.phase.kind === 'INTERMISSION' && phase.kind !== 'INTERMISSION') {
    retireFloor4GreenRoomVisit(world);
  }
  state.waves = undefined;
  const pending = state.pendingWaves;
  state.pendingWaves = undefined;
  if (phase.kind === 'WAVES') {
    state.activeHeadliner = undefined;
  }

  state.phase = cloneFloor4Phase(phase);
  state.phaseElapsedMs = 0;
  state.overtimeFinisherAnnounced = false;
  state.timeline.push({
    frame: world.frameCount,
    worldElapsedMs: world.elapsedMs,
    arenaElapsedMs: state.arenaElapsedMs,
    phase: cloneFloor4Phase(phase),
    reason,
  });

  if (phase.kind === 'WAVES') {
    // Snapshot the counters this act starts from so the break-summary HUD can
    // project THIS act's delta at the next intermission instead of re-reporting
    // the run-cumulative totals (spec slice 6 / FR6).
    state.actBaseline = {
      playerGold: world.playerGold,
      dropGold: world.goldLedger.earnedFromDrops,
      enemiesSpawned: state.waveTelemetry.enemiesSpawned,
      enemiesCut: state.waveTelemetry.enemiesCut,
    };
    state.waves = armFloor4ActWaves(world, phase.act, pending);
  } else if (phase.kind === 'HEADLINE') {
    spawnFloor4Headliner(world, state, phase.act);
  } else if (phase.kind === 'INTERMISSION') {
    // Lock the gold figure the instant the break starts: buildSummary()
    // must not diff against the live, still-mutating balance or "Gold
    // earned" would shrink in real time as the player shops at sponsors.
    state.breakGoldSnapshot = world.playerGold;
    recordFloor4ActIncome(world, state, phase.act);
    const opened = openFloor4GreenRoomVisit(world, phase.act - 1);
    if (!opened.ok) {
      throw new Error(opened.message);
    }
  }
}

function createFloor4ArenaState(world: GameWorld): Floor4ArenaState {
  const config = getFloor4Config();
  const state: Floor4ArenaState = {
    phase: { kind: 'COUNTDOWN' },
    arenaElapsedMs: 0,
    phaseElapsedMs: 0,
    overtimeFinisherAnnounced: false,
    lastWorldElapsedMs: world.elapsedMs,
    timeline: [],
    headlinerCard: buildFloor4HeadlinerCard(config.headliners, world.seed),
    keptCompanionCoStarActive: false,
    waveTelemetry: createFloor4WaveTelemetry(),
    headlinerTelemetry: createFloor4HeadlinerTelemetry(),
    actBaseline: {
      playerGold: world.playerGold,
      dropGold: world.goldLedger.earnedFromDrops,
      enemiesSpawned: 0,
      enemiesCut: 0,
    },
    actIncome: [],
  };
  recordFloor4PhaseTransition(world, state, { kind: 'COUNTDOWN' }, 'floor4-initialized');
  return state;
}

function floor4ArenaState(world: GameWorld): Floor4ArenaState | undefined {
  return world.floorExtendedState?.floor4Arena;
}

function nextFloor4Act(act: Floor4ActIndex): Floor4ActIndex | null {
  const next = FLOOR4_ACTS[FLOOR4_ACTS.indexOf(act) + 1];
  return next ?? null;
}

function floor4ActEndMs(act: Floor4ActIndex): number {
  return getFloor4Config().phase.actDurationMs * act;
}

function floor4WaveEndMs(act: Floor4ActIndex): number {
  const phase = getFloor4Config().phase;
  return phase.actDurationMs * (act - 1) + phase.waveWindowMs;
}

function floor4ActStartMs(act: Floor4ActIndex): number {
  return getFloor4Config().phase.actDurationMs * (act - 1);
}

/** Authored wave schedule (FR8.2). Every wave number the director reads. */
function getFloor4WaveConfig(): Floor4WaveScheduleConfig {
  return getFloor4Config().waves;
}

/**
 * The venue's fixed, indexed feed gates (FR3.4/FR9.2). Read from the generated
 * `FloorMap` — never re-derived here, because two derivations of gate geometry
 * is exactly how a manifest's `gateIndex` silently stops meaning what it meant.
 */
function floor4FeedGates(world: GameWorld): readonly ArenaFeedGate[] {
  return world.floorMap?.feedGates ?? [];
}

/**
 * Arm an act's wave window: build its immutable manifests once (FR3.2), and
 * start it with an empty cursor/debt/ownership set.
 */
function armFloor4ActWaves(
  world: GameWorld,
  act: Floor4ActIndex,
  pending?: Floor4PendingWaveWindow,
): Floor4WaveWindowState {
  const gates = floor4FeedGates(world);
  if (gates.length === 0) {
    throw new Error('Floor 4 wave window armed on a map with no feed gates');
  }
  // A pre-armed window already built this act's manifests to light wave 0's
  // gates; reusing them keeps the telegraph and the release describing the same
  // content (they are seed-identical either way, so this is not a re-roll).
  const usable = pending?.act === act ? pending : undefined;
  return {
    act,
    manifests:
      usable?.manifests ??
      buildFloor4ActWaveManifests(getFloor4WaveConfig(), world.seed, act, gates.length),
    releaseCursor: 0,
    debt: [],
    armedTelegraphs: usable ? [...usable.armedTelegraphs] : [],
    ownedEnemies: new Map(),
  };
}

/**
 * A wave enemy that still counts against the concurrency cap: it exists, is
 * still an enemy, has HP, and is not already lingering as a corpse
 * (`DeathTimer`) after a normal, fully-rewarded death.
 *
 * The `Enemy` check is load-bearing, not defensive noise: bitECS recycles
 * entity ids, so a removed wave enemy's id can come back as a projectile or a
 * pickup with stale `health` store bytes. Without it, the cap could count a
 * gem — and the cut could delete one.
 */
function isLiveFloor4WaveEnemy(world: GameWorld, eid: number): boolean {
  return (
    entityExists(world.ecs, eid) &&
    hasComponent(world.ecs, eid, Enemy) &&
    !hasComponent(world.ecs, eid, DeathTimer) &&
    (world.stores.health.current[eid] ?? 0) > 0
  );
}

/** Drop stale entities from the ownership map and report the live count. */
function pruneFloor4OwnedEnemies(world: GameWorld, waves: Floor4WaveWindowState): number {
  let live = 0;
  for (const eid of [...waves.ownedEnemies.keys()]) {
    if (!entityExists(world.ecs, eid) || !hasComponent(world.ecs, eid, Enemy)) {
      waves.ownedEnemies.delete(eid);
      continue;
    }
    if (isLiveFloor4WaveEnemy(world, eid)) {
      live += 1;
    }
  }
  return live;
}

function floor4ArchetypeAiType(archetype: EnemyArchetypeDef): number {
  switch (archetype.aiType) {
    case 'ranged':
      return AI_TYPE.RANGED;
    case 'leaper':
      return AI_TYPE.LEAPER;
    case 'guardian':
      return AI_TYPE.GUARDIAN;
    case 'support':
      // SUPPORT is movement-only; Headliners need the ranged fallback to attack.
      return AI_TYPE.RANGED;
    default:
      return AI_TYPE.CHASE;
  }
}

function floor3CompanionArchetypeAiType(archetype: EnemyArchetypeDef): number {
  switch (archetype.aiType) {
    case 'ranged':
      return AI_TYPE.RANGED;
    case 'leaper':
      return AI_TYPE.LEAPER;
    case 'guardian':
      return AI_TYPE.GUARDIAN;
    case 'support':
      return AI_TYPE.SUPPORT;
    default:
      return AI_TYPE.CHASE;
  }
}

function getFloor3WildPack(): EnemyPackDef | undefined {
  return getFloorEnemyPack('floor3-wild');
}

function findFloor3ArchetypeForKeptCompanion(
  pack: EnemyPackDef,
  species: PetSpeciesDef,
): EnemyArchetypeDef | undefined {
  return (
    pack.archetypes.find((candidate) => candidate.speciesId === species.speciesId) ??
    pack.archetypes.find((candidate) => candidate.id.endsWith(`-${species.fightingStyle}`))
  );
}

function floor4WaveArchetype(archetypeId: string): EnemyArchetypeDef {
  const packId = getFloor4WaveConfig().enemyPackId;
  const archetype = getFloorEnemyPack(packId)?.archetypes.find(
    (candidate) => candidate.id === archetypeId,
  );
  if (!archetype) {
    // Unreachable in practice: the manifest schema validates every roster
    // archetype against this pack at load. Loud here beats a silent no-spawn.
    throw new Error(`Floor 4 wave archetype "${archetypeId}" missing from pack "${packId}"`);
  }
  return archetype;
}

/**
 * Where an entry enters the arena: its gate tile, nudged inward by a stagger
 * derived from the entry's own index inside the wave manifest.
 *
 * The stagger is deliberately content-derived rather than rolled or searched
 * (FR3.4): a retry/jitter search would make RNG consumption and placement
 * path-dependent, so the same manifest would stop reproducing. An offset that
 * would land in geometry falls back to the (always passable) gate tile.
 */
function resolveFloor4GateSpawnPosition(
  world: GameWorld,
  gate: ArenaFeedGate,
  slot: number,
): { x: number; y: number } {
  const floorMap = world.floorMap!;
  const center = floorMap.tileToWorld(gate.x, gate.y);
  const stepFt = floorMap.config.tileSizeFt * 0.5;
  const inwardSteps = slot % 3;
  if (inwardSteps === 0) {
    return center;
  }
  const inward =
    gate.direction === 'north'
      ? { x: 0, y: 1 }
      : gate.direction === 'south'
        ? { x: 0, y: -1 }
        : gate.direction === 'west'
          ? { x: 1, y: 0 }
          : { x: -1, y: 0 };
  const candidate = {
    x: center.x + inward.x * stepFt * inwardSteps,
    y: center.y + inward.y * stepFt * inwardSteps,
  };
  return floorMap.isPassableAt(candidate.x, candidate.y) ? candidate : center;
}

function markFloor4HostileForCoStarIfNeeded(world: GameWorld, eid: number): void {
  if (
    floor4ArenaState(world)?.keptCompanionCoStarActive === true &&
    !hasComponent(world.ecs, eid, Team)
  ) {
    addComponent(world.ecs, eid, set(Team, { id: TeamId.ENEMY }));
  }
}

function resolveFloor4CoStarSpawnPosition(
  world: GameWorld,
  playerEid: number,
): { x: number; y: number } {
  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: playerX + 4, y: playerY };
  }

  const origin = floorMap.worldToTile(playerX, playerY);
  const maxRadius = Math.max(floorMap.width, floorMap.height);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile = { x: origin.x + dx, y: origin.y + dy };
        if (!floorMap.tileMap.inBounds(tile.x, tile.y)) continue;
        if (!floorMap.tileMap.isPassable(tile.x, tile.y)) continue;
        return floorMap.tileToWorld(tile.x, tile.y);
      }
    }
  }
  return { x: playerX + floorMap.config.tileSizeFt, y: playerY };
}

function spawnFloor4KeptCompanionCoStar(
  world: GameWorld,
  playerEid: number,
  playerCarryover: PlayerCarryoverSnapshot,
): boolean {
  const contract = playerCarryover.keptCompanion;
  if (!contract || floor4ArenaState(world)?.keptCompanionCoStarActive === true) {
    return false;
  }
  const species = getPetSpecies(contract.speciesId);
  if (!species) {
    return false;
  }
  const pack = getFloor3WildPack();
  if (!pack) {
    return false;
  }
  const archetype = findFloor3ArchetypeForKeptCompanion(pack, species);
  if (!archetype) {
    return false;
  }

  const spawn = resolveFloor4CoStarSpawnPosition(world, playerEid);
  const form = formForLevel(species, FLOOR4_KEPT_COMPANION_LEVEL);
  const hp = Math.max(1, Math.round(archetype.hp * form.statScale));
  const attackRange =
    archetype.aiType === 'ranged' || archetype.aiType === 'support'
      ? archetype.detectRange * 0.65
      : 0;
  const eid = spawnRosterCompanion(world, {
    x: spawn.x,
    y: spawn.y,
    hp,
    aiType: floor3CompanionArchetypeAiType(archetype),
    speed: archetype.speed,
    aggroRange: archetype.detectRange,
    attackRange,
    speciesToken: speciesTokenForId(contract.speciesId),
    level: FLOOR4_KEPT_COMPANION_LEVEL,
    ownerTeam: TeamId.PLAYER,
    form: contract.form,
  });
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius:
      archetype.collisionRadius ?? Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, archetype.id);
  return true;
}

/**
 * Spawn one manifest entry at its fixed gate. Consumes no RNG stream.
 *
 * A manifest is composed against `feedGates.length`, so an entry whose gate is
 * missing means the map/manifest contract itself broke. That is thrown rather
 * than absorbed: silently dropping the entry would delete an enemy, make the
 * encounter quietly easier, and hide the corruption inside a telemetry counter
 * that otherwise means authored debt-cap pressure.
 */
function spawnFloor4WaveEnemy(world: GameWorld, entry: Floor4WaveSpawnEntry, slot: number): number {
  const gate = floor4FeedGates(world)[entry.gateIndex];
  if (!gate || !world.floorMap) {
    throw new Error(
      `Floor 4 wave entry references feed gate ${entry.gateIndex}, which this map does not have`,
    );
  }
  const archetype = floor4WaveArchetype(entry.archetypeId);
  const spawn = resolveFloor4GateSpawnPosition(world, gate, slot);
  const isRanged = archetype.aiType === 'ranged' || archetype.aiType === 'support';
  const eid = spawnBehaviorEnemy(
    world,
    spawn.x,
    spawn.y,
    archetype.hp,
    floor4ArchetypeAiType(archetype),
    archetype.speed,
    archetype.detectRange,
    isRanged ? archetype.detectRange * 0.65 : 0,
  );
  markFloor4HostileForCoStarIfNeeded(world, eid);
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius:
      archetype.collisionRadius ?? Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, archetype.id);
  return eid;
}

/** Light a gate for an imminent wave (design §4). Cosmetic + readable state. */
function pushFloor4GateTelegraphVfx(world: GameWorld, gate: ArenaFeedGate): void {
  const position = world.floorMap?.tileToWorld(gate.x, gate.y);
  if (!position) {
    return;
  }
  pushVfxEvent(world.vfxEvents, {
    kind: 'spawnerPulse',
    x: position.x,
    y: position.y,
    intensity: 1,
  });
}

/**
 * Light every gate one wave enters from, once. Shared by the in-window
 * telegraph pass and the pre-act pre-arm so both produce identical armed state
 * and identical telemetry.
 */
function armFloor4WaveTelegraph(
  world: GameWorld,
  state: Floor4ArenaState,
  armedTelegraphs: Floor4GateTelegraph[],
  manifest: Floor4WaveManifest,
  firesAtArenaMs: number,
): void {
  if (armedTelegraphs.some((armed) => armed.waveIndex === manifest.waveIndex)) {
    return;
  }
  const gateIndexes = [...new Set(manifest.entries.map((entry) => entry.gateIndex))].sort(
    (left, right) => left - right,
  );
  for (const gateIndex of gateIndexes) {
    armedTelegraphs.push({ gateIndex, waveIndex: manifest.waveIndex, firesAtArenaMs });
    state.waveTelemetry.gateTelegraphsArmed += 1;
    const gate = floor4FeedGates(world)[gateIndex];
    if (gate) {
      pushFloor4GateTelegraphVfx(world, gate);
    }
  }
}

/**
 * Arm gate telegraphs for every wave whose release is within the authored lead
 * time. Idempotent per wave: a wave is telegraphed once, then disarmed when it
 * releases (or discarded at the next phase boundary, FR3.5).
 */
function armFloor4GateTelegraphs(
  world: GameWorld,
  state: Floor4ArenaState,
  waves: Floor4WaveWindowState,
  actRelativeMs: number,
): void {
  const leadMs = getFloor4WaveConfig().gates.telegraphLeadMs;
  for (let index = waves.releaseCursor; index < waves.manifests.length; index += 1) {
    const manifest = waves.manifests[index]!;
    if (manifest.releaseAtActMs - leadMs > actRelativeMs) {
      // Manifests are in release order, so nothing further is due either.
      break;
    }
    armFloor4WaveTelegraph(
      world,
      state,
      waves.armedTelegraphs,
      manifest,
      floor4ActStartMs(waves.act) + manifest.releaseAtActMs,
    );
  }
}

/**
 * Pre-arm the opening wave's telegraph before its act starts.
 *
 * Wave 0 releases at `releaseAtActMs = 0`, so the in-window pass can only ever
 * arm and fire it on the same tick — the authored lead would be invisible for
 * the first wave of EVERY act. This runs during the final `telegraphLeadMs` of
 * COUNTDOWN/INTERMISSION instead, and hands the armed state to the window so
 * the wave is not telegraphed twice.
 */
function prearmFloor4NextActTelegraphs(
  world: GameWorld,
  state: Floor4ArenaState,
  act: Floor4ActIndex,
  msUntilActStart: number,
): void {
  const leadMs = getFloor4WaveConfig().gates.telegraphLeadMs;
  if (msUntilActStart > leadMs) {
    return;
  }
  const gates = floor4FeedGates(world);
  if (gates.length === 0) {
    return;
  }
  if (!state.pendingWaves || state.pendingWaves.act !== act) {
    state.pendingWaves = {
      act,
      manifests: buildFloor4ActWaveManifests(getFloor4WaveConfig(), world.seed, act, gates.length),
      armedTelegraphs: [],
    };
  }
  const pending = state.pendingWaves;
  const opener = pending.manifests[0];
  if (!opener) {
    return;
  }
  armFloor4WaveTelegraph(
    world,
    state,
    pending.armedTelegraphs,
    opener,
    floor4ActStartMs(act) + opener.releaseAtActMs,
  );
}

/**
 * Release one wave's entries: spawn into whatever live capacity exists right
 * now, and bank only the genuine remainder as spawn debt (bounded by the
 * authored debt cap, FR3.5).
 *
 * Order matters twice over. An entry may only spawn immediately while the debt
 * queue is empty, so older debt never loses its place at the head of the FIFO;
 * and `debtCap` is applied only to entries that actually *become* debt, so a
 * tight (or zero) debt cap throttles backlog rather than deleting a wave that
 * the arena had room for.
 */
function releaseFloor4WaveEntries(
  world: GameWorld,
  state: Floor4ArenaState,
  waves: Floor4WaveWindowState,
  entries: readonly Floor4WaveSpawnEntry[],
  waveIndex: number,
): void {
  const concurrency = getFloor4WaveConfig().concurrency;
  let live = pruneFloor4OwnedEnemies(world, waves);
  for (const [slot, entry] of entries.entries()) {
    if (waves.debt.length === 0 && live < concurrency.liveCap) {
      const eid = spawnFloor4WaveEnemy(world, entry, slot);
      waves.ownedEnemies.set(eid, waveIndex);
      state.waveTelemetry.enemiesSpawned += 1;
      live += 1;
      continue;
    }
    if (waves.debt.length >= concurrency.debtCap) {
      state.waveTelemetry.debtDiscarded += 1;
      continue;
    }
    waves.debt.push({ waveIndex, slot, entry });
  }
}

/**
 * Release banked entries in FIFO manifest order while the live cap allows.
 * Consumes no RNG (FR3.5): the entry was already composed, so cap pressure
 * cannot shift a seed's downstream draws.
 */
function drainFloor4SpawnDebt(
  world: GameWorld,
  state: Floor4ArenaState,
  waves: Floor4WaveWindowState,
): void {
  const liveCap = getFloor4WaveConfig().concurrency.liveCap;
  let live = pruneFloor4OwnedEnemies(world, waves);
  while (waves.debt.length > 0 && live < liveCap) {
    const pending = waves.debt.shift() as Floor4PendingWaveSpawn;
    const eid = spawnFloor4WaveEnemy(world, pending.entry, pending.slot);
    waves.ownedEnemies.set(eid, pending.waveIndex);
    state.waveTelemetry.enemiesSpawned += 1;
    live += 1;
  }
}

/** Release every wave whose act-relative mark has arrived. */
function releaseFloor4DueWaves(
  world: GameWorld,
  state: Floor4ArenaState,
  waves: Floor4WaveWindowState,
  actRelativeMs: number,
): void {
  while (waves.releaseCursor < waves.manifests.length) {
    const manifest = waves.manifests[waves.releaseCursor]!;
    if (manifest.releaseAtActMs > actRelativeMs) {
      return;
    }
    waves.releaseCursor += 1;
    state.waveTelemetry.wavesReleased += 1;
    waves.armedTelegraphs = waves.armedTelegraphs.filter(
      (armed) => armed.waveIndex !== manifest.waveIndex,
    );
    // Drain first so older debt keeps its place at the head of the queue, then
    // release this wave into whatever capacity is left, banking the remainder.
    drainFloor4SpawnDebt(world, state, waves);
    releaseFloor4WaveEntries(world, state, waves, manifest.entries, manifest.waveIndex);
  }
}

/** One wave-window tick: telegraph, release, then release what the cap freed. */
function serviceFloor4WaveWindow(world: GameWorld, state: Floor4ArenaState): void {
  const waves = state.waves;
  if (!waves || state.phase.kind !== 'WAVES') {
    return;
  }
  const actRelativeMs = state.arenaElapsedMs - floor4ActStartMs(waves.act);
  armFloor4GateTelegraphs(world, state, waves, actRelativeMs);
  releaseFloor4DueWaves(world, state, waves, actRelativeMs);
  drainFloor4SpawnDebt(world, state, waves);
}

/**
 * The cut (FR3.6): at the wave-window boundary every surviving wave enemy is
 * pulled off camera.
 *
 * Deliberately NOT a death: health is never zeroed, so `dropSystem` never runs
 * for these entities and they award no XP, no gold, no drops, emit no `death`
 * combat event, and count as neither a kill nor a death in telemetry. They do
 * get the standard death-style pop VFX so the removal reads as intentional
 * rather than as entities blinking out.
 *
 * Enemies that are already dead this frame (zero HP, or lingering on a
 * `DeathTimer`) are left alone — those were real, fully-rewarded kills and the
 * normal death path owns them.
 */
function cutFloor4WaveEnemies(world: GameWorld, state: Floor4ArenaState): void {
  const waves = state.waves;
  if (!waves) {
    return;
  }
  for (const eid of waves.ownedEnemies.keys()) {
    if (!isLiveFloor4WaveEnemy(world, eid)) {
      continue;
    }
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    const bloodColor = hasComponent(world.ecs, eid, BloodColor)
      ? (world.stores.bloodColor.r[eid]! << 16) |
        (world.stores.bloodColor.g[eid]! << 8) |
        world.stores.bloodColor.b[eid]!
      : undefined;
    pushVfxEvent(world.vfxEvents, {
      kind: 'deathPop',
      x,
      y,
      ...(bloodColor === undefined ? {} : { color: bloodColor }),
      intensity: 0.75,
    });
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
    state.waveTelemetry.enemiesCut += 1;
  }
  waves.ownedEnemies.clear();
  // Banked-but-unspawned entries die with the window too; count them so
  // spawned + cut + discarded still accounts for every released entry.
  state.waveTelemetry.debtDiscarded += waves.debt.length;
  waves.debt.length = 0;
  waves.armedTelegraphs.length = 0;
}

/** Live wave-owned enemies right now — lab/telemetry read-only helper. */
export function getFloor4LiveWaveEnemyCount(world: GameWorld): number {
  const waves = floor4ArenaState(world)?.waves;
  if (!waves) {
    return 0;
  }
  let live = 0;
  for (const eid of waves.ownedEnemies.keys()) {
    if (isLiveFloor4WaveEnemy(world, eid)) {
      live += 1;
    }
  }
  return live;
}

function getFloor4HeadlinerConfig() {
  return getFloor4Config().headliners;
}

function floor4HeadlinerArchetype(archetypeId: string): EnemyArchetypeDef {
  const packId = getFloor4HeadlinerConfig().enemyPackId;
  const archetype = getFloorEnemyPack(packId)?.archetypes.find(
    (candidate) => candidate.id === archetypeId,
  );
  if (!archetype) {
    throw new Error(`Floor 4 Headliner archetype "${archetypeId}" missing from pack "${packId}"`);
  }
  return archetype;
}

function resolveFloor4HeadlinerSpawnPosition(world: GameWorld): { x: number; y: number } {
  const floorMap = world.floorMap;
  if (!floorMap) {
    return { x: 0, y: 0 };
  }
  const centerTile = {
    x: Math.floor(floorMap.config.widthTiles / 2),
    y: Math.floor(floorMap.config.heightTiles / 2),
  };
  return floorMap.tileToWorld(centerTile.x, centerTile.y);
}

function spawnFloor4Headliner(
  world: GameWorld,
  state: Floor4ArenaState,
  act: Floor4ActIndex,
): void {
  if (state.activeHeadliner?.act === act) {
    return;
  }
  const card = state.headlinerCard.find((entry) => entry.act === act);
  if (!card) {
    throw new Error(`Floor 4 Headliner card is missing act ${act}`);
  }
  const archetype = floor4HeadlinerArchetype(card.archetypeId);
  const spawn = resolveFloor4HeadlinerSpawnPosition(world);
  const isRanged = archetype.aiType === 'ranged' || archetype.aiType === 'support';
  const eid = spawnBehaviorEnemy(
    world,
    spawn.x,
    spawn.y,
    archetype.hp,
    floor4ArchetypeAiType(archetype),
    archetype.speed,
    archetype.detectRange,
    isRanged ? archetype.detectRange * 0.65 : 0,
    { weight: 240 },
  );
  markFloor4HostileForCoStarIfNeeded(world, eid);
  setComponent(world.ecs, eid, Sprite, {
    textureId: archetype.spriteTexture,
    width: archetype.spriteWidth,
    height: archetype.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    radius:
      archetype.collisionRadius ?? Math.max(archetype.spriteWidth, archetype.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  // Authored, not derived (FR8.2): the per-act contact damage curve is a
  // balance knob owned by the manifest, so the slice-7 tuning pass can move it
  // without editing the director.
  const baseDamage = card.contactDamage;
  addComponent(world.ecs, eid, set(Damage, { amount: baseDamage, cooldownMs: 0, lastFireMs: 0 }));
  setEnemyAppearanceKey(world, eid, archetype.id);
  state.activeHeadliner = {
    ...card,
    bossEid: eid,
    defeated: false,
    feeGranted: false,
    chestSpawned: false,
    chestForceResolved: false,
    baseSpeed: archetype.speed,
    baseDamage,
    appliedOvertimeSteps: 0,
    lastKnownPos: spawn,
  };
  state.headlinerTelemetry.spawned += 1;
  pushAnnouncement(world.announcements, {
    kind: 'bossAbilityCast',
    archetypeIndex: -1,
    text: card.entranceAnnouncement,
    eventId: `${card.slotId}:entry`,
    durationMs: 3500,
    elapsedMs: world.elapsedMs,
  });
}

function sampleFloor4HeadlinerPosition(
  world: GameWorld,
  encounter: Floor4HeadlinerEncounterState,
): void {
  const eid = encounter.bossEid;
  if (eid === null || !entityExists(world.ecs, eid) || !hasComponent(world.ecs, eid, Position)) {
    return;
  }
  encounter.lastKnownPos = {
    x: world.stores.position.x[eid] ?? 0,
    y: world.stores.position.y[eid] ?? 0,
  };
}

function isFloor4HeadlinerDefeated(
  world: GameWorld,
  encounter: Floor4HeadlinerEncounterState,
): boolean {
  const eid = encounter.bossEid;
  if (eid === null) {
    return encounter.defeated;
  }
  if (!entityExists(world.ecs, eid) || !hasComponent(world.ecs, eid, Enemy)) {
    return true;
  }
  return hasComponent(world.ecs, eid, DeathTimer) || (world.stores.health.current[eid] ?? 0) <= 0;
}

function playerEidForFloor4Rewards(world: GameWorld): number | undefined {
  return query(world.ecs, [Player])[0];
}

function resolveFloor4HeadlinerDefeat(world: GameWorld, state: Floor4ArenaState): void {
  const encounter = state.activeHeadliner;
  if (!encounter) {
    return;
  }
  sampleFloor4HeadlinerPosition(world, encounter);
  if (!isFloor4HeadlinerDefeated(world, encounter)) {
    return;
  }
  if (!encounter.defeated) {
    const defeatedEid = encounter.bossEid;
    encounter.defeated = true;
    encounter.bossEid = null;
    state.headlinerTelemetry.defeated += 1;
    if (defeatedEid !== null && entityExists(world.ecs, defeatedEid)) {
      clearEntityStores(world, defeatedEid);
      removeEntity(world.ecs, defeatedEid);
    }
    if (state.phase.kind === 'HEADLINE') {
      state.phase = { kind: 'HEADLINE', act: encounter.act, cleared: true };
    }
  }
  if (!encounter.feeGranted) {
    world.playerGold += encounter.appearanceFeeGold;
    encounter.feeGranted = true;
    state.headlinerTelemetry.appearanceFeeGoldGranted += encounter.appearanceFeeGold;
  }
  if (!encounter.chestSpawned) {
    const result = spawnBossChestForDefeatedBoss(
      world,
      encounter.slotId,
      encounter.lastKnownPos?.x,
      encounter.lastKnownPos?.y,
    );
    if (result.created) {
      state.headlinerTelemetry.chestsSpawned += 1;
    } else if (result.reason !== 'alreadyExists') {
      throw new Error(`Floor 4 Headliner chest failed for ${encounter.slotId}: ${result.reason}`);
    }
    encounter.chestSpawned = true;
  }
}

function forceResolveFloor4HeadlinerChest(world: GameWorld, state: Floor4ArenaState): boolean {
  const encounter = state.activeHeadliner;
  if (!encounter?.defeated || encounter.chestForceResolved) {
    return true;
  }
  const playerEid = playerEidForFloor4Rewards(world);
  if (playerEid === undefined) {
    return false;
  }
  const chestId = createBossChestId(encounter.slotId);
  const chest = world.bossChests.get(chestId);
  if (!chest || chest.state !== 'available') {
    encounter.chestForceResolved = true;
    return true;
  }
  const result = openBossChest(world, chestId, playerEid);
  if (!result.ok) {
    return false;
  }
  const chestEid = world.bossChestEids.get(chestId);
  if (chestEid !== undefined) {
    world.bossChestEids.delete(chestId);
    clearEntityStores(world, chestEid);
    removeEntity(world.ecs, chestEid);
  }
  encounter.chestForceResolved = true;
  state.headlinerTelemetry.chestsForceResolved += 1;
  return true;
}

function startFloor4Overtime(world: GameWorld, state: Floor4ArenaState, act: Floor4ActIndex): void {
  state.arenaElapsedMs = floor4ActEndMs(act);
  state.headlinerTelemetry.overtimeStarted += 1;
  pushAnnouncement(world.announcements, {
    kind: 'bossAbilityCast',
    archetypeIndex: -1,
    text: getFloor4Config().overtime.warningAnnouncement,
    eventId: `floor4-overtime-act-${act}`,
    durationMs: 3000,
    elapsedMs: world.elapsedMs,
  });
  recordFloor4PhaseTransition(world, state, { kind: 'OVERTIME', act }, 'act-mark-overtime');
}

function applyFloor4OvertimeRamp(world: GameWorld, state: Floor4ArenaState): void {
  const encounter = state.activeHeadliner;
  if (!encounter?.bossEid || encounter.defeated) {
    return;
  }
  const steps = getFloor4Config().overtime.rampSteps;
  while (
    encounter.appliedOvertimeSteps < steps.length &&
    state.phaseElapsedMs >= steps[encounter.appliedOvertimeSteps]!.atMs
  ) {
    const step = steps[encounter.appliedOvertimeSteps]!;
    const eid = encounter.bossEid;
    if (entityExists(world.ecs, eid) && hasComponent(world.ecs, eid, EnemyBehavior)) {
      world.stores.enemyBehavior.speed[eid] = encounter.baseSpeed * step.speedMultiplier;
    }
    if (entityExists(world.ecs, eid) && hasComponent(world.ecs, eid, Damage)) {
      world.stores.damage.amount[eid] = encounter.baseDamage * step.damageMultiplier;
    }
    encounter.appliedOvertimeSteps += 1;
    state.headlinerTelemetry.overtimeStepsApplied += 1;
  }
}

function resolveFloor4OvertimeFinisher(world: GameWorld): void {
  const playerEid = playerEidForFloor4Rewards(world);
  if (playerEid !== undefined) {
    applyDamage(
      world,
      playerEid,
      world.stores.health.current[playerEid] ?? 0,
      world.stores.position.x[playerEid] ?? 0,
      world.stores.position.y[playerEid] ?? 0,
      { origin: 'environment', affinity: 'physical', scaleWithPrimary: false, canCrit: false },
    );
  }
  world.state = 'game_over';
}

export function getFloor4ArenaRunStats(world: GameWorld): Floor4ArenaRunStats | undefined {
  const state = floor4ArenaState(world);
  if (!state) {
    return undefined;
  }
  return {
    arenaElapsedMs: state.arenaElapsedMs,
    phase: cloneFloor4Phase(state.phase),
    timeline: state.timeline.map((entry) => ({
      ...entry,
      phase: cloneFloor4Phase(entry.phase),
    })),
    waveTelemetry: { ...state.waveTelemetry },
    headlinerTelemetry: { ...state.headlinerTelemetry },
    headlinerCard: state.headlinerCard.map((entry) => ({ ...entry })),
    actIncome: state.actIncome.map((entry) => ({ ...entry })),
  };
}

export function isFloor4ArenaVictory(world: GameWorld): boolean {
  return floor4ArenaState(world)?.phase.kind === 'VICTORY';
}

/**
 * Floor 4 phase authority (FR8.1) and, as of slice 3, the wave window's only
 * driver. It advances the arena clock, owns every phase transition, and while
 * `WAVES` is live it telegraphs gates, releases scheduled waves, honours the
 * concurrency cap/spawn debt, and cuts survivors at the boundary.
 *
 * Deliberately one system: Headliners, Green Room shops and HUD are later
 * slices and will hang off this same slot rather than a parallel director.
 */
export function arenaDirectorSystem(world: GameWorld): void {
  if (world.floorId !== 'floor4' || world.state !== 'playing') {
    return;
  }
  const state = floor4ArenaState(world);
  if (!state) {
    return;
  }

  const elapsedDeltaMs = Math.max(0, world.elapsedMs - state.lastWorldElapsedMs);
  state.lastWorldElapsedMs = world.elapsedMs;
  if (elapsedDeltaMs === 0 || state.phase.kind === 'VICTORY' || state.phase.kind === 'DEFEAT') {
    return;
  }

  const phaseConfig = getFloor4Config().phase;
  state.phaseElapsedMs += elapsedDeltaMs;

  switch (state.phase.kind) {
    case 'COUNTDOWN':
      prearmFloor4NextActTelegraphs(
        world,
        state,
        1,
        phaseConfig.countdownMs - state.phaseElapsedMs,
      );
      if (state.phaseElapsedMs >= phaseConfig.countdownMs) {
        recordFloor4PhaseTransition(world, state, { kind: 'WAVES', act: 1 }, 'countdown-complete');
      }
      break;
    case 'WAVES':
      state.arenaElapsedMs += elapsedDeltaMs;
      if (state.arenaElapsedMs >= floor4WaveEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4WaveEndMs(state.phase.act);
        // Transition cuts the survivors; servicing this tick would only spawn
        // enemies that the same tick immediately cuts.
        recordFloor4PhaseTransition(
          world,
          state,
          { kind: 'HEADLINE', act: state.phase.act, cleared: false },
          'headline-entry',
        );
      } else {
        serviceFloor4WaveWindow(world, state);
      }
      break;
    case 'HEADLINE':
      state.arenaElapsedMs += elapsedDeltaMs;
      resolveFloor4HeadlinerDefeat(world, state);
      if (state.arenaElapsedMs >= floor4ActEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4ActEndMs(state.phase.act);
        if (state.phase.cleared) {
          if (forceResolveFloor4HeadlinerChest(world, state)) {
            recordFloor4PhaseTransition(
              world,
              state,
              { kind: 'INTERMISSION', act: state.phase.act },
              'act-mark-reached',
            );
          }
        } else {
          startFloor4Overtime(world, state, state.phase.act);
        }
      }
      break;
    case 'INTERMISSION': {
      const nextAct = nextFloor4Act(state.phase.act);
      if (nextAct) {
        prearmFloor4NextActTelegraphs(
          world,
          state,
          nextAct,
          phaseConfig.intermissionMs - state.phaseElapsedMs,
        );
      }
      break;
    }
    case 'OVERTIME': {
      applyFloor4OvertimeRamp(world, state);
      resolveFloor4HeadlinerDefeat(world, state);
      if (state.activeHeadliner?.defeated) {
        if (forceResolveFloor4HeadlinerChest(world, state)) {
          recordFloor4PhaseTransition(
            world,
            state,
            { kind: 'INTERMISSION', act: state.phase.act },
            'overtime-headliner-defeated',
          );
        }
        break;
      }
      const finisherLeadMs = 3000;
      if (
        !state.overtimeFinisherAnnounced &&
        state.phaseElapsedMs >= phaseConfig.overtimeCapMs - finisherLeadMs
      ) {
        pushAnnouncement(world.announcements, {
          kind: 'bossAbilityCast',
          archetypeIndex: -1,
          text: getFloor4Config().overtime.finisherAnnouncement,
          eventId: `floor4-overtime-cap-act-${state.phase.act}`,
          durationMs: finisherLeadMs,
          elapsedMs: world.elapsedMs,
        });
        state.overtimeFinisherAnnounced = true;
        state.phaseElapsedMs = phaseConfig.overtimeCapMs - finisherLeadMs;
        break;
      }
      if (state.phaseElapsedMs >= phaseConfig.overtimeCapMs) {
        recordFloor4PhaseTransition(world, state, { kind: 'DEFEAT' }, 'overtime-cap');
        resolveFloor4OvertimeFinisher(world);
      }
      break;
    }
  }
}

/**
 * Floor 4's public break-exit/stairs confirmation is gated on an intermission
 * whose authored hold has elapsed. Acts 1-4 resume the next wave window; act 5
 * takes the terminal stairs into victory.
 */
export function confirmFloor4StairDescend(world?: GameWorld): boolean {
  if (!world) {
    return false;
  }
  const state = floor4ArenaState(world);
  if (!state || state.phase.kind !== 'INTERMISSION') {
    return false;
  }
  if (state.phaseElapsedMs < getFloor4Config().phase.intermissionMs) {
    return false;
  }
  const nextAct = nextFloor4Act(state.phase.act);
  if (nextAct) {
    recordFloor4PhaseTransition(
      world,
      state,
      { kind: 'WAVES', act: nextAct },
      'public-green-room-exit',
    );
  } else {
    recordFloor4PhaseTransition(world, state, { kind: 'VICTORY' }, 'public-stairs');
  }
  return true;
}

export function getFloor4StairMarkerState(world: GameWorld): ScenarioStairMarkerState | null {
  const state = floor4ArenaState(world);
  if (!state || state.phase.kind !== 'INTERMISSION' || !world.floorMap) {
    return null;
  }
  const layout = computeShowcaseArenaLayout(showcaseArenaOptionsFromConfig(world.floorMap.config));
  const tileSizeFt = world.floorMap.config.tileSizeFt;
  const playerEid = query(world.ecs, [Player])[0];
  const positionFt =
    playerEid !== undefined && hasComponent(world.ecs, playerEid, Position)
      ? {
          x: world.stores.position.x[playerEid] ?? 0,
          y: world.stores.position.y[playerEid] ?? 0,
        }
      : {
          x: (layout.greenRoom.x + layout.greenRoom.width / 2) * tileSizeFt,
          y: (layout.greenRoom.y + layout.greenRoom.height / 2) * tileSizeFt,
        };
  const ready = state.phaseElapsedMs >= getFloor4Config().phase.intermissionMs;
  return {
    positionFt,
    radiusFt: FLOOR2_STAIR_MARKER_RADIUS_FT,
    visible: ready,
    locked: !ready,
    label: state.phase.act === 5 ? '▼ STAIRS' : '▶ EXIT BREAK',
  };
}

export function initializeFloor4Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const manifest = getFloor4Manifest();
  const mapConfig = buildFloor4MapConfig();
  const layout = computeShowcaseArenaLayout(showcaseArenaOptionsFromConfig(mapConfig));
  if (mapConfig.widthTiles < layout.widthTiles || mapConfig.heightTiles < layout.heightTiles) {
    throw new Error(
      `Floor 4 map config is smaller than authored venue: got ${mapConfig.widthTiles}×${mapConfig.heightTiles}, needs at least ${layout.widthTiles}×${layout.heightTiles}`,
    );
  }
  // Deliberately NOT `world.rng`: the venue is authored, so Floor 4 must not
  // consume a draw from the shared combat stream just to build its map.
  const floorMap = getGenerator(mapConfig.biome).generate(
    mapConfig,
    new SeededRandomClass(hashStringToSeed(`${world.seed}:floor4-venue`)),
  );
  world.floorMap = floorMap;
  attachBarriersToFloorMap(world);
  world.floor = 4;
  world.floorId = 'floor4';
  world.floorScenario = null;
  world.floorExtendedState = { floor4Arena: createFloor4ArenaState(world) };
  // FR5.6/FR8.4 — the act clock is the only clock Floor 4 ever shows. The
  // generic readout would otherwise surface the stall backstop as a countdown.
  world.hideFloorTimer = true;

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  removeStatModifiers(world, 'floor', FLOOR4_PLAYER_STAT_SOURCE_ID);
  if (manifest.player.moveSpeedBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR4_PLAYER_STAT_SOURCE_ID,
      stat: 'moveSpeed',
      op: 'add',
      value: manifest.player.moveSpeedBonus,
    });
  }
  if (manifest.player.pickupRangeBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR4_PLAYER_STAT_SOURCE_ID,
      stat: 'pickupRange',
      op: 'add',
      value: manifest.player.pickupRangeBonus,
    });
  }
  if (!options?.playerCarryover && hasComponent(world.ecs, playerEid, Health)) {
    const maxHp = (world.stores.health.max[playerEid] ?? 100) + manifest.player.hpBonus;
    setComponent(world.ecs, playerEid, Health, { current: maxHp, max: maxHp });
  }

  if (options?.playerCarryover) {
    restorePlayerCarryover(world, playerEid, options.playerCarryover);
    initializePlayerWeaponSkills(world, playerEid);
    const state = floor4ArenaState(world);
    if (state && spawnFloor4KeptCompanionCoStar(world, playerEid, options.playerCarryover)) {
      state.keptCompanionCoStarActive = true;
    }
  } else {
    equipFloor4StarterWeapon(world, playerEid, manifest.starterWeapons);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  world.state = 'playing';
  world.goalFlags.set(FLOOR4_STALL_BACKSTOP_GOAL_ID, false);
  world.floorObjectiveTick = floor4ObjectiveTick;
}

/**
 * Cold-start loadout. Uses its own named sub-seed rather than `world.rng` so a
 * cold Floor 4 boot perturbs no shared stream (FR7.1).
 */
function equipFloor4StarterWeapon(
  world: GameWorld,
  playerEid: number,
  starterWeaponPool: readonly string[],
): void {
  if (starterWeaponPool.length === 0) {
    return;
  }
  const weaponRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor4-starter-weapon`));
  const pickedId = starterWeaponPool[weaponRng.nextInt(0, starterWeaponPool.length - 1)];
  const weaponDef =
    (pickedId ? getWeaponDef(pickedId) : undefined) ??
    (starterWeaponPool[0] ? getWeaponDef(starterWeaponPool[0]) : undefined);
  if (!weaponDef) {
    return;
  }
  equipStarterOrFallback(world, weaponDef.id, weaponDef);
  initializePlayerWeaponSkills(world, playerEid);
}
