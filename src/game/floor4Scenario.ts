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
import { addComponent, hasComponent, setComponent, set } from 'bitecs';
import { BroadcastScore, Health, Position, type GameWorld } from '../core/index.js';
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
  };
}

export function isFloor4ArenaVictory(world: GameWorld): boolean {
  return floor4ArenaState(world)?.phase.kind === 'VICTORY';
}

/**
 * Floor 4 slice 2 phase authority. It advances only the arena clock and phase
 * timeline; waves, Headliners, Green Room shops and HUD are later slices.
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
      if (state.phaseElapsedMs >= phaseConfig.countdownMs) {
        recordFloor4PhaseTransition(world, state, { kind: 'WAVES', act: 1 }, 'countdown-complete');
      }
      break;
    case 'WAVES':
      state.arenaElapsedMs += elapsedDeltaMs;
      if (state.arenaElapsedMs >= floor4WaveEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4WaveEndMs(state.phase.act);
        recordFloor4PhaseTransition(
          world,
          state,
          { kind: 'HEADLINE', act: state.phase.act, cleared: true },
          'slice2-empty-headline',
        );
      }
      break;
    case 'HEADLINE':
      state.arenaElapsedMs += elapsedDeltaMs;
      if (state.arenaElapsedMs >= floor4ActEndMs(state.phase.act)) {
        state.arenaElapsedMs = floor4ActEndMs(state.phase.act);
        recordFloor4PhaseTransition(
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
        recordFloor4PhaseTransition(
          world,
          state,
          { kind: 'WAVES', act: nextAct },
          'slice2-auto-green-room-exit',
        );
      } else {
        recordFloor4PhaseTransition(world, state, { kind: 'VICTORY' }, 'slice2-auto-stairs');
      }
      break;
    }
    case 'OVERTIME':
      if (state.phaseElapsedMs >= phaseConfig.overtimeCapMs) {
        recordFloor4PhaseTransition(world, state, { kind: 'DEFEAT' }, 'overtime-cap');
        world.state = 'game_over';
      }
      break;
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
