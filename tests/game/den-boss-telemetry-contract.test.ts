/**
 * Cross-path den-boss telemetry contract (issue #3093).
 *
 * Proves that all THREE telemetry collection surfaces expose the same Floor 2
 * den-boss diagnostic evidence for the same deterministic seed-42 world:
 *
 *  1. the real game's player session recorder (`createFloorMainSceneOptions`
 *     → `sessionRecorderFactory`),
 *  2. the AI Runner lab's recorder (`createSessionRecorderControls().factory`),
 *  3. the headless `RunStats` rollup shape produced by the shared tracker
 *     (`createDenBossTransitionTracker` — the exact collector `runHeadless`
 *     polls each frame).
 *
 * Each surface is driven over the SAME world states, so any schema drift
 * between them fails here.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createSessionRecorderControls } from '../../src/labs/session-recorder-controls.js';
import {
  createDenBossTransitionTracker,
  type DenBossDiagnostics,
  type DenBossSnapshot,
} from '../../src/game/ai/den-boss-telemetry.js';
import { isDenSimEvent, type SimEvent } from '../../src/game/ai/event-log.js';
import { collectHumanRunStats } from '../../src/game/ai/run-stats-collector.js';
import type { InputState } from '../../src/shared/input.js';
import { createFloor2DenFixture, driveDenLifecycle } from '../helpers/floor2-den-fixture.js';

const NO_INPUT: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };

/** Serialize → parse, mirroring what a downloaded `.jsonl` recording contains. */
function denRecordsFromJsonl(jsonl: string): SimEvent[] {
  return jsonl
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SimEvent)
    .filter(isDenSimEvent);
}

/**
 * Reduce a recording's `den` records to the same per-family lifecycle shape the
 * headless rollup reports, so the two can be compared directly.
 */
function lifecycleFromRecords(records: readonly SimEvent[]): Map<string, LifecycleEvidence> {
  const byFamily = new Map<string, LifecycleEvidence>();
  for (const record of records) {
    const payload = record.denBoss!;
    for (const den of payload.dens) {
      const existing = byFamily.get(den.familyId) ?? {
        transitions: [],
        lastKnownBossEid: null,
        final: den,
      };
      existing.final = den;
      if (den.lastKnownBossEid !== null) existing.lastKnownBossEid = den.lastKnownBossEid;
      byFamily.set(den.familyId, existing);
    }
    if (payload.kind !== 'snapshot' && payload.familyId !== null) {
      byFamily.get(payload.familyId)!.transitions.push(payload.kind);
    }
  }
  return byFamily;
}

interface LifecycleEvidence {
  transitions: string[];
  lastKnownBossEid: number | null;
  final: DenBossSnapshot;
}

function lifecycleFromDiagnostics(diagnostics: DenBossDiagnostics): Map<string, LifecycleEvidence> {
  const byFamily = new Map<string, LifecycleEvidence>();
  for (const [familyId, family] of Object.entries(diagnostics.families)) {
    byFamily.set(familyId, {
      transitions: diagnostics.transitions
        .filter((transition) => transition.familyId === familyId)
        .map((transition) => transition.kind),
      lastKnownBossEid: family.lastKnownBossEid,
      final: family.final,
    });
  }
  return byFamily;
}

describe('den-boss telemetry contract — cross-path equivalence', () => {
  it('the real game recorder records den evidence in its downloadable JSONL', () => {
    const options = createFloorMainSceneOptions('floor2');
    expect(options.sessionRecorderFactory).toBeDefined();
    const fixture = createFloor2DenFixture();
    const recorder = options.sessionRecorderFactory!(fixture.world, fixture.playerEid);
    driveDenLifecycle(fixture, () => recorder.tick(NO_INPUT));

    const records = denRecordsFromJsonl(recorder.toJsonl!());
    expect(records.length).toBeGreaterThan(0);
    const evidence = lifecycleFromRecords(records).get(fixture.encounter.familyId)!;
    expect(evidence.transitions).toContain('baseline');
    expect(evidence.transitions).toContain('den-unlocked');
    expect(evidence.transitions).toContain('encounter-started');
    expect(evidence.transitions).toContain('boss-left-den');
    expect(evidence.transitions).toContain('encounter-defeated');
    // AC3 — a sealed-room boss is diagnosable straight from the download.
    expect(evidence.final.denDoorsTotal).toBeGreaterThan(0);
    expect(typeof evidence.final.denSealed).toBe('boolean');
    expect(typeof evidence.final.bossInDen).toBe('boolean');
    expect(typeof evidence.final.bossVisible).toBe('boolean');
    expect(evidence.lastKnownBossEid).not.toBeNull();
  });

  it('the AI Runner lab recorder records the identical den evidence', () => {
    const controls = createSessionRecorderControls({ initialController: 'AI' });
    try {
      const gameFixture = createFloor2DenFixture();
      const gameRecorder = createFloorMainSceneOptions('floor2').sessionRecorderFactory!(
        gameFixture.world,
        gameFixture.playerEid,
      );
      driveDenLifecycle(gameFixture, () => gameRecorder.tick(NO_INPUT));

      const labFixture = createFloor2DenFixture();
      const labRecorder = controls.factory(labFixture.world, labFixture.playerEid);
      driveDenLifecycle(labFixture, () => labRecorder.tick(NO_INPUT));

      const gameEvidence = lifecycleFromRecords(denRecordsFromJsonl(gameRecorder.toJsonl!()));
      const labEvidence = lifecycleFromRecords(denRecordsFromJsonl(labRecorder.toJsonl!()));

      expect([...labEvidence.keys()].sort()).toEqual([...gameEvidence.keys()].sort());
      for (const [familyId, lab] of labEvidence) {
        const game = gameEvidence.get(familyId)!;
        expect(lab.transitions).toEqual(game.transitions);
        expect(lab.final).toEqual(game.final);
      }
    } finally {
      controls.destroy();
    }
  });

  it('the headless RunStats rollup matches the recording, field for field', () => {
    // Surface A — the shared tracker, exactly as `runHeadless` polls it.
    const headlessFixture = createFloor2DenFixture();
    const tracker = createDenBossTransitionTracker();
    driveDenLifecycle(headlessFixture, (frame) => {
      tracker.poll(headlessFixture.world, frame, headlessFixture.playerEid);
    });
    const headless = lifecycleFromDiagnostics(tracker.getDiagnostics()!);

    // Surface B — the interactive session recording.
    const recorderFixture = createFloor2DenFixture();
    const recorder = createFloorMainSceneOptions('floor2').sessionRecorderFactory!(
      recorderFixture.world,
      recorderFixture.playerEid,
    );
    driveDenLifecycle(recorderFixture, () => recorder.tick(NO_INPUT));
    const recorded = lifecycleFromRecords(denRecordsFromJsonl(recorder.toJsonl!()));

    expect([...recorded.keys()].sort()).toEqual([...headless.keys()].sort());
    for (const [familyId, recordedEvidence] of recorded) {
      const headlessEvidence = headless.get(familyId)!;
      expect(recordedEvidence.transitions).toEqual(headlessEvidence.transitions);
      expect(recordedEvidence.lastKnownBossEid).toEqual(headlessEvidence.lastKnownBossEid);
      // Snapshot fields are sampled at whatever frame each surface last emitted
      // on, so compare the schema shape here and the exact values via the
      // rollup below (which both surfaces refresh every frame).
      expect(Object.keys(recordedEvidence.final).sort()).toEqual(
        Object.keys(headlessEvidence.final).sort(),
      );
    }
    // The rollups themselves must be byte-identical: same tracker, same frames.
    expect(recorder.getStats().denBoss).toEqual(tracker.getDiagnostics());
  });

  it('the human RunStats carries the same rollup contract as the headless runner (AC4)', () => {
    const fixture = createFloor2DenFixture();
    const recorder = createFloorMainSceneOptions('floor2').sessionRecorderFactory!(
      fixture.world,
      fixture.playerEid,
    );
    driveDenLifecycle(fixture, () => recorder.tick(NO_INPUT));

    const stats = collectHumanRunStats(
      fixture.world,
      fixture.playerEid,
      'quit',
      0,
      recorder.getStats(),
    );
    const denBoss = stats.denBoss;
    expect(denBoss).toBeDefined();
    // The rollup names the event stream it can be joined against.
    expect(denBoss!.eventStreamType).toBe('den');
    expect(denBoss!.transitionCount).toBeGreaterThan(0);

    const family = denBoss!.families[fixture.encounter.familyId]!;
    expect(family.encounterStartedMs).not.toBeNull();
    expect(family.encounterDefeatedMs).not.toBeNull();
    expect(family.lastKnownBossEid).not.toBeNull();
    expect(family.final.denRoomId).toBe(fixture.encounter.roomId);
  });

  it('costs nothing on a floor without dens', () => {
    const options = createFloorMainSceneOptions('floor1');
    const fixture = createFloor2DenFixture();
    // Strip the den state so the world looks like a non-den floor.
    fixture.world.floorExtendedState = null;
    const recorder = options.sessionRecorderFactory!(fixture.world, fixture.playerEid);
    for (let i = 0; i < 120; i += 1) {
      recorder.tick(NO_INPUT);
    }
    expect(denRecordsFromJsonl(recorder.toJsonl!())).toHaveLength(0);
    expect(recorder.getStats().denBoss).toBeUndefined();
  });
});
