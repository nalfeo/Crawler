/**
 * Official headless Floor 4 completion gate — the "must be beatable" contract
 * for the canonical deterministic seed 404.
 *
 * Answers a narrower, non-balance question than the win-rate gates: **can the
 * production `BehaviorTreeAI` still finish Floor 4 end-to-end**, direct-start,
 * on the one seed the `floor-4-playable-completion` epic names as the
 * acceptance seed? Floor 4's manifest marks `implemented.mvp: false`
 * (`src/shared/data/floors/floor4.manifest.json`), so it is deliberately
 * excluded from the sampled win-rate/sweep gates (`ai:winrate-sweep`) — this
 * test is the seed-404 completion contract instead, per
 * `.specify/specs/floor4-playable-completion.md`.
 *
 * Drives the same pure-ECS `runHeadless` pipeline the CLI
 * (`npm run ai:headless -- --seed 404 --floor floor4`) and the in-browser
 * AI-runner lab use — no Phaser, no DOM — with the real production
 * `BehaviorTreeAI`.
 *
 * This is the **headless half of the slice-1 acceptance contract**; every
 * assertion below is tagged with its criterion id (`C1`..`C8`) from the
 * contract table in `.specify/specs/floor4-playable-completion.md`, and the
 * visual half asserts the same ids in
 * `tests/e2e/floor4-ai-completion.deterministic.test.ts`. Keep the tags and
 * the table in sync — the table is the mapping of record.
 *
 * Intermissions and the terminal exit are now public interaction gates: the
 * production AI must physically route to the authored Green Room and invoke the
 * same scenario confirmations exposed to the visual presentation layer.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  FLOOR4_ACTS,
  FLOOR4_GREEN_ROOM_EXIT_REASON,
  FLOOR4_STALL_BACKSTOP_MS,
  FLOOR4_TERMINAL_EXIT_REASON,
  FLOOR4_TOTAL_WAVES_RELEASED,
} from '../helpers/floor4-completion-contract.js';

/**
 * The canonical deterministic seed the `floor-4-playable-completion` epic
 * names as the acceptance seed for both the headless and visual runners.
 */
const CANONICAL_SEED = 404;

/**
 * Frame budget for a Floor 4 completion run. A full 5-act clear on seed 404
 * takes ~608s of simulated game time (~36.5k frames at 60fps); this leaves a
 * comfortable margin above that observed baseline without ballooning the
 * losing-run wall-time cost (see `floor1-completion.test.ts`'s equivalent
 * comment for why this must stay a game-time-bounded cap, not a low guess).
 */
const MAX_FRAMES = 60_000;

/** Generous wall-time cap; game-time assertions below are what actually gate correctness. */
const MAX_WALL_TIME_MS = 180_000;

/**
 * The ordered list of acts a given phase kind was entered for, per the arena
 * director's own phase timeline. Used to prove each act really cycled through
 * WAVES → HEADLINE → INTERMISSION rather than inferring it from a counter.
 */
function phaseActs(
  timeline: NonNullable<RunStats['floor4Arena']>['timeline'],
  kind: string,
): number[] {
  return timeline
    .filter((entry) => entry.phase.kind === kind)
    .map((entry) => (entry.phase as { act?: number }).act)
    .filter((act): act is number => typeof act === 'number');
}

async function runFloor4(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ ...getPersonaConfig('experienced_player'), seed });
  return runHeadless(ai, {
    seed,
    floorId: 'floor4',
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: MAX_WALL_TIME_MS,
    playerPersona: 'experienced_player',
  });
}

describe('Floor 4 headless completion gate (seed 404)', () => {
  // Shared across the "completes" test and the isolated C5 characterization
  // below so the second test doesn't need to pay for another ~36.5k-frame
  // headless run of the same canonical seed.
  let stats: RunStats;

  beforeAll(async () => {
    stats = await runFloor4(CANONICAL_SEED);
  });

  it('completes: production BehaviorTreeAI reaches VICTORY with genuine wave/Headliner combat', () => {
    const arena = stats.floor4Arena;

    expect(arena, 'run produced no floor4Arena telemetry at all').toBeDefined();
    const telemetryFailure =
      `outcome=${stats.outcome} phase=${JSON.stringify(arena?.phase)} ` +
      `frames=${stats.totalFrames} gameTimeMs=${stats.gameTimeMs}`;

    // C1 — the standard Floor 4 scenario initialized: the arena director's own
    // first timeline entry is the authored COUNTDOWN opener, and the authored
    // five-Headliner card is loaded. Nothing below is meaningful if the floor
    // never really started.
    const timeline = arena!.timeline;
    expect(timeline[0]?.phase.kind, telemetryFailure).toBe('COUNTDOWN');
    expect(timeline[0]?.reason, telemetryFailure).toBe('floor4-initialized');
    expect(
      arena!.headlinerCard.map((entry) => entry.act),
      telemetryFailure,
    ).toEqual([...FLOOR4_ACTS]);

    // C2 — real physical hostiles spawned through the authored feed-gate path.
    // Not a cherry-picked kill count: it's the "did anything actually happen"
    // floor the epic's slice 1 baseline exists to check.
    expect(arena!.waveTelemetry.enemiesSpawned, telemetryFailure).toBeGreaterThan(0);
    expect(arena!.waveTelemetry.gateTelegraphsArmed, telemetryFailure).toBeGreaterThan(0);
    // C3 — all five wave windows opened AND released every authored wave.
    // `wavesReleased` is cumulative across acts, so a bare lower bound (e.g.
    // ">= 5") would also pass if act 1 alone released 5+ waves and acts 2-5
    // released none. Compare against the manifest-derived full-release
    // ceiling instead: each act can release at most `FLOOR4_WAVES_PER_ACT`
    // waves, so reaching the five-act total requires every act to release
    // every one of its waves.
    expect(arena!.waveTelemetry.wavesReleased, telemetryFailure).toBe(FLOOR4_TOTAL_WAVES_RELEASED);
    expect(phaseActs(timeline, 'WAVES'), telemetryFailure).toEqual([...FLOOR4_ACTS]);
    // C4 — all five Headliners physically spawned and were defeated through
    // ordinary combat (not force-resolved — `resolveFloor4HeadlinerDefeat`
    // only marks `defeated` on a genuine health-zero kill, and
    // `overtimeStarted` staying zero shows no out-of-band finisher ran).
    expect(arena!.headlinerTelemetry.spawned, telemetryFailure).toBe(5);
    expect(arena!.headlinerTelemetry.defeated, telemetryFailure).toBe(5);
    expect(arena!.headlinerTelemetry.chestsForceResolved, telemetryFailure).toBe(0);
    expect(arena!.headlinerTelemetry.overtimeStarted, telemetryFailure).toBe(0);
    expect(phaseActs(timeline, 'HEADLINE'), telemetryFailure).toEqual([...FLOOR4_ACTS]);

    // C5 — every act's intermission was entered, banked its act income, and
    // resolved through the public Green Room / terminal exit confirmations.
    expect(phaseActs(timeline, 'INTERMISSION'), telemetryFailure).toEqual([...FLOOR4_ACTS]);
    expect(
      arena!.actIncome.map((entry) => entry.act),
      telemetryFailure,
    ).toEqual([...FLOOR4_ACTS]);
    const intermissionExitReasons = timeline
      .map((entry, index) =>
        timeline[index - 1]?.phase.kind === 'INTERMISSION' ? entry.reason : undefined,
      )
      .filter((reason): reason is string => reason !== undefined);
    expect(intermissionExitReasons, telemetryFailure).toHaveLength(5);
    expect(intermissionExitReasons, telemetryFailure).toEqual([
      FLOOR4_GREEN_ROOM_EXIT_REASON,
      FLOOR4_GREEN_ROOM_EXIT_REASON,
      FLOOR4_GREEN_ROOM_EXIT_REASON,
      FLOOR4_GREEN_ROOM_EXIT_REASON,
      FLOOR4_TERMINAL_EXIT_REASON,
    ]);

    // C6 — the phase trace actually reached the terminal VICTORY phase.
    expect(arena!.phase.kind, telemetryFailure).toBe('VICTORY');
    expect(timeline[timeline.length - 1]?.phase.kind, telemetryFailure).toBe('VICTORY');
    // C7 — and the run-level outcome agrees.
    expect(stats.outcome, telemetryFailure).toBe('victory');

    // C8 — terminates under the real stall backstop: game time stayed well
    // inside `floor4ObjectiveTick`'s raw-elapsed deadline (observed baseline
    // ~608s against a 3600s backstop), and the run did not grind out the test
    // frame cap because something silently stalled.
    expect(stats.gameTimeMs, telemetryFailure).toBeLessThan(FLOOR4_STALL_BACKSTOP_MS);
    expect(stats.totalFrames, telemetryFailure).toBeLessThan(MAX_FRAMES);
  });

  it('is deterministic: an identical seed produces byte-identical completion telemetry', async () => {
    const first = await runFloor4(CANONICAL_SEED);
    const second = await runFloor4(CANONICAL_SEED);

    expect(second.outcome).toBe(first.outcome);
    expect(second.totalFrames).toBe(first.totalFrames);
    expect(second.gameTimeMs).toBe(first.gameTimeMs);
    expect(second.floor4Arena?.phase).toEqual(first.floor4Arena?.phase);
    expect(second.floor4Arena?.waveTelemetry).toEqual(first.floor4Arena?.waveTelemetry);
    expect(second.floor4Arena?.headlinerTelemetry).toEqual(first.floor4Arena?.headlinerTelemetry);
    expect(second.floor4Arena?.timeline).toEqual(first.floor4Arena?.timeline);
  });
});
