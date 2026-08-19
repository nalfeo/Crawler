/**
 * Unit coverage for the shared Floor 2 den-boss diagnostic contract
 * (`src/game/ai/den-boss-telemetry.ts` + `src/shared/den-boss-telemetry-types.ts`).
 *
 * Driven by the deterministic seed-42 Floor 2 fixture, which builds a real
 * cave map, real den rooms with locked doors, real spawned bosses, and steps
 * the real `floor2ObjectiveTick` / `doorSystem`.
 */
import { removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
  DEN_BOSS_TRANSITION_ORDER,
  _collectDenBossSnapshots,
  createDenBossTransitionTracker,
  denBossSnapshotPayload,
  denBossTransitionPayload,
  _hasDenBossTelemetry,
  type DenBossSnapshot,
  type DenBossTransition,
  type DenBossTransitionKind,
} from '../../src/game/ai/den-boss-telemetry.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  createFloor2DenFixture,
  driveDenLifecycle,
  moveIntoDen,
  stepFloor2,
} from '../helpers/floor2-den-fixture.js';

function kindsOf(transitions: readonly DenBossTransition[]): DenBossTransitionKind[] {
  return transitions.map((transition) => transition.kind);
}

describe('den-boss telemetry — collection', () => {
  it('reports no den telemetry on a world without den encounters', () => {
    const world = createTestWorld({ seed: 42 });
    expect(_hasDenBossTelemetry(world)).toBe(false);
    expect(_collectDenBossSnapshots(world, null)).toEqual([]);
    expect(createDenBossTransitionTracker().poll(world, 1, null)).toEqual([]);
    expect(createDenBossTransitionTracker().getDiagnostics()).toBeUndefined();
  });

  it('snapshots every den with the full diagnostic contract', () => {
    const fixture = createFloor2DenFixture();
    const snapshots = _collectDenBossSnapshots(fixture.world, fixture.playerEid);
    const families = fixture.world.floorExtendedState!.familyState!.presentFamilies;

    expect(snapshots.length).toBe(families.length);
    // Deterministic order — `presentFamilies`, never Map insertion order.
    expect(snapshots.map((snapshot) => snapshot.familyId)).toEqual([...families]);

    const first = snapshots[0]!;
    expect(first.schemaVersion).toBe(DEN_BOSS_TELEMETRY_SCHEMA_VERSION);
    expect(first.denRoomId).toBe(fixture.encounter.roomId);
    expect(first.displayName).toBe(fixture.encounter.displayName);
    // The boss spawns sealed inside its own den, invincible, undefeated.
    expect(first.bossAlive).toBe(true);
    expect(first.bossEid).toBe(fixture.encounter.bossEid);
    expect(first.lastKnownBossEid).toBe(fixture.encounter.bossEid);
    expect(first.bossInDen).toBe(true);
    expect(first.bossRoomId).toBe(fixture.encounter.roomId);
    expect(first.bossTileX).not.toBeNull();
    expect(first.bossTileY).not.toBeNull();
    expect(first.bossHealthMax).toBeGreaterThan(0);
    expect(first.encounterStarted).toBe(false);
    expect(first.encounterDefeated).toBe(false);
    expect(first.encounterGoalActive).toBe(false);
    expect(first.denUnlocked).toBe(false);
    expect(first.denDoorsTotal).toBeGreaterThan(0);
    expect(first.denDoorsLocked).toBe(first.denDoorsTotal);
    expect(first.denSealed).toBe(true);
    expect(first.playerInDen).toBe(false);
  });

  it('is JSON round-trippable so JSONL recordings stay self-describing', () => {
    const fixture = createFloor2DenFixture();
    const snapshots = _collectDenBossSnapshots(fixture.world, fixture.playerEid);
    const payload = denBossSnapshotPayload(snapshots);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(payload.kind).toBe('snapshot');
    expect(payload.familyId).toBeNull();
    expect(payload.before).toBeNull();
    expect(payload.dens.length).toBe(snapshots.length);
  });
});

describe('den-boss telemetry — transitions', () => {
  it('emits a baseline record for every den on first observation', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const first = tracker.poll(fixture.world, 0, fixture.playerEid);
    const families = fixture.world.floorExtendedState!.familyState!.presentFamilies;

    expect(first.length).toBe(families.length);
    expect(new Set(kindsOf(first))).toEqual(new Set<DenBossTransitionKind>(['baseline']));
    expect(first.map((transition) => transition.familyId)).toEqual([...families]);
    expect(first[0]!.before).toBeNull();

    // A second poll with nothing changed emits nothing.
    expect(tracker.poll(fixture.world, 1, fixture.playerEid)).toEqual([]);
  });

  it('records the full den lifecycle from the production systems', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const observed: DenBossTransition[] = [];
    driveDenLifecycle(fixture, (frame) => {
      observed.push(...tracker.poll(fixture.world, frame, fixture.playerEid));
    });

    const subject = observed.filter(
      (transition) => transition.familyId === fixture.encounter.familyId,
    );
    const kinds = kindsOf(subject);
    expect(kinds).toContain('baseline');
    expect(kinds).toContain('den-unlocked');
    expect(kinds).toContain('player-entered-den');
    expect(kinds).toContain('encounter-started');
    expect(kinds).toContain('encounter-goal-set');
    expect(kinds).toContain('boss-left-den');
    expect(kinds).toContain('boss-returned-to-den');
    expect(kinds).toContain('encounter-defeated');

    // Ordering is monotonic in frame index.
    const frames = subject.map((transition) => transition.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });

  it('keeps the boss identity on the defeat record even though the encounter nulls it', () => {
    const fixture = createFloor2DenFixture();
    const spawnedBossEid = fixture.encounter.bossEid;
    expect(spawnedBossEid).not.toBeNull();

    const tracker = createDenBossTransitionTracker();
    const observed: DenBossTransition[] = [];
    driveDenLifecycle(fixture, (frame) => {
      observed.push(...tracker.poll(fixture.world, frame, fixture.playerEid));
    });

    const defeat = observed.find(
      (transition) =>
        transition.kind === 'encounter-defeated' &&
        transition.familyId === fixture.encounter.familyId,
    );
    expect(defeat).toBeDefined();
    // The production tick sets `bossEid = null` on defeat; the contract still
    // identifies the boss through `lastKnownBossEid` and the `before` snapshot.
    expect(defeat!.after.lastKnownBossEid).toBe(spawnedBossEid);
    expect(defeat!.before?.bossEid).toBe(spawnedBossEid);
    expect(defeat!.before?.bossAlive).toBe(true);

    const diagnostics = tracker.getDiagnostics()!;
    const family = diagnostics.families[fixture.encounter.familyId]!;
    expect(family.firstBossEid).toBe(spawnedBossEid);
    expect(family.lastKnownBossEid).toBe(spawnedBossEid);
    expect(family.encounterDefeatedFrame).not.toBeNull();
    expect(family.encounterDefeatedMs).not.toBeNull();
  });

  it('does not trust a stale boss entity id after the entity is gone', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    tracker.poll(fixture.world, 0, fixture.playerEid);

    // Simulate the hazard directly: the encounter still points at an eid whose
    // entity has been removed. Typed-array slots keep their old values, so a
    // naive read would report a live boss standing at its last position.
    const bossEid = fixture.encounter.bossEid!;
    removeEntity(fixture.world.ecs, bossEid);
    stepFloor2(fixture.world);

    const transitions = tracker.poll(fixture.world, 1, fixture.playerEid);
    expect(kindsOf(transitions)).toContain('boss-despawned');
    const snapshot = _collectDenBossSnapshots(fixture.world, fixture.playerEid)[0]!;
    expect(snapshot.bossAlive).toBe(false);
    expect(snapshot.bossInDen).toBe(false);
    expect(snapshot.bossTileX).toBeNull();
    expect(snapshot.bossHealthCurrent).toBeNull();
  });

  it('re-emits baselines after reset', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const families = fixture.world.floorExtendedState!.familyState!.presentFamilies;
    tracker.poll(fixture.world, 0, fixture.playerEid);
    expect(tracker.poll(fixture.world, 1, fixture.playerEid)).toEqual([]);

    tracker.reset();
    expect(tracker.getDiagnostics()).toBeUndefined();
    const afterReset = tracker.poll(fixture.world, 2, fixture.playerEid);
    expect(afterReset.length).toBe(families.length);
    expect(new Set(kindsOf(afterReset))).toEqual(new Set<DenBossTransitionKind>(['baseline']));
  });

  it('tracks the player crossing the den threshold', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    tracker.poll(fixture.world, 0, fixture.playerEid);

    moveIntoDen(fixture.world, fixture.playerEid, fixture.encounter);
    stepFloor2(fixture.world);
    const entered = tracker.poll(fixture.world, 1, fixture.playerEid);
    expect(kindsOf(entered)).toContain('player-entered-den');
    expect(entered[0]!.after.playerInDen).toBe(true);
    expect(entered[0]!.after.playerRoomId).toBe(fixture.encounter.roomId);
  });

  it('builds a transition payload that carries before/after evidence', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const baseline = tracker.poll(fixture.world, 0, fixture.playerEid)[0]!;
    const payload = denBossTransitionPayload(baseline);
    expect(payload.kind).toBe('baseline');
    expect(payload.familyId).toBe(baseline.familyId);
    expect(payload.dens).toEqual([baseline.after]);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe('den-boss telemetry — rollup', () => {
  it('accumulates a bounded transition log and a per-family rollup', () => {
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    driveDenLifecycle(fixture, (frame) => {
      tracker.poll(fixture.world, frame, fixture.playerEid);
    });

    const diagnostics = tracker.getDiagnostics()!;
    expect(diagnostics.schemaVersion).toBe(DEN_BOSS_TELEMETRY_SCHEMA_VERSION);
    expect(diagnostics.eventStreamType).toBe('den');
    expect(diagnostics.transitionCount).toBe(tracker.getTransitionCount());
    expect(diagnostics.transitions.length).toBeLessThanOrEqual(diagnostics.transitionCount);
    expect(diagnostics.transitionsTruncated).toBe(false);
    expect(Object.keys(diagnostics.families).sort()).toEqual(
      [...fixture.world.floorExtendedState!.familyState!.presentFamilies].sort(),
    );

    const family = diagnostics.families[fixture.encounter.familyId]!;
    expect(family.denUnlockedMs).not.toBeNull();
    expect(family.encounterStartedMs).not.toBeNull();
    expect(family.bossLeftDenCount).toBeGreaterThanOrEqual(1);
    expect(family.bossReturnedToDenCount).toBeGreaterThanOrEqual(1);
    expect(family.firstBossLeftDenMs).not.toBeNull();
    expect(family.final.encounterDefeated).toBe(true);
    expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics);
  });
});

describe('den-boss telemetry — record stability', () => {
  it('classify emits simultaneous transitions in DEN_BOSS_TRANSITION_ORDER', () => {
    // The collector pushes kinds in source order rather than filtering the
    // canonical list, so this pins the two orders together.
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const seen: DenBossTransitionKind[][] = [];
    driveDenLifecycle(fixture, (frame) => {
      const transitions = tracker.poll(fixture.world, frame, fixture.playerEid);
      const byFamily = new Map<string, DenBossTransitionKind[]>();
      for (const transition of transitions) {
        const kinds = byFamily.get(transition.familyId) ?? [];
        kinds.push(transition.kind);
        byFamily.set(transition.familyId, kinds);
      }
      seen.push(...byFamily.values());
    });

    expect(seen.some((kinds) => kinds.length > 1)).toBe(true);
    for (const kinds of seen) {
      if (kinds[0] === 'baseline') continue;
      const canonical = DEN_BOSS_TRANSITION_ORDER.filter((kind) => kinds.includes(kind));
      expect(kinds).toEqual(canonical);
    }
  });

  it('never rewrites an already-emitted snapshot on a later frame', () => {
    // The tracker reuses a scratch buffer and mutates `previous` in place on
    // quiet frames; emitted records must be immune to that.
    const fixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    const emitted: { frozen: string; live: DenBossSnapshot }[] = [];
    driveDenLifecycle(fixture, (frame) => {
      for (const transition of tracker.poll(fixture.world, frame, fixture.playerEid)) {
        emitted.push({ frozen: JSON.stringify(transition.after), live: transition.after });
      }
      for (const snapshot of tracker.getSnapshots()) {
        emitted.push({ frozen: JSON.stringify(snapshot), live: snapshot });
      }
    });

    expect(emitted.length).toBeGreaterThan(5);
    for (const { frozen, live } of emitted) {
      expect(JSON.stringify(live)).toBe(frozen);
    }
  });
});
