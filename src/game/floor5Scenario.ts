import { addComponent, hasComponent, set, setComponent } from 'bitecs';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import { setGoalFlag } from '../core/door-lock.js';
import { BroadcastScore, Health, Position, type GameWorld } from '../core/index.js';
import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
} from '../core/map/generators/SiegeCastleGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { SeededRandom as SeededRandomClass, hashStringToSeed } from '../shared/random.js';
import type {
  Floor5RamComponentClass,
  Floor5RequisitionMilestone,
  Floor5SiegePhase,
  Floor5SiegePhaseTraceEntry,
  Floor5SiegeRunStats,
  Floor5SiegeState,
} from '../shared/floor-types.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { addStatModifier, removeStatModifiers } from './systems/statsSystem.js';
import { acceptQuest, setTrackedQuest } from '../core/systems/questSystem.js';

const FLOOR5_PLAYER_STAT_SOURCE_ID = 'floor5-manifest-player';
const FLOOR5_RAM_BUILD_REQUIRED_MS = 3_000;
const FLOOR5_RAM_COMPONENT_CLASSES = [
  'chassis',
  'plating',
  'broadcast-array',
] as const satisfies readonly Floor5RamComponentClass[];
const FLOOR5_REQUISITION_MILESTONES = [
  'opening-push',
  'siege-yard',
  'components',
  'checkpoint',
] as const satisfies readonly Floor5RequisitionMilestone[];

const FLOOR5_SIEGE_GOAL_IDS = {
  openingPushRepelled: 'floor5.siege.openingPushRepelled',
  yardSecured: 'floor5.siege.yardSecured',
  componentsReady: 'floor5.siege.componentsReady',
  ramBuilt: 'floor5.siege.ramBuilt',
  checkpointCleared: 'floor5.siege.checkpointCleared',
  wallBreached: 'floor5.siege.wallBreached',
  courtyardCleared: 'floor5.siege.courtyardCleared',
  regentDefeated: 'floor5.siege.regentDefeated',
  castleCaptured: 'floor5.siege.castleCaptured',
} as const;

const FLOOR5_SLICE3_QUEST_IDS = [
  'floor5-hold-the-line',
  'floor5-secure-synergy',
  'floor5-recover-components',
  'floor5-clear-checkpoint',
  'floor5-build-ratings-ram',
] as const;

export type Floor5FieldTaskId = 'openingPush' | 'siegeYard' | 'checkpoint';

function getFloor5Manifest() {
  const manifest = getFloorManifest('floor5');
  if (!manifest) {
    throw new Error('Missing floor5 manifest');
  }
  return manifest;
}

function getFloor5Config() {
  const floor5 = getFloor5Manifest().floor5;
  if (!floor5) {
    throw new Error('Missing floor5 geometry/phase config');
  }
  return floor5;
}

function buildFloor5MapConfig(): MapConfig {
  const manifest = getFloor5Manifest();
  const geometry = manifest.floor5;
  return {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.SIEGE_CASTLE,
    seed: manifest.map.seed,
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    siegeCastle: geometry
      ? {
          commandPostWidthTiles: geometry.commandPost.widthTiles,
          commandPostHeightTiles: geometry.commandPost.heightTiles,
          siegeYardWidthTiles: geometry.siegeYard.widthTiles,
          siegeYardHeightTiles: geometry.siegeYard.heightTiles,
          pocketWidthTiles: geometry.flankPockets.widthTiles,
          pocketHeightTiles: geometry.flankPockets.heightTiles,
          laneLengthTiles: geometry.lane.lengthTiles,
          laneWidthTiles: geometry.lane.widthTiles,
          outerWallThicknessTiles: geometry.outerWall.thicknessTiles,
          breachWidthTiles: geometry.outerWall.breachWidthTiles,
          courtyardWidthTiles: geometry.courtyard.widthTiles,
          courtyardHeightTiles: geometry.courtyard.heightTiles,
          throneRoomWidthTiles: geometry.throneRoom.widthTiles,
          throneRoomHeightTiles: geometry.throneRoom.heightTiles,
          balconyWidthTiles: geometry.winnersBalcony.widthTiles,
          balconyHeightTiles: geometry.winnersBalcony.heightTiles,
          borderThicknessTiles: geometry.borderThicknessTiles,
        }
      : undefined,
  };
}

function clonePhase(phase: Floor5SiegePhase): Floor5SiegePhase {
  return { ...phase };
}

function cloneTraceEntry(entry: Floor5SiegePhaseTraceEntry): Floor5SiegePhaseTraceEntry {
  return { ...entry, phase: clonePhase(entry.phase) };
}

function hasAllFloor5RamComponents(state: Floor5SiegeState): boolean {
  return FLOOR5_RAM_COMPONENT_CLASSES.every((componentClass) =>
    state.tasks.recoveredComponents.includes(componentClass),
  );
}

function hasFloor5RamPrerequisites(state: Floor5SiegeState): boolean {
  return (
    state.tasks.openingPushRepelled &&
    state.tasks.yardSecured &&
    hasAllFloor5RamComponents(state) &&
    state.tasks.checkpointCleared
  );
}

function latchFloor5RequisitionMilestone(
  state: Floor5SiegeState,
  milestone: Floor5RequisitionMilestone,
): void {
  if (!state.requisitionMilestones.includes(milestone)) {
    state.requisitionMilestones.push(milestone);
  }
}

function createFloor5SiegeState(world: GameWorld): Floor5SiegeState {
  const config = getFloor5Config();
  const rngStreamKeys = Object.fromEntries(
    config.rngStreams.map((label) => [label, `${world.seed}:floor5:${label}`]),
  ) as Floor5SiegeState['rngStreamKeys'];
  return {
    phase: { kind: config.phase.initial },
    lastWorldElapsedMs: world.elapsedMs,
    commandPostHealth: config.commandPost.health,
    engineState: 'LOCKED',
    breachState: 'SEALED',
    heroState: 'PENDING',
    tasks: {
      openingPushRepelled: false,
      yardSecured: false,
      recoveredComponents: [],
      checkpointCleared: false,
    },
    requisitionMilestones: [],
    construction: {
      progressMs: 0,
      requiredMs: FLOOR5_RAM_BUILD_REQUIRED_MS,
      lastProgressWorldElapsedMs: world.elapsedMs,
      buildSiteUnderAttack: false,
      pausedMs: 0,
      attempts: 0,
      deniedAttempts: 0,
      startedFrame: null,
      completedFrame: null,
    },
    rngStreamKeys,
    trace: [],
  };
}

function floor5SiegeState(world: GameWorld): Floor5SiegeState | undefined {
  return world.floorExtendedState?.floor5Siege;
}

function recordFloor5PhaseTransition(
  world: GameWorld,
  state: Floor5SiegeState,
  phase: Floor5SiegePhase,
  reason: string,
): void {
  state.phase = phase;
  state.trace.push({
    phase: clonePhase(phase),
    reason,
    frame: world.frameCount,
    worldElapsedMs: world.elapsedMs,
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    heroState: state.heroState,
  });
}

function transitionFloor5Phase(
  world: GameWorld,
  state: Floor5SiegeState,
  phase: Floor5SiegePhase,
  reason: string,
): void {
  if (state.phase.kind === phase.kind) {
    return;
  }
  recordFloor5PhaseTransition(world, state, phase, reason);
}

function isFloor5Terminal(state: Floor5SiegeState): boolean {
  return state.phase.kind === 'CAPTURED' || state.phase.kind === 'DEFEAT';
}

export function _completeFloor5FieldTask(world: GameWorld, taskId: Floor5FieldTaskId): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }

  switch (taskId) {
    case 'openingPush':
      if (state.tasks.openingPushRepelled) return true;
      state.tasks.openingPushRepelled = true;
      latchFloor5RequisitionMilestone(state, 'opening-push');
      transitionFloor5Phase(world, state, { kind: 'CONTEST' }, 'opening-push-repelled');
      return true;
    case 'siegeYard':
      state.tasks.yardSecured = true;
      latchFloor5RequisitionMilestone(state, 'siege-yard');
      return true;
    case 'checkpoint':
      state.tasks.checkpointCleared = true;
      latchFloor5RequisitionMilestone(state, 'checkpoint');
      return true;
    default: {
      const exhaustive: never = taskId;
      return exhaustive;
    }
  }
}

export function _recoverFloor5RamComponent(
  world: GameWorld,
  componentClass: Floor5RamComponentClass,
): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }
  if (!FLOOR5_RAM_COMPONENT_CLASSES.includes(componentClass)) {
    return false;
  }
  if (!state.tasks.recoveredComponents.includes(componentClass)) {
    state.tasks.recoveredComponents.push(componentClass);
  }
  if (hasAllFloor5RamComponents(state)) {
    latchFloor5RequisitionMilestone(state, 'components');
  }
  return true;
}

export function _setFloor5BuildSiteUnderAttack(world: GameWorld, underAttack: boolean): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }
  state.construction.buildSiteUnderAttack = underAttack;
  return true;
}

export function _requestFloor5RamConstruction(world: GameWorld): boolean {
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return false;
  }

  state.construction.attempts += 1;
  if (!hasFloor5RamPrerequisites(state)) {
    state.construction.deniedAttempts += 1;
    return false;
  }

  if (state.engineState === 'LOCKED' || state.engineState === 'DESTROYED') {
    state.engineState = 'BUILDING';
    state.construction.progressMs = 0;
    state.construction.lastProgressWorldElapsedMs = world.elapsedMs;
    state.construction.startedFrame = world.frameCount;
    state.construction.completedFrame = null;
    transitionFloor5Phase(world, state, { kind: 'BUILD' }, 'ram-construction-authorized');
  }
  return true;
}

function advanceFloor5FieldTasks(world: GameWorld, state: Floor5SiegeState): void {
  if (world.elapsedMs < 1_000 || hasFloor5RamPrerequisites(state)) {
    return;
  }

  _completeFloor5FieldTask(world, 'openingPush');
  _completeFloor5FieldTask(world, 'siegeYard');
  for (const componentClass of FLOOR5_RAM_COMPONENT_CLASSES) {
    _recoverFloor5RamComponent(world, componentClass);
  }
  _completeFloor5FieldTask(world, 'checkpoint');
  _requestFloor5RamConstruction(world);
}

function projectFloor5GoalFlags(world: GameWorld, state: Floor5SiegeState): void {
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.openingPushRepelled, state.tasks.openingPushRepelled);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.yardSecured, state.tasks.yardSecured);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.componentsReady, hasAllFloor5RamComponents(state));
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.checkpointCleared, state.tasks.checkpointCleared);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.ramBuilt, state.engineState === 'READY');
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.wallBreached, state.breachState === 'BREACHED');
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.courtyardCleared, false);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.regentDefeated, false);
  setGoalFlag(world, FLOOR5_SIEGE_GOAL_IDS.castleCaptured, state.phase.kind === 'CAPTURED');
}

function advanceFloor5RamConstruction(world: GameWorld, state: Floor5SiegeState): void {
  const elapsedDeltaMs = Math.max(
    0,
    world.elapsedMs - state.construction.lastProgressWorldElapsedMs,
  );
  state.construction.lastProgressWorldElapsedMs = world.elapsedMs;
  if (state.engineState !== 'BUILDING' || elapsedDeltaMs === 0) {
    return;
  }

  if (state.construction.buildSiteUnderAttack) {
    state.construction.pausedMs += elapsedDeltaMs;
    return;
  }

  state.construction.progressMs = Math.min(
    state.construction.requiredMs,
    state.construction.progressMs + elapsedDeltaMs,
  );
  if (state.construction.progressMs >= state.construction.requiredMs) {
    state.engineState = 'READY';
    state.construction.completedFrame ??= world.frameCount;
  }
}

export function getFloor5SiegeRunStats(world: GameWorld): Floor5SiegeRunStats | undefined {
  const state = floor5SiegeState(world);
  if (!state) return undefined;
  return {
    phase: clonePhase(state.phase),
    commandPostHealth: state.commandPostHealth,
    engineState: state.engineState,
    breachState: state.breachState,
    heroState: state.heroState,
    tasks: {
      openingPushRepelled: state.tasks.openingPushRepelled,
      yardSecured: state.tasks.yardSecured,
      recoveredComponents: [...state.tasks.recoveredComponents],
      componentsReady: hasAllFloor5RamComponents(state),
      checkpointCleared: state.tasks.checkpointCleared,
      allPrerequisitesMet: hasFloor5RamPrerequisites(state),
    },
    requisition: {
      milestones: [...state.requisitionMilestones],
      completedMilestones: state.requisitionMilestones.length,
      requiredMilestones: FLOOR5_REQUISITION_MILESTONES.length,
      ready: FLOOR5_REQUISITION_MILESTONES.every((milestone) =>
        state.requisitionMilestones.includes(milestone),
      ),
    },
    construction: {
      progressMs: state.construction.progressMs,
      requiredMs: state.construction.requiredMs,
      buildSiteUnderAttack: state.construction.buildSiteUnderAttack,
      pausedMs: state.construction.pausedMs,
      attempts: state.construction.attempts,
      deniedAttempts: state.construction.deniedAttempts,
      startedFrame: state.construction.startedFrame,
      completedFrame: state.construction.completedFrame,
    },
    rngStreamKeys: { ...state.rngStreamKeys },
    trace: state.trace.map(cloneTraceEntry),
  };
}

export function siegeDirectorSystem(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state || isFloor5Terminal(state)) {
    return;
  }
  state.lastWorldElapsedMs = world.elapsedMs;
  _setFloor5BuildSiteUnderAttack(
    world,
    state.commandPostHealth < getFloor5Config().commandPost.health,
  );
  if (state.commandPostHealth <= 0) {
    recordFloor5PhaseTransition(world, state, { kind: 'DEFEAT' }, 'command-post-destroyed');
  }
}

export function confirmFloor5StairDescend(): boolean {
  return false;
}

export function getFloor5RunOutcome(world: GameWorld) {
  const phase = floor5SiegeState(world)?.phase.kind;
  return phase === 'CAPTURED' ? 'cleared_floor' : phase === 'DEFEAT' ? 'failed_timeout' : null;
}

function floor5ObjectiveTick(world: GameWorld): void {
  if (world.floorId !== 'floor5' || world.state !== 'playing') {
    return;
  }
  const state = floor5SiegeState(world);
  if (!state) {
    return;
  }
  if (isFloor5Terminal(state)) {
    projectFloor5GoalFlags(world, state);
    return;
  }
  advanceFloor5FieldTasks(world, state);
  advanceFloor5RamConstruction(world, state);
  projectFloor5GoalFlags(world, state);
}

function equipFloor5StarterWeapon(
  world: GameWorld,
  playerEid: number,
  starterWeaponPool: readonly string[],
): void {
  if (starterWeaponPool.length === 0) return;
  const weaponRng = new SeededRandomClass(hashStringToSeed(`${world.seed}:floor5:starter-weapon`));
  const pickedId = starterWeaponPool[weaponRng.nextInt(0, starterWeaponPool.length - 1)];
  const weaponDef =
    (pickedId ? getWeaponDef(pickedId) : undefined) ??
    (starterWeaponPool[0] ? getWeaponDef(starterWeaponPool[0]) : undefined);
  if (!weaponDef) return;
  equipStarterOrFallback(world, weaponDef.id, weaponDef);
  initializePlayerWeaponSkills(world, playerEid);
}

export function initializeFloor5Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const manifest = getFloor5Manifest();
  const mapConfig = buildFloor5MapConfig();
  const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(mapConfig));
  if (mapConfig.widthTiles < layout.widthTiles || mapConfig.heightTiles < layout.heightTiles) {
    throw new Error(
      `Floor 5 map config is smaller than authored battlefield: got ${mapConfig.widthTiles}×${mapConfig.heightTiles}, needs at least ${layout.widthTiles}×${layout.heightTiles}`,
    );
  }
  const floorMap = getGenerator(mapConfig.biome).generate(
    mapConfig,
    new SeededRandomClass(hashStringToSeed(`${world.seed}:floor5:battlefield`)),
  );
  world.floorMap = floorMap;
  attachBarriersToFloorMap(world);
  world.floor = 5;
  world.floorId = 'floor5';
  world.floorScenario = null;
  world.floorExtendedState = { floor5Siege: createFloor5SiegeState(world) };
  world.hideFloorTimer = true;

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  removeStatModifiers(world, 'floor', FLOOR5_PLAYER_STAT_SOURCE_ID);
  if (manifest.player.moveSpeedBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR5_PLAYER_STAT_SOURCE_ID,
      stat: 'moveSpeed',
      op: 'add',
      value: manifest.player.moveSpeedBonus,
    });
  }
  if (manifest.player.pickupRangeBonus > 0) {
    addStatModifier(world, {
      sourceType: 'floor',
      sourceId: FLOOR5_PLAYER_STAT_SOURCE_ID,
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
    equipFloor5StarterWeapon(world, playerEid, manifest.starterWeapons);
  }

  for (const questId of FLOOR5_SLICE3_QUEST_IDS) {
    acceptQuest(world, questId);
  }
  setTrackedQuest(world, FLOOR5_SLICE3_QUEST_IDS[0]);

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  world.state = 'playing';
  world.floorObjectiveTick = floor5ObjectiveTick;
}
