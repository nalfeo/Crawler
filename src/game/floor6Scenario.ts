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
  Damage,
  Enemy,
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
import { clearEntityStores, createEntity } from '../core/helpers.js';
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
  Floor6WaveManifestEntry,
} from '../shared/floor-types.js';
import { BiomeType, type MapConfig } from '../shared/map-types.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import type { ScenarioRunOutcome } from '../shared/scenario-presentation.js';
import { TeamId } from '../shared/constants.js';
import { getFloorEnemyPack } from '../shared/enemy-packs.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { initializePlayerWeaponSkills } from './floorScenario.js';
import type { PlayerCarryoverSnapshot } from './playerCarryover.js';
import { restorePlayerCarryover } from './playerCarryover.js';
import { equipStarterOrFallback } from './scenarios/starterWeaponEquip.js';

function getFloor6Config(): NonNullable<typeof floor6Manifest.floor6> {
  const config = floor6Manifest.floor6;
  if (!config) {
    throw new Error('Floor 6 manifest is missing floor6 configuration');
  }
  return config;
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
    liveEnemies: [],
    nextReleaseIndex: 0,
    spawnDebt: 0,
    relayHp: tuning?.relayMaxHp ?? 100,
    stallFrames: 0,
    totalReleased: 0,
    lastReleaseFrame: 0,
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
  world.state = 'playing';
}

// ── Slice 3: Wave director, route-following raider AI ──────────────────────

const FLOOR6_ENEMY_PACK_ID = 'floor6-renovation-crew';

/** Retrieve the floor6 defense state guard; returns null when not on floor 6. */
function floor6DefenseState(world: GameWorld): Floor6DefenseState | null {
  return world.floorExtendedState?.floor6Defense ?? null;
}

/** Record a phase transition and push to the trace. */
function recordFloor6PhaseTransition(
  state: Floor6DefenseState,
  newPhase: Floor6DefenseState['phase'],
  _reason: string,
): void {
  state.phaseTrace.push({ kind: state.phase.kind });
  state.phase = newPhase;
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
  const pack = getFloorEnemyPack(FLOOR6_ENEMY_PACK_ID);
  const knownArchetypes = new Set(pack?.archetypes.map((a) => a.id) ?? []);

  const entries: Floor6WaveManifestEntry[] = [];
  let manifestIndex = 0;
  for (const wave of waves) {
    for (const entry of wave.entries) {
      const routeIndex = entry.routeIndex % Math.max(routes.length, 1);
      const route = routes[routeIndex];
      if (!route) continue;
      const archetypeId = knownArchetypes.has(entry.archetypeId)
        ? entry.archetypeId
        : (pack?.archetypes[0]?.id ?? 'floor6-site-prep');
      entries.push({
        manifestIndex,
        waveIndex: wave.waveIndex,
        waveLabel: wave.label,
        routeId: route.id,
        entranceId: route.entranceId,
        archetypeId,
        releaseTick: entry.releaseTick,
      });
      manifestIndex += 1;
    }
  }
  return Object.freeze(entries);
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

  return eid;
}

/** Remove all live raider entities (break/terminal cleanup). */
function clearFloor6Raiders(world: GameWorld, state: Floor6DefenseState): void {
  for (const record of state.liveEnemies) {
    if (record.eid > 0 && entityExists(world.ecs, record.eid)) {
      removeEntity(world.ecs, record.eid);
      clearEntityStores(world, record.eid);
    }
    record.eid = -1;
  }
  state.spawnDebt = 0;
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
    if (record.eid <= 0 || record.stallResolved) continue;
    const alive =
      entityExists(world.ecs, record.eid) && (world.stores.health.current[record.eid] ?? 0) > 0;
    if (!alive) {
      record.eid = -1;
      record.stallResolved = true;
    }
  }
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
    const debtEntry = manifest.slice(0, state.nextReleaseIndex).find((e) => {
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
    state.nextReleaseIndex += 1;

    // Ensure liveEnemies record exists
    while (state.liveEnemies.length <= entry.manifestIndex) {
      state.liveEnemies.push({ eid: 0, waypointIndex: 0, stillFrames: 0, stallResolved: false });
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
  const speedFt = tuning?.raiderSpeedFtPerFrame ?? 0.15;
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

    // Move toward current waypoint
    const vx = ((tx - cx) / dist) * speedFt;
    const vy = ((ty - cy) / dist) * speedFt;
    setComponent(world.ecs, eid, Velocity, { x: vx, y: vy });

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
 * `floor6DefenseDirectorSystem` — sole writer of Floor 6 phase, phase trace,
 * wave manifests, and terminal transitions (ADR 0097 D1, spec FR2.1–FR2.4).
 *
 * Runs as `afterSpawnerSystems` so combat resolution (damage / death) has
 * already occurred for this tick, giving terminal-precedence checks a
 * consistent view of player and relay HP.
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
    state.relayHp = tuning?.relayMaxHp ?? 100;
    state.nextReleaseIndex = 0;
    state.spawnDebt = 0;
    state.totalReleased = 0;
    state.stallFrames = 0;
    state.lastReleaseFrame = world.frameCount;
    recordFloor6PhaseTransition(state, { kind: 'DEFEND' }, 'setup-complete');
    return;
  }

  // ── Terminal precedence check 1: player death ─────────────────────────────
  const playerEntities = Array.from(query(world.ecs, [Player, Health]));
  const playerDead = playerEntities.some((eid) => (world.stores.health.current[eid] ?? 1) <= 0);
  if (playerDead) {
    clearFloor6Raiders(world, state);
    recordFloor6PhaseTransition(state, { kind: 'DEFEAT' }, 'player-death');
    return;
  }

  // ── Terminal precedence check 2: relay destroyed ──────────────────────────
  if (state.relayHp <= 0) {
    clearFloor6Raiders(world, state);
    recordFloor6PhaseTransition(state, { kind: 'DEFEAT' }, 'relay-destroyed');
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
    clearFloor6Raiders(world, state);
    recordFloor6PhaseTransition(state, { kind: 'DEFEAT' }, 'stall-backstop');
    return;
  }

  // ── Reconcile dead/missing raiders ───────────────────────────────────────
  reconcileFloor6LiveEnemies(world, state);

  // ── Wave release ─────────────────────────────────────────────────────────
  if (state.phase.kind === 'DEFEND' || state.phase.kind === 'FINALE') {
    releaseFloor6WaveEntries(world, state);
  }
}

/**
 * Collect a telemetry snapshot from the current defense state.
 * Safe to call from any floor, returns undefined when not on floor 6.
 */
export function getFloor6DefenseRunStats(world: GameWorld): Floor6DefenseRunStats | undefined {
  const state = floor6DefenseState(world);
  if (!state) return undefined;
  const config = getFloor6Config();
  const relayMaxHp = config.tuning?.relayMaxHp ?? 100;
  const liveCount = countLiveFloor6Raiders(world);
  const stalledCount = state.liveEnemies.filter((r) => r.stallResolved && r.eid > 0).length;
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
  };
}

/** Floor 6 cannot open its exit before the later finale/release slices. */
export function confirmFloor6StairDescend(): boolean {
  return false;
}

export function getFloor6RunOutcome(world: GameWorld): ScenarioRunOutcome | null {
  const phase = world.floorExtendedState?.floor6Defense?.phase.kind;
  if (phase === 'VICTORY') return 'cleared_floor';
  if (phase === 'DEFEAT') return 'failed_timeout';
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
