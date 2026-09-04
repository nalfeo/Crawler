import {
  addComponent,
  entityExists,
  hasComponent,
  query,
  removeEntity,
  set,
  setComponent,
} from 'bitecs';
import { attachBarriersToFloorMap } from '../core/barriers/index.js';
import {
  BroadcastRelayRaider,
  BroadcastScore,
  BuildCurrencyPickup,
  Damage,
  Enemy,
  Floor6Tower,
  Health,
  Player,
  Position,
  Size,
  Sprite,
  Team,
  Velocity,
  Weight,
  type GameWorld,
} from '../core/index.js';
import {
  applyDamage,
  clearEntityStores,
  createEntity,
  spawnBuildCurrencyPickup,
} from '../core/helpers.js';
import {
  broadcastRelaySetOptionsFromConfig,
  computeBroadcastRelaySetLayout,
} from '../core/map/generators/BroadcastRelaySetGenerator.js';
import { getGenerator } from '../core/map/generators/registry.js';
import { PHYSICS_BODIES, SHAPE_CIRCLE } from '../core/physics-defs.js';
import { floor6Manifest } from '../shared/floor-manifest.js';
import type {
  Floor6DefenseRunStats,
  Floor6DefenseState,
  Floor6FinaleAddManifestEntry,
  Floor6FinaleBossManifestEntry,
  Floor6HudCue,
  Floor6PresentationSnapshot,
  Floor6QuestProjectionSnapshot,
  Floor6TowerBuildResult,
  Floor6TowerDef,
  Floor6TowerSellResult,
  Floor6UpgradeOfferManifestEntry,
  Floor6UpgradeSelectionResult,
  Floor6WaveManifestEntry,
} from '../shared/floor-types.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import type { ScenarioRunOutcome } from '../shared/scenario-presentation.js';
import { GAME, TeamId } from '../shared/constants.js';
import { getFloorEnemyPack } from '../shared/enemy-packs.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';
import { acceptQuest } from '../core/systems/questSystem.js';
import { evaluateAchievementUnlocksForPhase } from './systems/achievementSystem.js';
import { FLOOR6_DEFENSE_QUEST_ID } from '../shared/quest-types.js';

function getFloor6Config(): NonNullable<typeof floor6Manifest.floor6> {
  const config = floor6Manifest.floor6;
  if (!config) {
    throw new Error('Floor 6 manifest is missing floor6 configuration');
  }
  return config;
}

function createFloor6EconomyState(): Floor6DefenseState['economy'] {
  return {
    balance: 0,
    totalEarned: 0,
    totalSpent: 0,
    earnedFromPickups: 0,
    earnedFromWaves: 0,
    pickupsSpawned: 0,
    pickupsCollected: 0,
    rewardedWaveIndexes: [],
    unlockedOfferIds: [],
    selectedOfferIds: [],
    selectionTrace: [],
    terminalResetCount: 0,
  };
}

function createFloor6FinaleState(): Floor6DefenseState['finale'] {
  return {
    bossManifest: null,
    addManifest: [],
    bossEid: 0,
    bossDefeated: false,
    startedFrame: null,
    bossDefeatedFrame: null,
    timeoutFrames: getFloor6Config().finale?.bossTimeoutFrames ?? 1800,
  };
}

export function _buildFloor6MapConfig(): MapConfig {
  const manifest = floor6Manifest;
  const config = getFloor6Config();
  return {
    widthTiles: manifest.map.widthTiles,
    heightTiles: manifest.map.heightTiles,
    tileSizeFt: manifest.map.tileSizeFt,
    biome: manifest.map.biome ?? BiomeType.BROADCAST_RELAY_SET,
    seed: manifest.map.seed,
    roomWidthRange: manifest.map.roomWidthRange,
    roomHeightRange: manifest.map.roomHeightRange,
    maxRooms: manifest.map.maxRooms,
    floorDensity: manifest.map.floorDensity,
    broadcastRelaySet: {
      routeWidthTiles: config.geometry.routeWidthTiles,
      buildSiteSizeTiles: config.geometry.buildSiteSizeTiles,
      borderThicknessTiles: config.geometry.borderThicknessTiles,
      supportedFootprints: config.supportedFootprints,
    },
  };
}

function createFloor6DefenseState(world: GameWorld, mapConfig: MapConfig): Floor6DefenseState {
  const config = getFloor6Config();
  const rngStreamKeys = Object.freeze(
    Object.fromEntries(
      config.rngStreams.map((label) => [label, `${world.seed}:floor6:${label}`] as const),
    ),
  ) as Floor6DefenseState['rngStreamKeys'];
  const tuning = config.tuning;
  return {
    phase: { kind: config.phase.initial },
    phaseTrace: [],
    rngStreamKeys,
    geometry: computeBroadcastRelaySetLayout(broadcastRelaySetOptionsFromConfig(mapConfig)),
    waveManifest: null,
    upgradeOfferManifest: null,
    liveEnemies: [],
    stalledRaiderCount: 0,
    routeStallCounts: {},
    routeReleaseCounts: {},
    nextReleaseIndex: 0,
    spawnDebt: 0,
    relayHp: tuning?.relayMaxHp ?? 100,
    stallFrames: 0,
    totalReleased: 0,
    lastReleaseFrame: 0,
    economy: createFloor6EconomyState(),
    towerInstances: [],
    towersTornDown: 0,
    combatEventCursor: 0,
    heroDamageDealt: 0,
    towerDamageDealt: 0,
    currentActIndex: 0,
    breakStartedFrame: null,
    breaksEntered: 0,
    breaksExited: 0,
    hostileActivityDuringBreak: 0,
    finale: createFloor6FinaleState(),
    terminalOutcome: null,
    terminalOutcomeCount: 0,
    victoryPayout: {
      awarded: false,
      count: 0,
      gold: 0,
      broadcastScore: 0,
    },
    exit: {
      opened: false,
      openCount: 0,
      confirmed: false,
    },
  };
}

function equipFloor6StarterWeapon(world: GameWorld, playerEid: number): void {
  const starterId = floor6Manifest.starterWeapons[0];
  const starter = starterId ? getWeaponDef(starterId) : undefined;
  if (!starterId || !starter) return;
  equipStarterOrFallback(world, starterId, starter);
  initializePlayerWeaponSkills(world, playerEid);
}

export function initializeFloor6Scenario(
  world: GameWorld,
  playerEid: number,
  options?: { readonly playerCarryover?: PlayerCarryoverSnapshot },
): void {
  const mapConfig = _buildFloor6MapConfig();
  const defenseState = createFloor6DefenseState(world, mapConfig);
  const floorMap = getGenerator(mapConfig.biome).generate(
    mapConfig,
    new SeededRandom(hashStringToSeed(defenseState.rngStreamKeys.dressing)),
  );

  world.floorMap = floorMap;
  world.setPieceProps.length = 0;
  attachBarriersToFloorMap(world);
  world.floor = 6;
  world.floorId = 'floor6';
  world.floorScenario = null;
  world.floorExtendedState = { floor6Defense: defenseState };
  world.hideFloorTimer = true;
  world.floorObjectiveTick = null;

  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  if (hasComponent(world.ecs, playerEid, Position)) {
    setComponent(world.ecs, playerEid, Position, { x: spawn.x, y: spawn.y });
  }
  if (!hasComponent(world.ecs, playerEid, BroadcastScore)) {
    addComponent(world.ecs, playerEid, set(BroadcastScore, { current: 0 }));
  }

  if (options?.playerCarryover) {
    restorePlayerCarryover(world, playerEid, options.playerCarryover);
    initializePlayerWeaponSkills(world, playerEid);
  } else {
    equipFloor6StarterWeapon(world, playerEid);
  }

  world.featureUnlocks.inventory = true;
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.spells = true;
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  resetFloor6QuestProjection(world);
  acceptQuest(world, FLOOR6_DEFENSE_QUEST_ID);
  world.state = 'playing';
}

// ── Slice 3: Wave director, route-following raider AI ──────────────────────

const FLOOR6_ENEMY_PACK_ID = 'floor6-renovation-crew';
const FLOOR6_SELECTION_TRACE_LIMIT = 64;
const FLOOR6_MAX_FIRE_RATE_BONUS = 0.9;
const FLOOR6_DEFENSE_GOAL_IDS = Object.freeze([
  'floor6.defense.briefed',
  'floor6.defense.firstWaveCleared',
  'floor6.defense.firstBuildPlaced',
  'floor6.defense.firstUpgradeChosen',
  'floor6.defense.breakCleared',
  'floor6.defense.deadlineDefeated',
  'floor6.defense.relaySecured',
] as const);

/** Retrieve the floor6 defense state guard; returns null when not on floor 6. */
function floor6DefenseState(world: GameWorld): Floor6DefenseState | null {
  return world.floorExtendedState?.floor6Defense ?? null;
}

function resetFloor6QuestProjection(world: GameWorld): void {
  for (const goalId of FLOOR6_DEFENSE_GOAL_IDS) {
    world.goalFlags.delete(goalId);
  }
  world.goalFlags.delete('floor6.defense.questComplete');
  world.questLog.delete(FLOOR6_DEFENSE_QUEST_ID);
}

/** Record a phase transition and push to the trace. */
function recordFloor6PhaseTransition(
  world: GameWorld,
  state: Floor6DefenseState,
  newPhase: Floor6DefenseState['phase'],
  reason: string,
): void {
  state.phaseTrace.push({
    kind: state.phase.kind,
    toKind: newPhase.kind,
    reason,
    frame: world.frameCount,
    worldElapsedMs: world.elapsedMs,
    relayHp: state.relayHp,
    manifestIndex: state.nextReleaseIndex,
    activeSites: state.towerInstances.map((instance) => instance.siteId),
    buildCurrencyBalance: state.economy.balance,
    selectedOfferIds: [...state.economy.selectedOfferIds],
    terminalOutcome: state.terminalOutcome,
  });
  state.phase = newPhase;
  updateFloor6QuestGoalFlags(world, state);
}

function setProjectedFloor6Goal(world: GameWorld, goalId: string, reached: boolean): void {
  if (reached || world.goalFlags.get(goalId) === true) {
    world.goalFlags.set(goalId, true);
  }
}

function getFloor6QuestProjection(state: Floor6DefenseState): Floor6QuestProjectionSnapshot {
  const firstWaveIndex = getFloor6Config().waves?.[0]?.waveIndex;
  return {
    'floor6.defense.briefed': state.phaseTrace.some((entry) => entry.reason === 'setup-complete'),
    'floor6.defense.firstWaveCleared':
      firstWaveIndex !== undefined && state.economy.rewardedWaveIndexes.includes(firstWaveIndex),
    'floor6.defense.firstBuildPlaced': state.towerInstances.length > 0 || state.towersTornDown > 0,
    'floor6.defense.firstUpgradeChosen': state.economy.selectedOfferIds.length > 0,
    'floor6.defense.breakCleared': state.breaksExited > 0,
    'floor6.defense.deadlineDefeated': state.finale.bossDefeated,
    'floor6.defense.relaySecured':
      state.terminalOutcome === 'victory' && state.exit.opened === true,
  };
}

function updateFloor6QuestGoalFlags(world: GameWorld, state: Floor6DefenseState): void {
  const projection = getFloor6QuestProjection(state);
  for (const goalId of FLOOR6_DEFENSE_GOAL_IDS) {
    setProjectedFloor6Goal(world, goalId, projection[goalId]);
  }
}

/**
 * Build the immutable wave manifest from the authored `waves` schedule.
 * Uses only the `waves` and `routes` purpose streams (FR3.2).
 * Route assignment is stable-ordered by manifest index — no RNG needed here
 * because the authored schedule already specifies routeIndex (FR3.4).
 */
function buildFloor6WaveManifest(
  state: Floor6DefenseState,
  config: NonNullable<typeof floor6Manifest.floor6>,
): readonly Floor6WaveManifestEntry[] {
  const waves = config.waves ?? [];
  const routes = state.geometry.routes;

  const entries: Floor6WaveManifestEntry[] = [];
  let manifestIndex = 0;
  for (const wave of waves) {
    for (const entry of wave.entries) {
      const routeIndex = entry.routeIndex % Math.max(routes.length, 1);
      const route = routes[routeIndex];
      if (!route) continue;
      const archetypeId = entry.archetypeId;
      entries.push({
        kind: 'wave',
        manifestIndex,
        waveIndex: wave.waveIndex,
        waveLabel: wave.label,
        routeId: route.id,
        entranceId: route.entranceId,
        archetypeId,
        releaseTick: entry.releaseTick,
        buildCurrencyReward:
          config.economy?.enemyRewards.find((reward) => reward.archetypeId === archetypeId)
            ?.buildCurrency ?? 0,
      });
      manifestIndex += 1;
    }
  }
  return Object.freeze(entries);
}

function getFloor6ActWaveIndex(actIndex: number): number | null {
  const wave = getFloor6Config().waves?.[actIndex];
  return wave?.waveIndex ?? null;
}

function isFloor6EntryReleasableInCurrentPhase(
  state: Floor6DefenseState,
  entry: Floor6WaveManifestEntry,
): boolean {
  if (state.phase.kind === 'FINALE') {
    return entry.kind === 'finale-boss' || entry.kind === 'finale-add';
  }
  const currentWaveIndex = getFloor6ActWaveIndex(state.currentActIndex);
  return entry.kind === 'wave' && entry.waveIndex === currentWaveIndex;
}

function buildFloor6FinaleManifestEntries(
  state: Floor6DefenseState,
  config: NonNullable<typeof floor6Manifest.floor6>,
  startFrame: number,
): {
  readonly boss: Floor6FinaleBossManifestEntry | null;
  readonly adds: readonly Floor6FinaleAddManifestEntry[];
  readonly waveEntries: readonly Floor6WaveManifestEntry[];
} {
  const finale = config.finale;
  if (!finale) return { boss: null, adds: [], waveEntries: [] };
  const routes = state.geometry.routes;
  const finaleWaveIndex =
    (config.waves ?? []).reduce(
      (maxWaveIndex, wave) => Math.max(maxWaveIndex, wave.waveIndex),
      -1,
    ) + 1;
  const baseManifestIndex = state.waveManifest?.length ?? 0;
  const bossRoute = routes[finale.boss.routeIndex % Math.max(routes.length, 1)];
  if (!bossRoute) return { boss: null, adds: [], waveEntries: [] };
  const boss: Floor6FinaleBossManifestEntry = {
    bossId: finale.boss.id,
    displayName: finale.boss.displayName,
    manifestIndex: baseManifestIndex,
    waveIndex: finaleWaveIndex,
    waveLabel: 'deadline',
    routeId: bossRoute.id,
    entranceId: bossRoute.entranceId,
    archetypeId: finale.boss.archetypeId,
    releaseTick: startFrame + finale.boss.releaseTick,
    hp: finale.boss.hp,
    buildCurrencyReward: finale.boss.buildCurrencyReward,
  };
  const adds = finale.adds.map((add, index): Floor6FinaleAddManifestEntry => {
    const route = routes[add.routeIndex % Math.max(routes.length, 1)] ?? bossRoute;
    return {
      addId: add.id,
      manifestIndex: baseManifestIndex + index + 1,
      waveIndex: finaleWaveIndex,
      waveLabel: 'deadline-adds',
      routeId: route.id,
      entranceId: route.entranceId,
      archetypeId: add.archetypeId,
      releaseTick: startFrame + add.releaseTick,
      buildCurrencyReward: add.buildCurrencyReward,
    };
  });
  const waveEntries: Floor6WaveManifestEntry[] = [
    { ...boss, kind: 'finale-boss' },
    ...adds.map((add) => ({ ...add, kind: 'finale-add' as const, addId: add.addId })),
  ];
  return { boss, adds: Object.freeze(adds), waveEntries: Object.freeze(waveEntries) };
}

function buildFloor6UpgradeOfferManifest(
  state: Floor6DefenseState,
  config: NonNullable<typeof floor6Manifest.floor6>,
): readonly Floor6UpgradeOfferManifestEntry[] {
  const offers = config.upgrades?.offers ?? [];
  const offerCount = Math.min(config.upgrades?.offerCount ?? 0, offers.length);
  const rng = new SeededRandom(hashStringToSeed(state.rngStreamKeys.upgrades));
  const pool = offers
    .map((offer, stableIndex) => ({ offer, stableIndex }))
    .sort((a, b) => a.offer.id.localeCompare(b.offer.id));
  const selected: Floor6UpgradeOfferManifestEntry[] = [];

  while (selected.length < offerCount && pool.length > 0) {
    const index = Math.floor(rng.next() * pool.length);
    const [entry] = pool.splice(index, 1);
    if (!entry) continue;
    selected.push({
      offerId: entry.offer.id,
      stableIndex: entry.stableIndex,
      cost: entry.offer.cost,
      effect: { ...entry.offer.effect },
    });
  }

  return Object.freeze(selected.sort((a, b) => a.stableIndex - b.stableIndex));
}

/**
 * Spawn one raider entity for the given manifest entry.
 * Returns the new entity id.
 */
function spawnFloor6Raider(
  world: GameWorld,
  state: Floor6DefenseState,
  entry: Floor6WaveManifestEntry,
): number {
  const config = getFloor6Config();
  const tuning = config.tuning;
  const pack = getFloorEnemyPack(FLOOR6_ENEMY_PACK_ID);
  const archetype = pack?.archetypes.find((a) => a.id === entry.archetypeId) ?? pack?.archetypes[0];
  if (!archetype) {
    throw new Error(`Floor 6: no archetype for entry ${entry.archetypeId}`);
  }

  const entrance = state.geometry.entrances.find((e) => e.id === entry.entranceId);
  const spawnTile = entrance?.spawn ?? state.geometry.entrances[0]?.spawn ?? { x: 0, y: 0 };
  const floorMap = world.floorMap;
  const tileSizeFt = floorMap?.config.tileSizeFt ?? 4;
  const spawnX = (spawnTile.x + 0.5) * tileSizeFt;
  const spawnY = (spawnTile.y + 0.5) * tileSizeFt;

  const eid = createEntity(world);
  // Use the world's standard entity creation

  addComponent(world.ecs, eid, set(Position, { x: spawnX, y: spawnY }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: archetype.hp, max: archetype.hp }));
  if (entry.kind === 'finale-boss') {
    const bossHp = state.finale.bossManifest?.hp ?? archetype.hp;
    setComponent(world.ecs, eid, Health, { current: bossHp, max: bossHp });
    state.finale.bossEid = eid;
  }
  addComponent(
    world.ecs,
    eid,
    set(Sprite, {
      textureId: archetype.spriteTexture,
      width: archetype.spriteWidth,
      height: archetype.spriteHeight,
    }),
  );
  addComponent(world.ecs, eid, set(Team, { id: TeamId.ENEMY }));
  const body = PHYSICS_BODIES['mob-baseline'];
  addComponent(
    world.ecs,
    eid,
    set(Size, { radius: body.radius, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: body.weight }));
  addComponent(
    world.ecs,
    eid,
    set(Damage, {
      amount: tuning?.raiderRelayDamage ?? 8,
      cooldownMs: tuning?.raiderAttackCooldownMs ?? 800,
      lastFireMs: -(tuning?.raiderAttackCooldownMs ?? 800),
    }),
  );
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(BroadcastRelayRaider, {
      manifestIndex: entry.manifestIndex,
      waypointIndex: 0,
      stillFrames: 0,
      lastRelayAttackMs: -(tuning?.raiderAttackCooldownMs ?? 800),
    }),
  );

  state.routeReleaseCounts[entry.routeId] = (state.routeReleaseCounts[entry.routeId] ?? 0) + 1;
  return eid;
}

/** Remove all live raider entities (break/terminal cleanup). */
function clearFloor6Raiders(world: GameWorld, state: Floor6DefenseState): void {
  for (const eid of query(world.ecs, [BroadcastRelayRaider])) {
    if (entityExists(world.ecs, eid)) {
      removeEntity(world.ecs, eid);
      clearEntityStores(world, eid);
    }
  }
  for (const record of state.liveEnemies) {
    if (record.eid > 0 && entityExists(world.ecs, record.eid)) {
      removeEntity(world.ecs, record.eid);
      clearEntityStores(world, record.eid);
    }
    record.eid = -1;
  }
  state.spawnDebt = 0;
}

function clearFloor6EconomyForTerminal(world: GameWorld, state: Floor6DefenseState): void {
  for (const eid of query(world.ecs, [BuildCurrencyPickup])) {
    if (entityExists(world.ecs, eid)) {
      removeEntity(world.ecs, eid);
      clearEntityStores(world, eid);
    }
  }
  const resetCount = state.economy.terminalResetCount + 1;
  state.economy = createFloor6EconomyState();
  state.economy.terminalResetCount = resetCount;
  state.upgradeOfferManifest = [];
}

function clearFloor6TerminalState(world: GameWorld, state: Floor6DefenseState): void {
  recordFloor6CombatContributions(world, state);
  clearFloor6Raiders(world, state);
  teardownFloor6Towers(world);
  clearFloor6EconomyForTerminal(world, state);
}

function clearFloor6BreakState(world: GameWorld, state: Floor6DefenseState): void {
  const liveRaiders = countLiveFloor6Raiders(world);
  state.hostileActivityDuringBreak += liveRaiders;
  clearFloor6Raiders(world, state);
}

function setFloor6Defeat(
  world: GameWorld,
  state: Floor6DefenseState,
  reason = 'terminal-defeat',
): void {
  if (state.terminalOutcome !== null) return;
  clearFloor6TerminalState(world, state);
  state.terminalOutcome = 'defeat';
  state.terminalOutcomeCount += 1;
  recordFloor6PhaseTransition(world, state, { kind: 'DEFEAT' }, reason);
}

function awardFloor6VictoryPayout(world: GameWorld, state: Floor6DefenseState): void {
  if (state.victoryPayout.awarded) return;
  const finale = getFloor6Config().finale;
  const gold = finale?.victoryPayoutGold ?? 0;
  const broadcastScore = finale?.victoryBroadcastScore ?? 0;
  world.playerGold += gold;
  for (const player of query(world.ecs, [Player])) {
    if (hasComponent(world.ecs, player, BroadcastScore)) {
      world.stores.broadcastScore.current[player] =
        (world.stores.broadcastScore.current[player] ?? 0) + broadcastScore;
    }
  }
  state.victoryPayout.awarded = true;
  state.victoryPayout.count += 1;
  state.victoryPayout.gold = gold;
  state.victoryPayout.broadcastScore = broadcastScore;
}

function openFloor6Exit(state: Floor6DefenseState): void {
  if (state.exit.opened) return;
  state.exit.opened = true;
  state.exit.openCount += 1;
}

function setFloor6Victory(world: GameWorld, state: Floor6DefenseState): void {
  if (state.terminalOutcome !== null) return;
  awardFloor6VictoryPayout(world, state);
  openFloor6Exit(state);
  clearFloor6TerminalState(world, state);
  state.terminalOutcome = 'victory';
  state.terminalOutcomeCount += 1;
  recordFloor6PhaseTransition(world, state, { kind: 'VICTORY' }, 'deadline-defeated');
}

function isFloor6PlayerDefeated(world: GameWorld): boolean {
  for (const eid of query(world.ecs, [Player, Health])) {
    if ((world.stores.health.current[eid] ?? 1) <= 0) {
      return true;
    }
  }
  return false;
}

function reconcileFloor6TerminalAfterCore(world: GameWorld, state: Floor6DefenseState): void {
  if (
    state.terminalOutcome !== null ||
    state.phase.kind === 'VICTORY' ||
    state.phase.kind === 'DEFEAT'
  ) {
    return;
  }
  if (isFloor6PlayerDefeated(world)) {
    setFloor6Defeat(world, state, 'player-defeated');
    return;
  }
  if (state.relayHp <= 0) {
    setFloor6Defeat(world, state, 'relay-destroyed');
    return;
  }
  reconcileFloor6LiveEnemies(world, state);
  if (
    state.phase.kind === 'FINALE' &&
    state.finale.startedFrame !== null &&
    world.frameCount - state.finale.startedFrame >= state.finale.timeoutFrames &&
    !state.finale.bossDefeated
  ) {
    setFloor6Defeat(world, state, 'deadline-timeout');
    return;
  }
  if (state.phase.kind === 'FINALE' && state.finale.bossDefeated) {
    setFloor6Victory(world, state);
  }
}

function selectedFloor6UpgradeValue(state: Floor6DefenseState, kind: string): number {
  return (state.upgradeOfferManifest ?? [])
    .filter(
      (offer) =>
        state.economy.selectedOfferIds.includes(offer.offerId) && offer.effect.kind === kind,
    )
    .reduce((total, offer) => total + offer.effect.value, 0);
}

/**
 * Count of selected upgrade offers whose effect actually modifies towers
 * (`towerFireRateBonus`/`towerDamageBonus`). The Floor 6 manifest also has
 * relay-only (`relayMaxHpBonus`, `relayRepair`) and raider-only
 * (`raiderSlowBonus`) offers that must NOT inflate a per-tower tier label —
 * those effects are global run-wide modifiers, not a tower upgrade.
 */
const FLOOR6_TOWER_AFFECTING_EFFECT_KINDS: ReadonlySet<string> = new Set([
  'towerFireRateBonus',
  'towerDamageBonus',
]);

function selectedFloor6TowerModifierCount(state: Floor6DefenseState): number {
  return (state.upgradeOfferManifest ?? []).filter(
    (offer) =>
      state.economy.selectedOfferIds.includes(offer.offerId) &&
      FLOOR6_TOWER_AFFECTING_EFFECT_KINDS.has(offer.effect.kind),
  ).length;
}

function floor6RelayMaxHp(state: Floor6DefenseState): number {
  return (
    (getFloor6Config().tuning?.relayMaxHp ?? 100) +
    selectedFloor6UpgradeValue(state, 'relayMaxHpBonus')
  );
}

/**
 * Pure read of the current quest-goal projection. Goal flags are latched by
 * the sim-side mutations that actually change state (tower builds, upgrade
 * purchases, phase transitions — see the `updateFloor6QuestGoalFlags` calls
 * beside each), so a presentation read must never recompute or write them:
 * doing so from a per-frame HUD read would silently advance quest state
 * outside the sim-side systems that own it.
 */
function floor6QuestGoalFlagSnapshot(world: GameWorld): Floor6QuestProjectionSnapshot {
  return {
    'floor6.defense.briefed': world.goalFlags.get('floor6.defense.briefed') === true,
    'floor6.defense.firstWaveCleared':
      world.goalFlags.get('floor6.defense.firstWaveCleared') === true,
    'floor6.defense.firstBuildPlaced':
      world.goalFlags.get('floor6.defense.firstBuildPlaced') === true,
    'floor6.defense.firstUpgradeChosen':
      world.goalFlags.get('floor6.defense.firstUpgradeChosen') === true,
    'floor6.defense.breakCleared': world.goalFlags.get('floor6.defense.breakCleared') === true,
    'floor6.defense.deadlineDefeated':
      world.goalFlags.get('floor6.defense.deadlineDefeated') === true,
    'floor6.defense.relaySecured': world.goalFlags.get('floor6.defense.relaySecured') === true,
  };
}

function directionLabel(from: Floor6WaveManifestEntry, state: Floor6DefenseState): string {
  const route = state.geometry.routes.find((candidate) => candidate.id === from.routeId);
  const routeName = route?.id ?? from.routeId;
  if (routeName.startsWith('west-')) {
    return 'incoming from west route → Relay';
  }
  if (routeName.startsWith('east-')) {
    return 'incoming from east route ← Relay';
  }
  if (routeName.startsWith('north-')) {
    return 'incoming from north route ↓ Relay';
  }
  if (routeName.startsWith('south-')) {
    return 'incoming from south route ↑ Relay';
  }
  return `incoming from ${route?.entranceId ?? from.entranceId} route to Relay`;
}

function buildFloor6PresentationSnapshot(
  world: GameWorld,
  state: Floor6DefenseState,
  relayMaxHp: number,
): Floor6PresentationSnapshot {
  const manifest = state.waveManifest ?? [];
  const towerRoster = new Map(_getFloor6TowerRoster().map((tower) => [tower.id, tower]));
  const nextByRoute = new Map<string, Floor6WaveManifestEntry>();
  for (const entry of manifest.slice(state.nextReleaseIndex)) {
    if (!isFloor6EntryReleasableInCurrentPhase(state, entry) || nextByRoute.has(entry.routeId)) {
      continue;
    }
    nextByRoute.set(entry.routeId, entry);
  }
  const selectedTowerModifierCount = selectedFloor6TowerModifierCount(state);
  const towerTierLabel =
    selectedTowerModifierCount > 0
      ? `+${selectedTowerModifierCount} global tower modifier${selectedTowerModifierCount === 1 ? '' : 's'}`
      : 'base tier';
  const relayPct = relayMaxHp > 0 ? state.relayHp / relayMaxHp : 0;
  const relayDangerLabel =
    relayPct <= 0.25
      ? `CRITICAL Relay danger: ${state.relayHp}/${relayMaxHp} HP`
      : relayPct <= 0.5
        ? `WARNING Relay under pressure: ${state.relayHp}/${relayMaxHp} HP`
        : `SAFE Relay holding: ${state.relayHp}/${relayMaxHp} HP`;
  const cues: Floor6HudCue[] = [
    {
      id: `floor6-phase-${state.phase.kind}`,
      kind: 'hud',
      label: `Phase cue: ${state.phase.kind}`,
    },
  ];
  if (state.phase.kind === 'BREAK') {
    cues.push({
      id: `floor6-break-safe-${state.currentActIndex}`,
      kind: 'audio',
      label: 'Service break cue: hostiles cleared; build, sell, and upgrade actions are safe',
    });
  }
  if (state.phase.kind === 'FINALE') {
    cues.push({
      id: 'floor6-deadline-finale',
      kind: 'vfx',
      label: 'Deadline cue: boss pressure active on authored routes',
    });
  }
  if (relayPct <= 0.5) {
    cues.push({
      id: 'floor6-relay-danger',
      kind: 'audio',
      label: relayDangerLabel,
    });
  }

  return {
    objectiveLabel: 'Protect the Broadcast Relay; clear the Deadline to open the exit.',
    phaseLabel: `${state.phase.kind} phase`,
    relayDangerLabel,
    questGoals: floor6QuestGoalFlagSnapshot(world),
    routes: state.geometry.routes.map((route) => {
      const next = nextByRoute.get(route.id);
      const sample = next ?? manifest.find((entry) => entry.routeId === route.id);
      return {
        routeId: route.id,
        entranceId: route.entranceId,
        directionLabel: sample
          ? directionLabel(sample, state)
          : 'route clear; no incoming wave queued',
        nextReleaseTick: next?.releaseTick ?? null,
      };
    }),
    buildSites: state.geometry.buildSites.map((site) => {
      const tower = state.towerInstances.find((instance) => instance.siteId === site.id);
      return {
        siteId: site.id,
        occupied: tower !== undefined,
        label: tower
          ? `OCCUPIED ${site.id}: ${tower.towerId}`
          : `VACANT ${site.id}: buildable maintenance plinth`,
        towerId: tower?.towerId ?? null,
      };
    }),
    towers: state.towerInstances.map((instance) => {
      const tower = towerRoster.get(instance.towerId);
      return {
        siteId: instance.siteId,
        towerId: instance.towerId,
        rangeFt: tower?.attackRangeFt ?? 0,
        tierLabel: towerTierLabel,
      };
    }),
    buildCurrencyLabel: `Requisitions ${state.economy.balance} available; ${state.economy.totalSpent} spent`,
    lootLabel: `Loot visible: ${state.economy.pickupsSpawned} requisition drops, ${state.economy.pickupsCollected} collected`,
    upgradeChoiceLabel:
      state.upgradeOfferManifest && state.upgradeOfferManifest.length > 0
        ? `${state.economy.selectedOfferIds.length}/${state.upgradeOfferManifest.length} upgrade offers chosen`
        : 'No upgrade offers active',
    breakSafetyLabel:
      state.phase.kind === 'BREAK'
        ? `Break safe: ${countLiveFloor6Raiders(world)} live hostiles, ${state.spawnDebt} spawn debt`
        : `Breaks cleared: ${state.breaksExited}; hostile break activity ${state.hostileActivityDuringBreak}`,
    deadlineLabel:
      state.phase.kind === 'FINALE'
        ? `Deadline active: ${state.finale.bossManifest?.displayName ?? 'Broadcast Deadline'} on ${state.finale.bossManifest?.routeId ?? 'route'}`
        : state.finale.bossDefeated
          ? 'Deadline defeated; Relay secured'
          : 'Deadline pending',
    cues,
  };
}

function getFloor6TowerDef(towerId: string): Floor6TowerDef | undefined {
  return getFloor6Config().towers?.find((tower) => tower.id === towerId);
}

type Floor6BreakAction = NonNullable<
  NonNullable<typeof floor6Manifest.floor6>['finale']
>['breakAllowedActions'][number];

function isFloor6TransactionAllowed(
  state: Floor6DefenseState,
  breakAction: Floor6BreakAction,
): boolean {
  return (
    state.phase.kind === 'DEFEND' ||
    (state.phase.kind === 'BREAK' &&
      (getFloor6Config().finale?.breakAllowedActions.includes(breakAction) ?? false))
  );
}

export function _getFloor6TowerRoster(): readonly Floor6TowerDef[] {
  return getFloor6Config().towers ?? [];
}

function sortFloor6TowerInstancesBySite(state: Floor6DefenseState): void {
  const siteOrder = new Map(state.geometry.buildSites.map((site, index) => [site.id, index]));
  state.towerInstances.sort(
    (a, b) =>
      (siteOrder.get(a.siteId) ?? Number.MAX_SAFE_INTEGER) -
      (siteOrder.get(b.siteId) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function buildFloor6Tower(
  world: GameWorld,
  siteId: string,
  towerId: string,
): Floor6TowerBuildResult {
  const state = floor6DefenseState(world);
  if (!state) return { ok: false, reason: 'not-floor6' };
  if (!isFloor6TransactionAllowed(state, 'tower-build')) {
    return { ok: false, reason: 'phase-locked' };
  }
  const site = state.geometry.buildSites.find((candidate) => candidate.id === siteId);
  if (!site) return { ok: false, reason: 'invalid-site' };
  if (state.towerInstances.some((instance) => instance.siteId === siteId)) {
    return { ok: false, reason: 'occupied' };
  }
  const tower = getFloor6TowerDef(towerId);
  if (!tower) return { ok: false, reason: 'unknown-tower' };
  const footprint = state.geometry.supportedFootprints.find(
    (candidate) => candidate.id === tower.footprintId,
  );
  if (
    !footprint ||
    footprint.widthTiles > site.bounds.width ||
    footprint.heightTiles > site.bounds.height
  ) {
    return { ok: false, reason: 'invalid-site' };
  }
  if (state.economy.balance < tower.cost) return { ok: false, reason: 'unaffordable' };

  const tileSizeFt = world.floorMap?.config.tileSizeFt ?? 4;
  const eid = createEntity(world);
  addComponent(
    world.ecs,
    eid,
    set(Position, {
      x: (site.bounds.x + site.bounds.width / 2) * tileSizeFt,
      y: (site.bounds.y + site.bounds.height / 2) * tileSizeFt,
    }),
  );
  addComponent(world.ecs, eid, set(Team, { id: TeamId.PLAYER }));
  addComponent(
    world.ecs,
    eid,
    set(Size, { radius: 0.5, halfWidth: 0, halfHeight: 0, shape: SHAPE_CIRCLE }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Floor6Tower, {
      towerIndex: _getFloor6TowerRoster().findIndex((candidate) => candidate.id === towerId),
      lastAttackMs: -tower.attackCooldownMs,
    }),
  );
  state.economy.balance -= tower.cost;
  state.economy.totalSpent += tower.cost;
  state.towerInstances.push({ siteId, towerId, eid });
  sortFloor6TowerInstancesBySite(state);
  updateFloor6QuestGoalFlags(world, state);
  return { ok: true, reason: 'built', eid };
}

export function _sellFloor6Tower(world: GameWorld, siteId: string): Floor6TowerSellResult {
  const state = floor6DefenseState(world);
  if (!state) return { ok: false, reason: 'not-floor6' };
  if (!isFloor6TransactionAllowed(state, 'tower-sell')) {
    return { ok: false, reason: 'phase-locked' };
  }
  const index = state.towerInstances.findIndex((instance) => instance.siteId === siteId);
  if (index < 0) return { ok: false, reason: 'vacant' };
  const [instance] = state.towerInstances.splice(index, 1);
  const tower = instance ? getFloor6TowerDef(instance.towerId) : undefined;
  if (instance && entityExists(world.ecs, instance.eid)) {
    removeEntity(world.ecs, instance.eid);
    clearEntityStores(world, instance.eid);
  }
  state.economy.balance += tower?.sellRefund ?? 0;
  state.towersTornDown += 1;
  return { ok: true, reason: 'sold' };
}

/** Idempotently removes every Floor 6 tower without changing the authored map. */
function teardownFloor6Towers(world: GameWorld): void {
  const state = floor6DefenseState(world);
  if (!state) return;
  for (const instance of state.towerInstances) {
    if (entityExists(world.ecs, instance.eid)) {
      removeEntity(world.ecs, instance.eid);
      clearEntityStores(world, instance.eid);
    }
    state.towersTornDown += 1;
  }
  state.towerInstances.length = 0;
}

function refreshFloor6UnlockedOffers(state: Floor6DefenseState): void {
  const offers = state.upgradeOfferManifest ?? [];
  const nextUnlockedOfferIds = offers
    .filter(
      (offer) =>
        offer.cost <= state.economy.balance &&
        !state.economy.selectedOfferIds.includes(offer.offerId),
    )
    .map((offer) => offer.offerId);
  if (
    nextUnlockedOfferIds.length === state.economy.unlockedOfferIds.length &&
    nextUnlockedOfferIds.every((id, index) => id === state.economy.unlockedOfferIds[index])
  ) {
    return;
  }
  state.economy.unlockedOfferIds = nextUnlockedOfferIds;
}

function recordFloor6CombatContributions(world: GameWorld, state: Floor6DefenseState): void {
  const combatEvents = world.combatEvents;
  if (
    state.combatEventCursor > combatEvents.length ||
    (state.combatEventCursor > 0 &&
      combatEvents[state.combatEventCursor - 1] !== state.lastCombatEvent)
  ) {
    state.combatEventCursor = 0;
  }
  const floor6RaiderEids = new Set<number>();
  for (const record of state.liveEnemies) {
    floor6RaiderEids.add(record.eid);
  }
  for (
    let eventIndex = state.combatEventCursor;
    eventIndex < combatEvents.length;
    eventIndex += 1
  ) {
    const event = combatEvents[eventIndex];
    if (
      event?.type !== 'hit' ||
      event.targetType !== 'enemy' ||
      event.targetEid === undefined ||
      (!hasComponent(world.ecs, event.targetEid, BroadcastRelayRaider) &&
        !floor6RaiderEids.has(event.targetEid))
    ) {
      continue;
    }
    if (event.sourceEid !== undefined && hasComponent(world.ecs, event.sourceEid, Floor6Tower)) {
      state.towerDamageDealt += event.amount;
    } else {
      state.heroDamageDealt += event.amount;
    }
  }
  state.combatEventCursor = combatEvents.length;
  state.lastCombatEvent = combatEvents.at(-1);
}

function creditFloor6WaveRewards(state: Floor6DefenseState): void {
  const config = getFloor6Config();
  const manifest = state.waveManifest;
  if (!manifest || !config.economy) return;

  for (const reward of config.economy.waveRewards) {
    if (state.economy.rewardedWaveIndexes.includes(reward.waveIndex)) continue;
    const waveEntries = manifest.filter((entry) => entry.waveIndex === reward.waveIndex);
    if (waveEntries.length === 0) continue;
    const waveResolved = waveEntries.every((entry) => {
      const record = state.liveEnemies[entry.manifestIndex];
      return record?.defeated === true;
    });
    if (!waveResolved) continue;

    state.economy.rewardedWaveIndexes.push(reward.waveIndex);
    state.economy.balance += reward.buildCurrency;
    state.economy.totalEarned += reward.buildCurrency;
    state.economy.earnedFromWaves += reward.buildCurrency;
  }
}

function spawnFloor6BuildCurrencyReward(
  world: GameWorld,
  state: Floor6DefenseState,
  entry: Floor6WaveManifestEntry,
  eid: number,
): void {
  if (entry.buildCurrencyReward <= 0) return;
  const x = world.stores.position.x[eid] ?? 0;
  const y = world.stores.position.y[eid] ?? 0;
  spawnBuildCurrencyPickup(world, x, y, entry.buildCurrencyReward);
  state.economy.pickupsSpawned += 1;
}

export function getFloor6UpgradeOffers(
  world: GameWorld,
): readonly Floor6UpgradeOfferManifestEntry[] {
  return world.floorExtendedState?.floor6Defense?.upgradeOfferManifest ?? [];
}

export function purchaseFloor6UpgradeOffer(
  world: GameWorld,
  offerId: string,
): Floor6UpgradeSelectionResult {
  const state = floor6DefenseState(world);
  if (!state) return { ok: false, reason: 'not-floor6' };
  const balanceBefore = state.economy.balance;
  const offer = state.upgradeOfferManifest?.find((candidate) => candidate.offerId === offerId);
  let reason: Floor6UpgradeSelectionResult['reason'] = 'purchased';
  let ok = false;

  if (!isFloor6TransactionAllowed(state, 'upgrade-purchase')) {
    reason = 'phase-locked';
  } else if (!offer) {
    reason = 'unknown-offer';
  } else if (state.economy.selectedOfferIds.includes(offerId)) {
    reason = 'duplicate';
  } else if (balanceBefore < offer.cost) {
    reason = 'unaffordable';
  } else {
    ok = true;
    state.economy.balance = balanceBefore - offer.cost;
    state.economy.totalSpent += offer.cost;
    state.economy.selectedOfferIds.push(offerId);
    if (offer.effect.kind === 'relayRepair') {
      state.relayHp = Math.min(floor6RelayMaxHp(state), state.relayHp + offer.effect.value);
    }
    updateFloor6QuestGoalFlags(world, state);
  }

  refreshFloor6UnlockedOffers(state);
  state.economy.selectionTrace.push({
    frame: world.frameCount,
    offerId,
    ok,
    reason,
    balanceBefore,
    balanceAfter: state.economy.balance,
  });
  if (state.economy.selectionTrace.length > FLOOR6_SELECTION_TRACE_LIMIT) {
    state.economy.selectionTrace.splice(
      0,
      state.economy.selectionTrace.length - FLOOR6_SELECTION_TRACE_LIMIT,
    );
  }
  return { ok, reason };
}

/**
 * Count live raider entities currently in world (health > 0 and entity exists).
 */
function countLiveFloor6Raiders(world: GameWorld): number {
  let count = 0;
  for (const eid of query(world.ecs, [BroadcastRelayRaider, Health])) {
    if ((world.stores.health.current[eid] ?? 0) > 0) count += 1;
  }
  return count;
}

/**
 * Reconcile live-enemy tracking: mark any record whose entity is dead/missing.
 * This prevents the director from waiting forever for a missing entity (FR3.3).
 */
function reconcileFloor6LiveEnemies(world: GameWorld, state: Floor6DefenseState): void {
  for (const record of state.liveEnemies) {
    if (record.eid <= 0 || record.defeated) continue;
    const eid = record.eid;
    const exists = entityExists(world.ecs, record.eid);
    const hp = world.stores.health.current[record.eid] ?? 0;
    const alive = exists && hp > 0;
    if (!alive) {
      record.defeated = true;
      const manifestEntry = state.waveManifest?.find((candidate) => {
        const rec = state.liveEnemies[candidate.manifestIndex];
        return rec === record;
      });
      if (manifestEntry?.kind === 'finale-boss' && exists && hp <= 0) {
        state.finale.bossDefeated = true;
        state.finale.bossDefeatedFrame ??= world.frameCount;
      }
      if (manifestEntry && !record.rewardSpawned && entityExists(world.ecs, eid)) {
        spawnFloor6BuildCurrencyReward(world, state, manifestEntry, eid);
        record.rewardSpawned = true;
      }
      record.eid = -1;
      record.stallResolved = true;
    }
  }
  creditFloor6WaveRewards(state);
  refreshFloor6UnlockedOffers(state);
}

/**
 * Release wave entries whose `releaseTick` has arrived, respecting the live cap.
 * Entries that cannot be released are banked as debt (FR3.2).
 * Debt is bounded by `spawnDebtCap`; entries beyond that are silently deferred
 * to the next available slot (still cleared at break/terminal per FR2.3).
 */
function releaseFloor6WaveEntries(world: GameWorld, state: Floor6DefenseState): void {
  const config = getFloor6Config();
  const tuning = config.tuning;
  const manifest = state.waveManifest;
  if (!manifest) return;
  const liveCap = tuning?.liveCap ?? 6;
  const debtCap = tuning?.spawnDebtCap ?? 12;
  const frame = world.frameCount;

  // First drain debt (already-due entries waiting for a slot)
  while (state.spawnDebt > 0 && countLiveFloor6Raiders(world) < liveCap) {
    // Find oldest unreleased due entry
    const debtEntry = manifest.find((e) => {
      if (e.manifestIndex >= state.nextReleaseIndex) return false;
      if (!isFloor6EntryReleasableInCurrentPhase(state, e)) return false;
      const rec = state.liveEnemies[e.manifestIndex];
      return rec && rec.eid === 0; // 0 = not yet spawned
    });
    if (!debtEntry) {
      state.spawnDebt = 0;
      break;
    }
    const eid = spawnFloor6Raider(world, state, debtEntry);
    const rec = state.liveEnemies[debtEntry.manifestIndex];
    if (rec) rec.eid = eid;
    state.spawnDebt = Math.max(0, state.spawnDebt - 1);
    state.totalReleased += 1;
    state.lastReleaseFrame = frame;
  }

  // Then release newly-due entries
  while (
    state.nextReleaseIndex < manifest.length &&
    manifest[state.nextReleaseIndex]!.releaseTick <= frame
  ) {
    const entry = manifest[state.nextReleaseIndex]!;
    if (!isFloor6EntryReleasableInCurrentPhase(state, entry)) break;
    state.nextReleaseIndex += 1;

    // Ensure liveEnemies record exists
    while (state.liveEnemies.length <= entry.manifestIndex) {
      state.liveEnemies.push({
        eid: 0,
        waypointIndex: 0,
        stillFrames: 0,
        stallResolved: false,
        defeated: false,
        rewardSpawned: false,
      });
    }
    const rec = state.liveEnemies[entry.manifestIndex]!;

    if (countLiveFloor6Raiders(world) < liveCap) {
      const eid = spawnFloor6Raider(world, state, entry);
      rec.eid = eid;
      state.totalReleased += 1;
      state.lastReleaseFrame = frame;
    } else if (state.spawnDebt < debtCap) {
      // Bank as debt — eid stays 0 until drained
      state.spawnDebt += 1;
    }
    // If over debtCap, entry is deferred but not counted (bounded debt)
  }
}

function isFloor6CurrentActCleared(state: Floor6DefenseState): boolean {
  const currentWaveIndex = getFloor6ActWaveIndex(state.currentActIndex);
  const manifest = state.waveManifest;
  if (currentWaveIndex === null || !manifest) return false;
  const entries = manifest.filter(
    (entry) => entry.kind === 'wave' && entry.waveIndex === currentWaveIndex,
  );
  return (
    entries.length > 0 &&
    entries.every((entry) => entry.manifestIndex < state.nextReleaseIndex) &&
    entries.every((entry) => state.liveEnemies[entry.manifestIndex]?.defeated === true)
  );
}

function enterFloor6Break(world: GameWorld, state: Floor6DefenseState): void {
  clearFloor6BreakState(world, state);
  state.breakStartedFrame = world.frameCount;
  state.breaksEntered += 1;
  recordFloor6PhaseTransition(world, state, { kind: 'BREAK' }, 'act-cleared');
}

function exitFloor6Break(world: GameWorld, state: Floor6DefenseState): void {
  state.breakStartedFrame = null;
  state.breaksExited += 1;
  state.currentActIndex += 1;
  recordFloor6PhaseTransition(world, state, { kind: 'DEFEND' }, 'break-complete');
}

function enterFloor6Finale(world: GameWorld, state: Floor6DefenseState): void {
  clearFloor6BreakState(world, state);
  const finaleEntries = buildFloor6FinaleManifestEntries(
    state,
    getFloor6Config(),
    world.frameCount,
  );
  if (finaleEntries.boss) {
    state.finale.bossManifest = finaleEntries.boss;
    state.finale.addManifest = finaleEntries.adds;
    state.finale.timeoutFrames = getFloor6Config().finale?.bossTimeoutFrames ?? 1800;
    state.waveManifest = Object.freeze([
      ...(state.waveManifest ?? []),
      ...finaleEntries.waveEntries,
    ]);
  }
  state.finale.startedFrame = world.frameCount;
  state.finale.bossEid = 0;
  state.finale.bossDefeated = false;
  state.finale.bossDefeatedFrame = null;
  state.breakStartedFrame = null;
  recordFloor6PhaseTransition(world, state, { kind: 'FINALE' }, 'deadline-start');
}

function progressFloor6DefensePhase(world: GameWorld, state: Floor6DefenseState): void {
  if (state.phase.kind !== 'DEFEND') return;
  if (!isFloor6CurrentActCleared(state)) return;
  const waves = getFloor6Config().waves ?? [];
  if (state.currentActIndex < waves.length - 1) {
    enterFloor6Break(world, state);
  } else {
    enterFloor6Finale(world, state);
  }
}

/**
 * `floor6RaiderSystem` — runs as `beforeEnemyAISystems` for floor 6.
 *
 * Drives each live `BroadcastRelayRaider` entity along its authored route
 * waypoints toward the Broadcast Relay. Normal `enemyAISystem` is NOT applied
 * to raiders (they carry only the `Enemy` tag so player attacks still register,
 * but have no `EnemyBehavior` component that the normal system would pick up).
 *
 * When a raider reaches the relay target tile it applies damage to
 * `state.relayHp` on its attack cooldown (FR3.1 / FR2.1).
 */
export function floor6RaiderSystem(world: GameWorld): void {
  const state = floor6DefenseState(world);
  if (!state || (state.phase.kind !== 'DEFEND' && state.phase.kind !== 'FINALE')) return;

  const config = getFloor6Config();
  const tuning = config.tuning;
  const speedFt =
    (tuning?.raiderSpeedFtPerFrame ?? 0.15) *
    Math.max(0, 1 - selectedFloor6UpgradeValue(state, 'raiderSlowBonus'));
  const arriveThreshold = tuning?.waypointArriveThresholdFt ?? 1.5;
  const attackRange = tuning?.raiderAttackRangeFt ?? 2.5;
  const relayDamage = tuning?.raiderRelayDamage ?? 8;
  const attackCooldownMs = tuning?.raiderAttackCooldownMs ?? 800;
  const stalledThreshold = tuning?.stalledFramesThreshold ?? 90;
  const floorMap = world.floorMap;
  const tileSizeFt = floorMap?.config.tileSizeFt ?? 4;

  // Build route lookup once per tick
  const routeById = new Map(state.geometry.routes.map((r) => [r.id, r]));

  for (const eid of query(world.ecs, [BroadcastRelayRaider, Health, Position])) {
    const hp = world.stores.health.current[eid] ?? 0;
    if (hp <= 0) continue;

    const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
    const manifest = state.waveManifest;
    if (!manifest) continue;
    const entry = manifest[mIdx];
    if (!entry) continue;
    const route = routeById.get(entry.routeId);
    if (!route) continue;

    let waypointIndex = world.stores.broadcastRelayRaider.waypointIndex[eid] ?? 0;
    const waypoints = route.waypoints;

    if (waypointIndex >= waypoints.length) {
      // Raider has reached the relay target — attack on cooldown
      const lastAttack = world.stores.broadcastRelayRaider.lastRelayAttackMs[eid] ?? 0;
      if (world.elapsedMs - lastAttack >= attackCooldownMs) {
        world.stores.broadcastRelayRaider.lastRelayAttackMs[eid] = world.elapsedMs;
        state.relayHp = Math.max(0, state.relayHp - relayDamage);
      }

      // Stop moving
      setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
      continue;
    }

    // Step toward current waypoint in world-space
    const wp = waypoints[waypointIndex]!;
    const tx = (wp.x + 0.5) * tileSizeFt;
    const ty = (wp.y + 0.5) * tileSizeFt;
    const cx = world.stores.position.x[eid] ?? 0;
    const cy = world.stores.position.y[eid] ?? 0;
    const dist = Math.hypot(tx - cx, ty - cy);

    if (dist <= arriveThreshold) {
      // Advance to next waypoint
      waypointIndex += 1;
      world.stores.broadcastRelayRaider.waypointIndex[eid] = waypointIndex;
      world.stores.broadcastRelayRaider.stillFrames[eid] = 0;
      setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
      continue;
    }

    // Check if this raider has arrived at relay range
    const relayTarget = state.geometry.broadcastRelay.target;
    const relayX = (relayTarget.x + 0.5) * tileSizeFt;
    const relayY = (relayTarget.y + 0.5) * tileSizeFt;
    const relayDist = Math.hypot(relayX - cx, relayY - cy);
    if (relayDist <= attackRange) {
      // Skip remaining waypoints and attack
      world.stores.broadcastRelayRaider.waypointIndex[eid] = waypoints.length;
      setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });
      continue;
    }

    // Move along the authored route directly. Floor 6 raiders follow validated
    // route waypoints and must not rely on generic collision response to make
    // forward progress, because a wall snag can otherwise soft-lock the wave.
    const step = Math.min(speedFt, dist);
    const nx = cx + ((tx - cx) / dist) * step;
    const ny = cy + ((ty - cy) / dist) * step;
    setComponent(world.ecs, eid, Position, { x: nx, y: ny });
    setComponent(world.ecs, eid, Velocity, { x: 0, y: 0 });

    // Stall detection: compare actual position to stored previous position.
    // prevX/prevY are written at the end of the last tick, so a full frame
    // of physics should have moved the raider by at least a small amount.
    const px = world.stores.broadcastRelayRaider.prevX[eid] ?? cx;
    const py = world.stores.broadcastRelayRaider.prevY[eid] ?? cy;
    const moved = Math.hypot(cx - px, cy - py);
    if (moved < 0.01) {
      const sf = (world.stores.broadcastRelayRaider.stillFrames[eid] ?? 0) + 1;
      world.stores.broadcastRelayRaider.stillFrames[eid] = sf;
      const rec = state.liveEnemies[mIdx];
      if (rec && rec.eid === eid) {
        rec.stillFrames = sf;
        if (sf >= stalledThreshold && !rec.stallResolved) {
          rec.stallResolved = true; // director will reconcile
          state.stalledRaiderCount += 1;
          const entry = state.waveManifest?.[mIdx];
          if (entry) {
            state.routeStallCounts[entry.routeId] =
              (state.routeStallCounts[entry.routeId] ?? 0) + 1;
          }
        }
      }
    } else {
      world.stores.broadcastRelayRaider.stillFrames[eid] = 0;
      const rec = state.liveEnemies[mIdx];
      if (rec) rec.stillFrames = 0;
    }
    // Capture current position for next tick's stall comparison
    world.stores.broadcastRelayRaider.prevX[eid] = cx;
    world.stores.broadcastRelayRaider.prevY[eid] = cy;
  }
}

/**
 * Deterministically choose the nearest legal raider. Equal distances resolve
 * to the lower EID, which is stable for equal seed and transaction traces.
 */
function selectFloor6TowerTarget(
  world: GameWorld,
  towerEid: number,
  rangeFt: number,
): number | null {
  const x = world.stores.position.x[towerEid] ?? 0;
  const y = world.stores.position.y[towerEid] ?? 0;
  let target: number | null = null;
  let targetDistance = Number.POSITIVE_INFINITY;
  for (const eid of query(world.ecs, [BroadcastRelayRaider, Health, Position])) {
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    const targetX = world.stores.position.x[eid] ?? 0;
    const targetY = world.stores.position.y[eid] ?? 0;
    const distance = Math.hypot(targetX - x, targetY - y);
    if (
      distance > rangeFt ||
      (world.floorMap && !world.floorMap.hasLineOfSight(x, y, targetX, targetY)) ||
      distance > targetDistance ||
      (distance === targetDistance && (target === null || eid > target))
    ) {
      continue;
    }
    target = eid;
    targetDistance = distance;
  }
  return target;
}

/** Floor 6 tower attacks run in the real shared scenario pipeline. */
export function floor6TowerSystem(world: GameWorld): void {
  const state = floor6DefenseState(world);
  if (!state || (state.phase.kind !== 'DEFEND' && state.phase.kind !== 'FINALE')) return;
  const damageBonus = selectedFloor6UpgradeValue(state, 'towerDamageBonus');
  const fireRateBonus = Math.min(
    FLOOR6_MAX_FIRE_RATE_BONUS,
    selectedFloor6UpgradeValue(state, 'towerFireRateBonus'),
  );
  for (const instance of state.towerInstances) {
    if (!entityExists(world.ecs, instance.eid)) continue;
    const tower = getFloor6TowerDef(instance.towerId);
    if (!tower) continue;
    const cooldown = Math.max(1, tower.attackCooldownMs * Math.max(0, 1 - fireRateBonus));
    if (world.elapsedMs - (world.stores.floor6Tower.lastAttackMs[instance.eid] ?? 0) < cooldown) {
      continue;
    }
    const target = selectFloor6TowerTarget(world, instance.eid, tower.attackRangeFt);
    if (target === null) continue;
    world.stores.floor6Tower.lastAttackMs[instance.eid] = world.elapsedMs;
    applyDamage(
      world,
      target,
      tower.attackDamage + damageBonus,
      world.stores.position.x[target] ?? 0,
      world.stores.position.y[target] ?? 0,
      {
        origin: 'environment',
        affinity: 'unscaled',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: instance.eid,
      },
    );
  }
}

/**
 * `floor6DefenseDirectorSystem` — sole writer of Floor 6 phase, phase trace,
 * wave manifests, and terminal transitions (ADR 0097 D1, spec FR2.1–FR2.4).
 *
 * Runs as `afterSpawnerSystems` to release waves and advance defense phase
 * before this tick's core combat systems. Same-frame combat contribution
 * telemetry is drained by `floor6CombatContributionSystem` in postSystems.
 *
 * Terminal ordering within a single tick (FR2.2):
 *   1. Player death → DEFEAT
 *   2. Relay HP ≤ 0 → DEFEAT
 *   3. Stall backstop → DEFEAT
 *   4. Wave release / phase / victory progress
 */
export function floor6DefenseDirectorSystem(world: GameWorld): void {
  const state = floor6DefenseState(world);
  if (!state) return;
  if (state.phase.kind === 'VICTORY' || state.phase.kind === 'DEFEAT') return;

  const config = getFloor6Config();
  const tuning = config.tuning;

  // ── SETUP → DEFEND: build manifest and transition ────────────────────────
  if (state.phase.kind === 'SETUP') {
    const manifest = buildFloor6WaveManifest(state, config);
    state.waveManifest = manifest;
    state.upgradeOfferManifest = buildFloor6UpgradeOfferManifest(state, config);
    const terminalResetCount = state.economy.terminalResetCount;
    state.economy = createFloor6EconomyState();
    state.economy.terminalResetCount = terminalResetCount;
    // `liveEnemies` is a readonly-array *reference* (cannot be reassigned) that
    // is otherwise append-only per FR3.4 stability. A same-world run restart
    // re-enters SETUP without recreating floor6DefenseState, so without this
    // truncation the prior run's records (many already `defeated: true`)
    // would still be indexed by `manifestIndex` — newly released raiders
    // would reuse the stale defeated entry, skip reconciliation, award wave
    // currency instantly, and never spawn their death pickup.
    state.liveEnemies.length = 0;
    state.relayHp = floor6RelayMaxHp(state);
    state.nextReleaseIndex = 0;
    state.spawnDebt = 0;
    state.totalReleased = 0;
    state.stalledRaiderCount = 0;
    state.routeStallCounts = {};
    state.routeReleaseCounts = {};
    state.stallFrames = 0;
    state.lastReleaseFrame = world.frameCount;
    state.combatEventCursor = world.combatEvents.length;
    state.lastCombatEvent = world.combatEvents.at(-1);
    state.heroDamageDealt = 0;
    state.towerDamageDealt = 0;
    state.currentActIndex = 0;
    state.breakStartedFrame = null;
    state.breaksEntered = 0;
    state.breaksExited = 0;
    state.hostileActivityDuringBreak = 0;
    state.finale = createFloor6FinaleState();
    state.terminalOutcome = null;
    state.terminalOutcomeCount = 0;
    state.victoryPayout = {
      awarded: false,
      count: 0,
      gold: 0,
      broadcastScore: 0,
    };
    state.exit = {
      opened: false,
      openCount: 0,
      confirmed: false,
    };
    recordFloor6PhaseTransition(world, state, { kind: 'DEFEND' }, 'setup-complete');
    return;
  }

  // ── Terminal precedence check 1: player death ─────────────────────────────
  if (isFloor6PlayerDefeated(world)) {
    setFloor6Defeat(world, state, 'player-defeated');
    return;
  }

  // ── Terminal precedence check 2: relay destroyed ──────────────────────────
  if (state.relayHp <= 0) {
    setFloor6Defeat(world, state, 'relay-destroyed');
    return;
  }

  if (state.phase.kind === 'BREAK') {
    // Entry clears normal act hostiles; this guarded path removes only illegal/stray break hostiles.
    if (countLiveFloor6Raiders(world) > 0) {
      clearFloor6BreakState(world, state);
    }
    const duration = config.finale?.breakDurationFrames ?? 0;
    const startedFrame = state.breakStartedFrame ?? world.frameCount;
    if (world.frameCount - startedFrame >= duration) {
      exitFloor6Break(world, state);
    }
    return;
  }

  if (
    state.phase.kind === 'FINALE' &&
    state.finale.startedFrame !== null &&
    world.frameCount - state.finale.startedFrame >= state.finale.timeoutFrames &&
    !state.finale.bossDefeated
  ) {
    setFloor6Defeat(world, state, 'deadline-timeout');
    return;
  }

  // ── Terminal precedence check 3: stall backstop ───────────────────────────
  const backstopFrames = tuning?.stallBackstopFrames ?? 3600;
  const manifest = state.waveManifest;
  const allReleased = manifest
    ? state.nextReleaseIndex >= manifest.length && state.spawnDebt === 0
    : false;
  const noLiveRaiders = countLiveFloor6Raiders(world) === 0;

  // Increment stall counter if no progress is being made
  const progressThisTick =
    state.totalReleased > 0 &&
    (state.lastReleaseFrame === world.frameCount || !allReleased || !noLiveRaiders);
  if (!progressThisTick && allReleased && noLiveRaiders) {
    // All waves done, no raiders alive — this is actually progress toward VICTORY
    // (Slice 3 defers VICTORY to later slices — for now hold in DEFEND)
    state.stallFrames = 0;
  } else if (allReleased && !noLiveRaiders) {
    // Raiders alive but can't make progress (e.g. all stalled)
    const allStalled = state.liveEnemies.filter((r) => r.eid > 0).every((r) => r.stallResolved);
    if (allStalled && state.liveEnemies.some((r) => r.eid > 0)) {
      state.stallFrames += 1;
    } else {
      state.stallFrames = 0;
    }
  } else {
    state.stallFrames = 0;
  }

  if (state.stallFrames >= backstopFrames) {
    setFloor6Defeat(world, state, 'wave-backstop');
    return;
  }

  // ── Reconcile dead/missing raiders ───────────────────────────────────────
  reconcileFloor6LiveEnemies(world, state);

  // ── Wave release ─────────────────────────────────────────────────────────
  if (state.phase.kind === 'DEFEND' || state.phase.kind === 'FINALE') {
    releaseFloor6WaveEntries(world, state);
  }

  if (state.phase.kind === 'FINALE' && state.finale.bossDefeated) {
    setFloor6Victory(world, state);
    return;
  }

  progressFloor6DefensePhase(world, state);
}

export function floor6CombatContributionSystem(world: GameWorld): void {
  const state = floor6DefenseState(world);
  if (!state) return;
  recordFloor6CombatContributions(world, state);
  reconcileFloor6TerminalAfterCore(world, state);
}

/**
 * Lightweight, pure per-frame HUD projection: builds only the presentation
 * snapshot the renderer actually needs (lines/cues), without the full
 * telemetry clone (`phaseTrace`, `upgradeOffers`, `selectionTrace`, etc.)
 * that {@link getFloor6DefenseRunStats} allocates for run-summary/AI
 * telemetry consumers. Safe to call every frame from the scenario HUD hook;
 * has no side effects (does not write goal flags).
 */
export function getFloor6HudPresentation(world: GameWorld): Floor6PresentationSnapshot | undefined {
  const state = floor6DefenseState(world);
  if (!state) return undefined;
  return buildFloor6PresentationSnapshot(world, state, floor6RelayMaxHp(state));
}

function buildFloor6PhaseDurations(
  state: Floor6DefenseState,
  currentFrame: number,
): Floor6DefenseRunStats['releaseGate']['phaseDurations'] {
  const durations: Floor6DefenseRunStats['releaseGate']['phaseDurations'][number][] = [];
  for (const [index, entry] of state.phaseTrace.entries()) {
    const next = state.phaseTrace[index + 1];
    const exitedFrame =
      next?.frame ??
      (entry.toKind === 'VICTORY' || entry.toKind === 'DEFEAT' ? entry.frame : currentFrame);
    durations.push({
      kind: entry.toKind,
      enteredFrame: entry.frame,
      exitedFrame,
      durationFrames: Math.max(0, exitedFrame - entry.frame),
    });
  }
  return durations;
}

function buildFloor6RoutePressure(
  state: Floor6DefenseState,
): Floor6DefenseRunStats['releaseGate']['routePressure'] {
  return state.geometry.routes.map((route) => ({
    routeId: route.id,
    released: state.routeReleaseCounts[route.id] ?? 0,
    stalled: state.routeStallCounts[route.id] ?? 0,
  }));
}

function buildFloor6ReleaseGateStats(
  world: GameWorld,
  state: Floor6DefenseState,
  liveEnemyCount: number,
  observedFrameCostMs: number | null,
): Floor6DefenseRunStats['releaseGate'] {
  const config = getFloor6Config();
  const gate = config.releaseGate;
  const activeTimeBudgetMs = floor6Manifest.implemented.winBudgetMs ?? null;
  const frameBudget =
    activeTimeBudgetMs === null ? null : Math.ceil((activeTimeBudgetMs * 1.1) / GAME.DELTA_MS);
  return {
    activeTimeBudgetMs,
    frameBudget,
    completionRateTarget: gate?.completionRateTarget ?? 0.9,
    minimumRelayHealthPct: gate?.minimumRelayHealthPct ?? 0,
    maxLiveEnemies: gate?.maxLiveEnemies ?? 0,
    maxStalledRaiders: gate?.maxStalledRaiders ?? 0,
    maxFrameCostMs: gate?.maxFrameCostMs ?? GAME.DELTA_MS,
    observedFrameCostMs,
    phaseDurations: buildFloor6PhaseDurations(state, world.frameCount),
    routePressure: buildFloor6RoutePressure(state),
    cleanup: {
      liveEnemyCount,
      spawnDebt: state.spawnDebt,
      terminalResetCount: state.economy.terminalResetCount,
      towersTornDown: state.towersTornDown,
    },
    terminalIntegrity: {
      terminal: state.terminalOutcome !== null,
      terminalOutcomeCount: state.terminalOutcomeCount,
      victoryPayoutCount: state.victoryPayout.count,
      exitOpenCount: state.exit.openCount,
    },
  };
}

/**
 * Collect a telemetry snapshot from the current defense state.
 * Safe to call from any floor, returns undefined when not on floor 6.
 */
export function getFloor6DefenseRunStats(
  world: GameWorld,
  observedFrameCostMs: number | null = null,
): Floor6DefenseRunStats | undefined {
  const state = floor6DefenseState(world);
  if (!state) return undefined;
  const relayMaxHp = floor6RelayMaxHp(state);
  const liveCount = countLiveFloor6Raiders(world);
  const stalledCount = state.stalledRaiderCount;
  return {
    phase: { ...state.phase },
    phaseTrace: state.phaseTrace.map((p) => ({ ...p })),
    relayHp: state.relayHp,
    relayMaxHp,
    nextReleaseIndex: state.nextReleaseIndex,
    spawnDebt: state.spawnDebt,
    totalReleased: state.totalReleased,
    liveEnemyCount: liveCount,
    stalledCount,
    waveManifestLength: state.waveManifest?.length ?? 0,
    buildCurrencyBalance: state.economy.balance,
    buildCurrencyEarned: state.economy.totalEarned,
    buildCurrencySpent: state.economy.totalSpent,
    buildCurrencyEarnedFromPickups: state.economy.earnedFromPickups,
    buildCurrencyEarnedFromWaves: state.economy.earnedFromWaves,
    buildCurrencyPickupsSpawned: state.economy.pickupsSpawned,
    buildCurrencyPickupsCollected: state.economy.pickupsCollected,
    upgradeOffers: (state.upgradeOfferManifest ?? []).map((offer) => ({
      ...offer,
      effect: { ...offer.effect },
    })),
    unlockedOfferIds: [...state.economy.unlockedOfferIds],
    selectedOfferIds: [...state.economy.selectedOfferIds],
    upgradeSelectionTrace: state.economy.selectionTrace.map((entry) => ({ ...entry })),
    terminalResetCount: state.economy.terminalResetCount,
    towers: state.towerInstances.map(({ siteId, towerId }) => ({ siteId, towerId })),
    towersTornDown: state.towersTornDown,
    heroDamageDealt: state.heroDamageDealt,
    towerDamageDealt: state.towerDamageDealt,
    currentActIndex: state.currentActIndex,
    breaksEntered: state.breaksEntered,
    breaksExited: state.breaksExited,
    hostileActivityDuringBreak: state.hostileActivityDuringBreak,
    finaleBossDefeated: state.finale.bossDefeated,
    finaleBossEid: state.finale.bossEid,
    finaleBossManifest: state.finale.bossManifest ? { ...state.finale.bossManifest } : null,
    finaleAddManifestLength: state.finale.addManifest.length,
    terminalOutcome: state.terminalOutcome,
    terminalOutcomeCount: state.terminalOutcomeCount,
    victoryPayoutAwarded: state.victoryPayout.awarded,
    victoryPayoutCount: state.victoryPayout.count,
    victoryPayoutGold: state.victoryPayout.gold,
    victoryPayoutBroadcastScore: state.victoryPayout.broadcastScore,
    exitOpened: state.exit.opened,
    exitOpenCount: state.exit.openCount,
    releaseGate: buildFloor6ReleaseGateStats(world, state, liveCount, observedFrameCostMs),
    presentation: buildFloor6PresentationSnapshot(world, state, relayMaxHp),
  };
}

/**
 * Pure predicate for whether the Relay exit is currently descendable — the
 * authoritative victory transaction fired (`exit.opened`). Has no side
 * effects, so it is safe for the stair marker's per-frame `locked` check;
 * it must NOT be used to latch the actual descent confirmation (see
 * {@link confirmFloor6StairDescend}).
 */
export function isFloor6ExitDescendable(world: GameWorld): boolean {
  const state = world.floorExtendedState?.floor6Defense;
  return state?.phase.kind === 'VICTORY' && state.exit.opened === true;
}

/**
 * Called when the player confirms descent through the Relay exit marker's
 * confirmation modal. The Deadline defeat opens the exit (`exit.opened`) but
 * must NOT by itself end the run: `getFloor6RunOutcome` only reports
 * `cleared_floor` once this confirmation has actually latched, so the
 * terminal completion screen cannot preempt the marker/confirmation
 * affordance. Returns `false` (no-op) if the exit isn't open yet or descent
 * was already confirmed.
 */
export function confirmFloor6StairDescend(world: GameWorld): boolean {
  const state = world.floorExtendedState?.floor6Defense;
  if (!state || !isFloor6ExitDescendable(world) || state.exit.confirmed) return false;
  state.exit.confirmed = true;
  evaluateAchievementUnlocksForPhase(world, 'run_end_clear');
  return true;
}

export function getFloor6RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  const state = world.floorExtendedState?.floor6Defense;
  if (
    state?.terminalOutcome === 'victory' &&
    state.phase.kind === 'VICTORY' &&
    state.exit.confirmed === true
  )
    return 'cleared_floor';
  if (state?.terminalOutcome === 'defeat' && state.phase.kind === 'DEFEAT') return 'failed_timeout';
  return null;
}

/** JSON-stable initialization artifact used by parity tests and the parity lab. */
export function _getFloor6InitializationArtifact(world: GameWorld) {
  const map = world.floorMap;
  const defense = world.floorExtendedState?.floor6Defense;
  if (!map || !defense) return null;
  return {
    map: {
      config: map.config,
      playerSpawn: map.playerSpawn,
      rooms: map.rooms.map((room) => ({
        id: room.id,
        bounds: room.bounds,
        role: room.role,
        label: room.label,
        neighbors: [...room.neighbors],
      })),
      tileFlags: [...map.tileMap.flags],
      terrain: [...map.terrain],
    },
    phase: defense.phase,
    phaseTrace: defense.phaseTrace,
    rngStreamKeys: defense.rngStreamKeys,
    geometry: defense.geometry,
  };
}
