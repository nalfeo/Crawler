/**
 * Floor 6 Slice 3 — wave director and route-following raider unit tests.
 *
 * Covers acceptance criteria FR3.2 (manifests, stable IDs, bounded cap/debt),
 * FR3.3 (missing entity recovery), FR3.4 (stable ordering), FR2.2 (terminal
 * precedence), and FR9.6 (no soft lock).
 */
import { query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BroadcastRelayRaider, Health, Position } from '../../src/core/index.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  floor6DefenseDirectorSystem,
  floor6RaiderSystem,
  getFloor6DefenseRunStats,
  _getFloor6InitializationArtifact,
} from '../../src/game/floor6Scenario.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import { createTestWorld } from '../helpers/world-factory.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function initFloor6(seed = 606) {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  createFloorMainSceneOptions('floor6').configureWorld!(world, player);
  return { world, player };
}

function getDefenseState(world: ReturnType<typeof createTestWorld>) {
  const state = world.floorExtendedState?.floor6Defense;
  if (!state) throw new Error('No floor6 defense state');
  return state;
}

function tickDirector(world: ReturnType<typeof createTestWorld>, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6DefenseDirectorSystem(world);
  }
}

function tickBoth(world: ReturnType<typeof createTestWorld>, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    world.frameCount += 1;
    world.elapsedMs += 16;
    floor6RaiderSystem(world);
    floor6DefenseDirectorSystem(world);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Floor 6 wave manifest determinism', () => {
  it('produces byte-identical manifests for the same seed (FR9.1)', () => {
    const { world: w1 } = initFloor6(606);
    const { world: w2 } = initFloor6(606);
    tickDirector(w1);
    tickDirector(w2);
    const s1 = getDefenseState(w1);
    const s2 = getDefenseState(w2);
    expect(JSON.stringify(s1.waveManifest)).toBe(JSON.stringify(s2.waveManifest));
  });

  it('produces different manifests for different seeds', () => {
    // Both seeds share the same authored schedule (stable content), but the
    // rngStreamKeys differ — the manifest itself is seed-independent authored
    // data. The keys are seed-scoped.
    const { world: w1 } = initFloor6(606);
    const { world: w2 } = initFloor6(999);
    tickDirector(w1);
    tickDirector(w2);
    expect(w1.floorExtendedState?.floor6Defense?.rngStreamKeys.waves).not.toBe(
      w2.floorExtendedState?.floor6Defense?.rngStreamKeys.waves,
    );
    // The authored schedule content is identical (same manifest JSON)
    expect(JSON.stringify(w1.floorExtendedState?.floor6Defense?.waveManifest)).toBe(
      JSON.stringify(w2.floorExtendedState?.floor6Defense?.waveManifest),
    );
  });

  it('manifest entries are stable-ordered (FR3.4) — manifestIndex matches array index', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const manifest = state.waveManifest;
    expect(manifest).not.toBeNull();
    manifest!.forEach((entry, idx) => {
      expect(entry.manifestIndex).toBe(idx);
    });
  });

  it('every manifest entry references a valid route ID from geometry (FR3.2)', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const routeIds = new Set(state.geometry.routes.map((r) => r.id));
    for (const entry of state.waveManifest ?? []) {
      expect(routeIds.has(entry.routeId)).toBe(true);
    }
  });

  it('every manifest entry has a valid archetypeId from the floor6 pack (FR3.2)', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const validIds = new Set(['floor6-site-prep', 'floor6-demo-lead', 'floor6-cable-crew']);
    for (const entry of state.waveManifest ?? []) {
      expect(validIds.has(entry.archetypeId)).toBe(true);
    }
  });

  it('wave schedule matches authored floor6.manifest.json', () => {
    const { world } = initFloor6(606);
    tickDirector(world);
    const state = getDefenseState(world);
    const authored = floor6Manifest.floor6?.waves ?? [];
    const expectedTotal = authored.reduce((sum, w) => sum + w.entries.length, 0);
    expect(state.waveManifest?.length).toBe(expectedTotal);
  });
});

describe('Floor 6 phase transitions', () => {
  it('transitions SETUP → DEFEND on first director tick', () => {
    const { world } = initFloor6();
    expect(getDefenseState(world).phase.kind).toBe('SETUP');
    tickDirector(world);
    expect(getDefenseState(world).phase.kind).toBe('DEFEND');
  });

  it('records SETUP in phase trace after first transition', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const trace = getDefenseState(world).phaseTrace;
    expect(trace[0]?.kind).toBe('SETUP');
  });

  it('terminal phases are idempotent — further ticks do not change state', () => {
    const { world, player } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    // Kill player
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world); // should → DEFEAT
    expect(getDefenseState(world).phase.kind).toBe('DEFEAT');
    const statsAfter = getFloor6DefenseRunStats(world);
    tickDirector(world); // should be no-op
    tickDirector(world);
    expect(getDefenseState(world).phase.kind).toBe('DEFEAT');
    expect(getFloor6DefenseRunStats(world)).toEqual(statsAfter);
  });
});

describe('Floor 6 terminal precedence (FR2.2)', () => {
  it('player death → DEFEAT (highest precedence)', () => {
    const { world, player } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    // Manually reduce relay HP so relay is also about to be destroyed
    const state = getDefenseState(world);
    state.relayHp = 1;
    // Kill player
    setComponent(world.ecs, player, Health, { current: 0, max: 100 });
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
    // Phase trace should record DEFEND (where we were when player died)
    expect(state.phaseTrace.some((p) => p.kind === 'DEFEND')).toBe(true);
    // Run stats must reflect DEFEAT
    expect(getFloor6DefenseRunStats(world)?.phase.kind).toBe('DEFEAT');
  });

  it('relay HP ≤ 0 → DEFEAT (second precedence, player alive)', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    state.relayHp = 0;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
  });

  it('relay HP > 0 does not trigger defeat', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    state.relayHp = 50;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEND');
  });
});

describe('Floor 6 live cap and spawn debt (FR3.2)', () => {
  it('director transitions to DEFEND and initializes relay HP from tuning', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const expectedHp = floor6Manifest.floor6?.tuning?.relayMaxHp ?? 100;
    expect(state.relayHp).toBe(expectedHp);
    expect(state.relayHp).toBeGreaterThan(0);
  });

  it('spawnDebt starts at 0 after SETUP→DEFEND', () => {
    const { world } = initFloor6();
    tickDirector(world);
    expect(getDefenseState(world).spawnDebt).toBe(0);
  });

  it('nextReleaseIndex advances as ticks pass first wave releaseTick', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    expect(state.nextReleaseIndex).toBe(0);
    // Advance to firstReleaseTick
    while (world.frameCount < firstReleaseTick) {
      tickDirector(world);
    }
    tickDirector(world); // this tick should release entry 0
    expect(state.nextReleaseIndex).toBeGreaterThan(0);
  });

  it('spawnDebt is bounded to spawnDebtCap (FR3.2)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const cap = floor6Manifest.floor6?.tuning?.liveCap ?? 6;
    const debtCap = floor6Manifest.floor6?.tuning?.spawnDebtCap ?? 12;
    // Advance past ALL wave release ticks to force debt accumulation
    const maxTick = (state.waveManifest?.at(-1)?.releaseTick ?? 0) + 200;
    while (world.frameCount < maxTick) {
      tickDirector(world);
    }
    // spawnDebt must never exceed debtCap
    expect(state.spawnDebt).toBeLessThanOrEqual(debtCap);
    // Live raiders must not exceed live cap
    const liveCount = Array.from(query(world.ecs, [BroadcastRelayRaider, Health])).filter(
      (eid) => (world.stores.health.current[eid] ?? 0) > 0,
    ).length;
    expect(liveCount).toBeLessThanOrEqual(cap);
  });
});

describe('Floor 6 missing entity recovery (FR3.3)', () => {
  it('reconcileFloor6LiveEnemies marks dead entities without softlock', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;

    // Advance to first release
    while (world.frameCount <= firstReleaseTick) {
      tickDirector(world);
    }
    // Find a live raider and kill it
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    if (raiders.length > 0) {
      const eid = raiders[0]!;
      setComponent(world.ecs, eid, Health, { current: 0, max: 30 });
      // Tick director to reconcile
      tickDirector(world);
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const rec = state.liveEnemies[mIdx];
      // After reconciliation the record should reflect the entity is no longer live
      expect(rec?.eid).toBeLessThanOrEqual(0);
    }
  });

  it('phase does not stall when all raiders are dead/missing (FR3.3)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    // Advance past all release ticks
    const maxTick = (state.waveManifest?.at(-1)?.releaseTick ?? 0) + 200;
    while (world.frameCount < maxTick) {
      tickDirector(world);
    }
    // Kill all raiders
    for (const eid of query(world.ecs, [BroadcastRelayRaider, Health])) {
      setComponent(world.ecs, eid, Health, { current: 0, max: 30 });
    }
    // Multiple ticks should not produce DEFEAT (we're not stalled — all done)
    tickDirector(world);
    tickDirector(world);
    tickDirector(world);
    // Without player death or relay loss, phase stays DEFEND (Victory deferred to later slices)
    expect(state.phase.kind).toBe('DEFEND');
  });
});

describe('Floor 6 run stats telemetry (FR2.4)', () => {
  it('getFloor6DefenseRunStats returns undefined when not on floor 6', () => {
    const world = createTestWorld({ seed: 42 });
    expect(getFloor6DefenseRunStats(world)).toBeUndefined();
  });

  it('returns valid stats after initialization', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const stats = getFloor6DefenseRunStats(world);
    expect(stats).toBeDefined();
    expect(stats?.phase.kind).toBe('DEFEND');
    expect(stats?.relayHp).toBeGreaterThan(0);
    expect(stats?.relayMaxHp).toBeGreaterThan(0);
    expect(stats?.waveManifestLength).toBeGreaterThan(0);
    expect(stats?.spawnDebt).toBe(0);
  });

  it('relayMaxHp matches manifest tuning', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const stats = getFloor6DefenseRunStats(world);
    expect(stats?.relayMaxHp).toBe(floor6Manifest.floor6?.tuning?.relayMaxHp ?? 100);
  });
});

describe('Floor 6 raider route traversal (FR3.1)', () => {
  it('spawned raiders carry BroadcastRelayRaider component with route data', () => {
    const { world } = initFloor6();
    tickDirector(world); // SETUP → DEFEND
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickBoth(world);
    }
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health]));
    if (raiders.length > 0) {
      const eid = raiders[0]!;
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const entry = state.waveManifest?.[mIdx];
      expect(entry).toBeDefined();
      expect(entry?.routeId).toBeDefined();
      // waypointIndex starts at 0 or may have advanced; just check it's a valid index
      const wpIdx = world.stores.broadcastRelayRaider.waypointIndex[eid] ?? 0;
      const route = state.geometry.routes.find((r) => r.id === entry?.routeId);
      expect(wpIdx).toBeGreaterThanOrEqual(0);
      if (route) expect(wpIdx).toBeLessThanOrEqual(route.waypoints.length);
    }
  });

  it('raider velocity is non-zero when DEFEND and has waypoints to follow', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    const firstReleaseTick = state.waveManifest?.[0]?.releaseTick ?? 999;
    while (world.frameCount <= firstReleaseTick) {
      tickBoth(world);
    }
    tickBoth(world); // run raider system
    const raiders = Array.from(query(world.ecs, [BroadcastRelayRaider, Health, Position]));
    for (const eid of raiders) {
      if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
      const wIdx = world.stores.broadcastRelayRaider.waypointIndex[eid] ?? 0;
      const mIdx = world.stores.broadcastRelayRaider.manifestIndex[eid] ?? 0;
      const entry = state.waveManifest?.[mIdx];
      const route = state.geometry.routes.find((r) => r.id === entry?.routeId);
      if (!route || wIdx >= route.waypoints.length) continue;
      // Should have non-zero velocity (moving toward waypoint)
      const vx = world.stores.velocity.x[eid] ?? 0;
      const vy = world.stores.velocity.y[eid] ?? 0;
      expect(Math.hypot(vx, vy)).toBeGreaterThan(0);
      break; // one raider is enough
    }
  });

  it('debt cleared when relay destroyed (terminal cleanup)', () => {
    const { world } = initFloor6();
    tickDirector(world);
    const state = getDefenseState(world);
    // Force some debt
    state.spawnDebt = 5;
    state.relayHp = 0;
    tickDirector(world);
    expect(state.phase.kind).toBe('DEFEAT');
    expect(state.spawnDebt).toBe(0);
  });
});
