import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { isDenSimEvent, type SimEvent } from '../../src/game/ai/event-log.js';
import { DEN_BOSS_TELEMETRY_SCHEMA_VERSION } from '../../src/shared/den-boss-telemetry-types.js';

/**
 * Wiring proof for the unified den-boss telemetry contract (issue #3093) on the
 * REAL headless pipeline: `runHeadless` must poll the shared collector every
 * frame, emit `den` records into the event stream, and roll the result up onto
 * `RunStats` so a sealed-den softlock is diagnosable from a run's artifacts
 * alone.
 */
describe('Floor 2 den-boss telemetry — real headless pipeline', () => {
  it('emits den events and a RunStats rollup for a Floor 2 run', async () => {
    const events: SimEvent[] = [];
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor2',
      maxFrames: 5,
      recordEvent: (event: SimEvent) => events.push(event),
    });

    const denEvents = events.filter(isDenSimEvent);
    expect(denEvents.length).toBeGreaterThan(0);
    for (const event of denEvents) {
      expect(event.denBoss.schemaVersion).toBe(DEN_BOSS_TELEMETRY_SCHEMA_VERSION);
      expect(event.denBoss.dens.length).toBeGreaterThan(0);
    }

    const denBoss = stats.denBoss;
    expect(denBoss).toBeDefined();
    expect(denBoss!.schemaVersion).toBe(DEN_BOSS_TELEMETRY_SCHEMA_VERSION);
    // AC4 — the rollup names the event stream it can be joined against.
    expect(denBoss!.eventStreamType).toBe('den');
    expect(Object.keys(denBoss!.families).length).toBeGreaterThan(0);

    // Every den the rollup knows about was also announced on the event stream,
    // so the two artifacts can be cross-referenced without source tracing.
    const streamFamilies = new Set(
      denEvents.flatMap((event) => event.denBoss.dens.map((den) => den.familyId)),
    );
    for (const familyId of Object.keys(denBoss!.families)) {
      expect(streamFamilies.has(familyId)).toBe(true);
    }

    for (const family of Object.values(denBoss!.families)) {
      expect(family.final.denRoomId).toBeGreaterThanOrEqual(0);
      expect(family.final.denDoorsTotal).toBeGreaterThanOrEqual(0);
      expect(typeof family.final.denSealed).toBe('boolean');
      expect(typeof family.final.bossInDen).toBe('boolean');
    }
  });

  it('leaves RunStats untouched on a floor without dens', async () => {
    const stats = await runHeadless(new BehaviorTreeAI({ seed: 42 }), {
      seed: 42,
      floorId: 'floor1',
      maxFrames: 5,
    });
    expect(stats.denBoss).toBeUndefined();
  });
});
