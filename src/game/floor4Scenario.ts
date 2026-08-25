/**
 * Floor 4 — "The Main Event" scenario, slice 2 (venue + deterministic rehearsal).
 *
 * This slice boots the authored venue and runs the empty-arena rehearsal
 * timeline via `arenaDirectorSystem`: COUNTDOWN → five WAVES/HEADLINE/
 * INTERMISSION acts → VICTORY. Combat waves, Headliners, Green Room
 * transactions and shops still land in later slices; today's goal is proving the
 * broadcast clock/phase plumbing in both game and headless paths.
 *
 * Key contracts:
 *
 * - **The stairs stay gated by `INTERMISSION(5)` (FR8.3).** Slice 2 exposes the
 *   same phase-gated `confirmFloor4StairDescend` contract used by later slices.
 * - **No generic countdown timer is shown (FR5.6/FR8.4).** `timer.durationMs`
 *   remains a raw stall backstop, so `world.hideFloorTimer` suppresses the
 *   generic floor HUD timer.
 * - **Rehearsal intermissions auto-advance.** Until Green Room/shop slices ship,
 *   intermissions hold briefly then advance automatically, with final act
 *   intermission auto-transitioning to VICTORY.
 */
import { addComponent, hasComponent, query, removeEntity, setComponent, set } from 'bitecs';
import {
  ArenaWaveEnemy,
  BroadcastScore,
  DeathTimer,
  Enemy,
  Health,
  Position,
  Size,
  Sprite,
  Team,
  type GameWorld,
} from '../core/index.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../core/spawners/combatants.js';
import { clearEntityStores } from '../core/helpers.js';
import { SHAPE_CIRCLE } from '../core/physics-defs.js';
import { getFloorEnemyPack, type EnemyArchetypeDef } from '../shared/enemy-packs.js';
import { TeamId } from '../shared/constants.js';
import { pushVfxEvent } from '../shared/vfx-events.js';
import { AI_TYPE } from './enemyAISystem.js';
import {
  buildFloor4ActWaveManifests,
  floor4WaveManifestFingerprint,
} from './floor4/wave-manifest.js';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import {
  computeShowcaseArenaLayout,
  showcaseArenaOptionsFromConfig,
} from '../core/map/generators/ShowcaseArenaGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import type {
  Floor4ActIndex,
  Floor4ArenaPhase,
  Floor4ArenaRunStats,
  Floor4ArenaState,
  Floor4GateSpawnSlot,
  Floor4WaveSpawn,
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

/** The authored wave block (spec FR3.3) — every wave number the director reads. */
function getFloor4WaveConfig() {
  const waves = getFloor4Config().waves;
  if (!waves) {
    throw new Error('Missing floor4 wave config');
  }
  return waves;
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

function recordFloor4PhaseTransition(
  world: GameWorld,
  state: Floor4ArenaState,
  phase: Floor4ArenaPhase,
  reason: string,
): void {
  state.phase = cloneFloor4Phase(phase);
  state.phaseElapsedMs = 0;
  state.timeline.push({
    frame: world.frameCount,
    worldElapsedMs: world.elapsedMs,
    arenaElapsedMs: state.arenaElapsedMs,
    phase: cloneFloor4Phase(phase),
    reason,
  });
}

function createFloor4ArenaState(world: GameWorld): Floor4ArenaState {
  const state: Floor4ArenaState = {
    phase: { kind: 'COUNTDOWN' },
    arenaElapsedMs: 0,
    phaseElapsedMs: 0,
    lastWorldElapsedMs: world.elapsedMs,
    timeline: [],
    waveManifests: [],
    waveManifestAct: null,
    telegraphCursor: 0,
    releaseCursor: 0,
    spawnDebt: [],
    activeGateTelegraphs: [],
    gateSpawnSlots: enumerateFloor4GateSpawnSlots(world),
    waveStats: {
      wavesReleased: 0,
      enemiesScheduled: 0,
      enemiesSpawned: 0,
      peakLiveHostiles: 0,
      spawnsDeferred: 0,
      spawnsDiscarded: 0,
      debtCleared: 0,
      enemiesCut: 0,
      gateTelegraphsFired: 0,
    },
    waveManifestFingerprints: [],
  };
  recordFloor4PhaseTransition(world, state, { kind: 'COUNTDOWN' }, 'floor4-initialized');
  return state;
}

/** Max spawn slots enumerated per feed gate; unwalkable candidates are dropped. */
const FLOOR4_MAX_SLOTS_PER_GATE = 5;

/**
 * Enumerate the deterministic spawn slots behind each feed gate, once, at floor
 * init (spec FR3.4).
 *
 * Spec-critical: gate placement is FIXED and indexed, never player-relative and
 * never retried at spawn time. Enumerating up front means the release path
 * consumes no RNG and cannot fail mid-wave; an unwalkable authored venue fails
 * loudly here instead of silently dropping spawns for the whole run.
 */
function enumerateFloor4GateSpawnSlots(
  world: GameWorld,
): readonly (readonly Floor4GateSpawnSlot[])[] {
  const floorMap = world.floorMap;
  const gates = floorMap?.feedGates ?? [];
  if (!floorMap || gates.length === 0) {
    throw new Error('Floor 4 venue has no feed gates to spawn waves from');
  }
  const spacingFt = getFloor4WaveConfig().gateSlotSpacingFt;
  const slots = gates.map((gate) => {
    const origin = floorMap.tileToWorld(gate.x, gate.y);
    // Slots fan out ALONG the arena edge the gate sits on, so they stay inside
    // the arena rather than marching into the wall behind the gate.
    const alongX = gate.direction === 'north' || gate.direction === 'south' ? 1 : 0;
    const alongY = alongX === 1 ? 0 : 1;
    const gateSlots: Floor4GateSpawnSlot[] = [];
    for (let i = 0; i < FLOOR4_MAX_SLOTS_PER_GATE; i += 1) {
      // 0, +1, -1, +2, -2 … keeps slot 0 on the gate mouth and stays symmetric.
      const step = Math.ceil(i / 2) * (i % 2 === 0 ? -1 : 1);
      const x = origin.x + alongX * step * spacingFt;
      const y = origin.y + alongY * step * spacingFt;
      if (floorMap.isPassableAt(x, y)) {
        gateSlots.push({ x, y });
      }
    }
    if (gateSlots.length === 0) {
      throw new Error(
        `Floor 4 feed gate ${gate.index} (${gate.direction}) has no walkable spawn slot`,
      );
    }
    return gateSlots;
  });
  return slots;
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
    waves: { ...state.waveStats },
    waveManifestFingerprints: [...state.waveManifestFingerprints],
  };
}

export function isFloor4ArenaVictory(world: GameWorld): boolean {
  return floor4ArenaState(world)?.phase.kind === 'VICTORY';
}

// --- Waves (spec R3) ---------------------------------------------------------

/** Arena-clock time (absolute) at which act `act` begins its wave window. */
function floor4ActStartMs(act: Floor4ActIndex): number {
  return getFloor4Config().phase.actDurationMs * (act - 1);
}

/**
 * Arm an act: roll and freeze its wave manifests, reset the cursors, and record
 * the fingerprint. Called exactly once per act, on the transition into WAVES —
 * re-arming would re-roll a plan the spec requires to be immutable (FR7.1).
 */
function armFloor4Act(world: GameWorld, state: Floor4ArenaState, act: Floor4ActIndex): void {
  const config = getFloor4WaveConfig();
  const manifests = buildFloor4ActWaveManifests(
    config,
    act,
    world.seed,
    state.gateSpawnSlots.map((slots) => slots.length),
  );
  state.waveManifests = manifests;
  state.waveManifestAct = act;
  state.telegraphCursor = 0;
  state.releaseCursor = 0;
  state.activeGateTelegraphs = [];
  state.waveManifestFingerprints.push(floor4WaveManifestFingerprint(manifests));
}

/** Live hostile arena combatants, the quantity `concurrencyCap` bounds (FR3.5). */
function countFloor4LiveHostiles(world: GameWorld): number {
  let live = 0;
  for (const eid of query(world.ecs, [Enemy, Health])) {
    // Corpses mid-death-animation still carry Enemy+Health, but they are no
    // longer a threat and must not hold a wave slot hostage.
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;
    if (hasComponent(world.ecs, eid, Team) && world.stores.team.id[eid] === TeamId.PLAYER) continue;
    live += 1;
  }
  return live;
}

function recordFloor4LiveHostilePeak(world: GameWorld, state: Floor4ArenaState): void {
  state.waveStats.peakLiveHostiles = Math.max(
    state.waveStats.peakLiveHostiles,
    countFloor4LiveHostiles(world),
  );
}

const FLOOR4_AI_TYPES: Readonly<Record<string, number>> = {
  chase: AI_TYPE.CHASE,
  patrol: AI_TYPE.CHASE,
  flee: AI_TYPE.CHASE,
  ranged: AI_TYPE.RANGED,
  leaper: AI_TYPE.LEAPER,
  guardian: AI_TYPE.GUARDIAN,
  support: AI_TYPE.SUPPORT,
};

function floor4Archetype(archetypeId: string): EnemyArchetypeDef {
  const pack = getFloorEnemyPack(getFloor4WaveConfig().enemyPackId);
  const archetype = pack?.archetypes.find((entry) => entry.id === archetypeId);
  if (!archetype) {
    // Unreachable in practice: the manifest schema cross-validates every roster
    // id against this pack at load. Kept so a future data edit fails loudly.
    throw new Error(`Floor 4 wave references unknown archetype "${archetypeId}"`);
  }
  return archetype;
}

/** Spawn one manifest entry at its fixed gate slot and tag it as wave-owned. */
function spawnFloor4WaveEnemy(
  world: GameWorld,
  state: Floor4ArenaState,
  spawn: Floor4WaveSpawn,
): void {
  const slot = state.gateSpawnSlots[spawn.gateIndex]?.[spawn.slotIndex];
  if (!slot) {
    return;
  }
  const archetype = floor4Archetype(spawn.archetypeId);
  const eid = spawnBehaviorEnemy(
    world,
    slot.x,
    slot.y,
    archetype.hp,
    FLOOR4_AI_TYPES[archetype.aiType] ?? AI_TYPE.CHASE,
    archetype.speed,
    archetype.detectRange,
    archetype.aiType === 'ranged' || archetype.aiType === 'support'
      ? archetype.detectRange * 0.65
      : 0,
  );
  addComponent(world.ecs, eid, set(Team, { id: TeamId.ENEMY }));
  addComponent(world.ecs, eid, ArenaWaveEnemy);
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
}

/**
 * Drain queued spawn debt in manifest order while the concurrency cap allows
 * (spec FR3.5). Order is FIFO across waves, so an older wave never gets starved
 * by a newer one.
 */
function drainFloor4SpawnDebt(world: GameWorld, state: Floor4ArenaState): void {
  const cap = getFloor4WaveConfig().concurrencyCap;
  let live = countFloor4LiveHostiles(world);
  while (state.spawnDebt.length > 0 && live < cap) {
    const spawn = state.spawnDebt.shift();
    if (!spawn) {
      break;
    }
    spawnFloor4WaveEnemy(world, state, spawn);
    state.waveStats.enemiesSpawned += 1;
    live += 1;
    state.waveStats.peakLiveHostiles = Math.max(state.waveStats.peakLiveHostiles, live);
  }
}

/**
 * Queue a wave's spawns, honouring the debt ceiling (excess is discarded).
 * Returns how many entries actually joined the queue.
 */
function queueFloor4Spawns(state: Floor4ArenaState, spawns: readonly Floor4WaveSpawn[]): number {
  const debtCap = getFloor4WaveConfig().debtCap;
  let queued = 0;
  for (const spawn of spawns) {
    if (state.spawnDebt.length >= debtCap) {
      // Spec FR3.5: debt is bounded. Dropping the overflow keeps a player who
      // ignores the arena from banking an unsurvivable backlog.
      state.waveStats.spawnsDiscarded += 1;
      continue;
    }
    state.spawnDebt.push(spawn);
    queued += 1;
  }
  return queued;
}

/**
 * Fire every telegraph and release every wave whose act-relative time has been
 * reached, then drain debt. Called after each boundary step, so a large frame
 * delta still processes waves in chronological order.
 */
function processFloor4Waves(world: GameWorld, state: Floor4ArenaState): void {
  if (state.phase.kind !== 'WAVES' || state.waveManifestAct !== state.phase.act) {
    return;
  }
  // Once the wave window has closed, the boundary owns what happens next: the
  // cut removes the survivors and unreleased debt is cleared (FR3.5/FR3.6).
  // Draining debt on that same tick would spawn enemies only to cut them.
  if (state.arenaElapsedMs >= floor4WaveEndMs(state.phase.act)) {
    return;
  }
  const actRelativeMs = state.arenaElapsedMs - floor4ActStartMs(state.phase.act);

  while (state.telegraphCursor < state.waveManifests.length) {
    const wave = state.waveManifests[state.telegraphCursor];
    if (!wave || wave.telegraphAtMs > actRelativeMs) {
      break;
    }
    state.telegraphCursor += 1;
    const gateIndexes = [...new Set(wave.spawns.map((spawn) => spawn.gateIndex))];
    for (const gateIndex of gateIndexes) {
      state.activeGateTelegraphs.push({
        gateIndex,
        waveIndex: wave.waveIndex,
        expiresAtMs: wave.releaseAtMs,
      });
      state.waveStats.gateTelegraphsFired += 1;
      const slot = state.gateSpawnSlots[gateIndex]?.[0];
      if (slot) {
        pushVfxEvent(world.vfxEvents, { kind: 'spawnerPulse', x: slot.x, y: slot.y });
      }
    }
  }

  while (state.releaseCursor < state.waveManifests.length) {
    const wave = state.waveManifests[state.releaseCursor];
    if (!wave || wave.releaseAtMs > actRelativeMs) {
      break;
    }
    state.releaseCursor += 1;
    state.activeGateTelegraphs = state.activeGateTelegraphs.filter(
      (telegraph) => telegraph.waveIndex !== wave.waveIndex,
    );
    state.waveStats.wavesReleased += 1;
    state.waveStats.enemiesScheduled += wave.spawns.length;
    const queued = queueFloor4Spawns(state, wave.spawns);
    drainFloor4SpawnDebt(world, state);
    recordFloor4LiveHostilePeak(world, state);
    // Whatever this wave queued but could not place immediately is deferred to
    // debt, not lost. The drain is FIFO, so the entries still queued afterwards
    // are exactly the tail — i.e. the newest ones, this wave's.
    state.waveStats.spawnsDeferred += Math.min(queued, state.spawnDebt.length);
  }

  drainFloor4SpawnDebt(world, state);
  recordFloor4LiveHostilePeak(world, state);
}

/**
 * "The cut" (spec FR3.6): when a wave window ends, every surviving wave enemy
 * is removed with a death pop that awards NOTHING — no XP, no gold, no drops —
 * and counts as neither a kill nor a death.
 *
 * The director runs before damage/drop resolution in the frame, so entities
 * already dying this frame are skipped: cutting them would race `dropSystem`
 * and could erase a kill the player legitimately earned.
 */
function applyFloor4Cut(world: GameWorld, state: Floor4ArenaState): void {
  for (const eid of query(world.ecs, [ArenaWaveEnemy, Health])) {
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;
    if (hasComponent(world.ecs, eid, Position)) {
      pushVfxEvent(world.vfxEvents, {
        kind: 'deathPop',
        x: world.stores.position.x[eid] ?? 0,
        y: world.stores.position.y[eid] ?? 0,
      });
    }
    // Deliberately NOT a combat `death` event: the headless runner counts those
    // as kills, and a cut enemy is explicitly not a kill.
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
    state.waveStats.enemiesCut += 1;
  }
  state.activeGateTelegraphs = [];
}

/** Every phase transition drops unreleased debt (spec FR3.5). */
function clearFloor4SpawnDebt(state: Floor4ArenaState): void {
  state.waveStats.debtCleared += state.spawnDebt.length;
  state.spawnDebt = [];
}

/**
 * Floor 4 phase authority (spec R3/R8). It owns the arena clock, the phase
 * timeline, and — as of slice 3 — wave telegraphs, releases, the concurrency
 * cap, spawn debt and the cut.
 *
 * The tick is a **bounded chronological boundary loop** rather than a single
 * switch: a large frame delta (or a test advancing a whole act in one call)
 * must still fire every wave and phase boundary in order, instead of skipping
 * to the end and swallowing the waves in between.
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
  if (elapsedDeltaMs === 0 || isFloor4TerminalPhase(state)) {
    return;
  }

  let remainingMs = elapsedDeltaMs;
  // Bound: each iteration either consumes >= 1 ms or crosses a boundary, and
  // the boundary count per act is fixed, so this can never spin.
  let guard = 0;
  const guardLimit = 4096;
  while (remainingMs > 0 && !isFloor4TerminalPhase(state) && guard < guardLimit) {
    guard += 1;
    const stepMs = Math.min(remainingMs, floor4NextBoundaryMs(state));
    remainingMs -= stepMs;
    advanceFloor4Clock(state, stepMs);
    processFloor4Waves(world, state);
    applyFloor4PhaseBoundary(world, state);
  }
}

/** VICTORY/DEFEAT stop the arena clock permanently. */
function isFloor4TerminalPhase(state: Floor4ArenaState): boolean {
  return state.phase.kind === 'VICTORY' || state.phase.kind === 'DEFEAT';
}

/** Advance the phase clock, and the arena clock for the phases it runs in. */
function advanceFloor4Clock(state: Floor4ArenaState, stepMs: number): void {
  state.phaseElapsedMs += stepMs;
  // The arena clock is held during OVERTIME and INTERMISSION (spec FR1.2).
  if (state.phase.kind === 'WAVES' || state.phase.kind === 'HEADLINE') {
    state.arenaElapsedMs += stepMs;
  }
}

/**
 * Milliseconds until the next scheduled event — the earliest of the current
 * phase's end and (in WAVES) the next telegraph or release. Always >= 1 so the
 * loop makes progress even when a boundary is already due.
 */
function floor4NextBoundaryMs(state: Floor4ArenaState): number {
  const phaseConfig = getFloor4Config().phase;
  const candidates: number[] = [];
  switch (state.phase.kind) {
    case 'COUNTDOWN':
      candidates.push(phaseConfig.countdownMs - state.phaseElapsedMs);
      break;
    case 'WAVES': {
      candidates.push(floor4WaveEndMs(state.phase.act) - state.arenaElapsedMs);
      const actStart = floor4ActStartMs(state.phase.act);
      const nextTelegraph = state.waveManifests[state.telegraphCursor];
      if (nextTelegraph) {
        candidates.push(actStart + nextTelegraph.telegraphAtMs - state.arenaElapsedMs);
      }
      const nextRelease = state.waveManifests[state.releaseCursor];
      if (nextRelease) {
        candidates.push(actStart + nextRelease.releaseAtMs - state.arenaElapsedMs);
      }
      break;
    }
    case 'HEADLINE':
      candidates.push(floor4ActEndMs(state.phase.act) - state.arenaElapsedMs);
      break;
    case 'INTERMISSION':
      candidates.push(phaseConfig.intermissionMs - state.phaseElapsedMs);
      break;
    case 'OVERTIME':
      candidates.push(phaseConfig.overtimeCapMs - state.phaseElapsedMs);
      break;
    default:
      break;
  }
  const next = Math.min(...candidates.filter((value) => Number.isFinite(value)));
  return Number.isFinite(next) ? Math.max(1, next) : Number.POSITIVE_INFINITY;
}

/** Apply at most one phase transition, if the current phase's boundary is due. */
function applyFloor4PhaseBoundary(world: GameWorld, state: Floor4ArenaState): void {
  const phaseConfig = getFloor4Config().phase;
  switch (state.phase.kind) {
    case 'COUNTDOWN':
      if (state.phaseElapsedMs >= phaseConfig.countdownMs) {
        transitionFloor4Phase(world, state, { kind: 'WAVES', act: 1 }, 'countdown-complete');
      }
      break;
    case 'WAVES':
      if (state.arenaElapsedMs >= floor4WaveEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4WaveEndMs(state.phase.act);
        transitionFloor4Phase(
          world,
          state,
          { kind: 'HEADLINE', act: state.phase.act, cleared: true },
          'slice2-empty-headline',
        );
      }
      break;
    case 'HEADLINE':
      if (state.arenaElapsedMs >= floor4ActEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4ActEndMs(state.phase.act);
        transitionFloor4Phase(
          world,
          state,
          { kind: 'INTERMISSION', act: state.phase.act },
          'act-mark-reached',
        );
      }
      break;
    case 'INTERMISSION': {
      if (state.phaseElapsedMs < phaseConfig.intermissionMs) {
        break;
      }
      const nextAct = nextFloor4Act(state.phase.act);
      if (nextAct) {
        transitionFloor4Phase(
          world,
          state,
          { kind: 'WAVES', act: nextAct },
          'slice2-auto-green-room-exit',
        );
      } else {
        transitionFloor4Phase(world, state, { kind: 'VICTORY' }, 'slice2-auto-stairs');
      }
      break;
    }
    case 'OVERTIME':
      if (state.phaseElapsedMs >= phaseConfig.overtimeCapMs) {
        transitionFloor4Phase(world, state, { kind: 'DEFEAT' }, 'overtime-cap');
        world.state = 'game_over';
      }
      break;
    default:
      break;
  }
}

/**
 * Phase change plus its wave-side effects: the cut when a wave window ends,
 * unconditional debt clearing, and arming the incoming act's manifests.
 */
function transitionFloor4Phase(
  world: GameWorld,
  state: Floor4ArenaState,
  phase: Floor4ArenaPhase,
  reason: string,
): void {
  if (state.phase.kind === 'WAVES') {
    applyFloor4Cut(world, state);
  }
  clearFloor4SpawnDebt(state);
  recordFloor4PhaseTransition(world, state, phase, reason);
  if (phase.kind === 'WAVES') {
    armFloor4Act(world, state, phase.act);
    processFloor4Waves(world, state);
  }
}

/**
 * Floor 4's stairs are gated on `INTERMISSION(5)` (FR8.3). That phase arrives
 * with the final Green Room transaction. Slice 2 exposes the phase check even
 * though its rehearsal director auto-takes those stairs after a short hold.
 */
export function confirmFloor4StairDescend(world?: GameWorld): boolean {
  const phase = world ? floor4ArenaState(world)?.phase : undefined;
  return phase?.kind === 'INTERMISSION' && phase.act === 5;
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
  } else {
    equipFloor4StarterWeapon(world, playerEid, manifest.starterWeapons);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
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
