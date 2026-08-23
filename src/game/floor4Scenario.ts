/**
 * Floor 4 — "The Main Event" scenario, slice 1 (floor plumbing + arena map).
 *
 * This slice boots the authored venue and nothing else: the player lands in the
 * middle of an empty arena and can walk down the curtain tunnel into the Green
 * Room. The arena clock, the phase machine (`arenaDirectorSystem`), waves,
 * Headliners and the Green Room shops are slices 2–7 of
 * `.specify/specs/floor4-arena.md`, and are deliberately absent here rather
 * than stubbed.
 *
 * Two contracts this file already honours, because getting them wrong later is
 * expensive:
 *
 * - **The stairs stay shut.** FR8.3 gates descent on `INTERMISSION(5)`, a phase
 *   that does not exist yet, so {@link confirmFloor4StairDescend} refuses
 *   unconditionally. Refusing is correct; a permissive stub would let a player
 *   leave an unfinished floor.
 * - **No countdown is shown.** FR5.6/FR8.4 make `timer.durationMs` a raw stall
 *   backstop, never a broadcast countdown, so the generic floor-timer HUD is
 *   suppressed (`world.hideFloorTimer`). Reaching the backstop means a
 *   non-terminating bug or an abandoned run, which is why it sets its own
 *   {@link FLOOR4_STALL_BACKSTOP_GOAL_ID} flag instead of reusing a floor
 *   "timeout" that a player could legitimately hit.
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
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';

/**
 * Set when the raw elapsed-time stall backstop (FR8.4) fires. This is NOT an
 * ordinary floor timeout: it means the floor failed to terminate or the run was
 * abandoned, and it is recorded explicitly so a run that hits it is
 * distinguishable from a player who simply ran out of time.
 */
export const FLOOR4_STALL_BACKSTOP_GOAL_ID = 'floor4-stall-backstop';

const FLOOR4_PLAYER_STAT_SOURCE_ID = 'floor4-manifest-player';

function getFloor4Manifest() {
  const manifest = getFloorManifest('floor4');
  if (!manifest) {
    throw new Error('Missing floor4 manifest');
  }
  return manifest;
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

/**
 * Floor 4's stairs are gated on `INTERMISSION(5)` (FR8.3). That phase arrives
 * with slice 5, so descent is refused until then.
 */
export function confirmFloor4StairDescend(): boolean {
  return false;
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
  world.floorExtendedState = {};
  // FR5.6/FR8.4 — the act clock is the only clock Floor 4 ever shows, and it
  // does not exist until slice 2. The generic readout would otherwise surface
  // the stall backstop as a countdown.
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
