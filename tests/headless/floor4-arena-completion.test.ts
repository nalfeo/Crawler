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
 * ## What this test does NOT claim
 *
 * Floor 4's intermission-to-next-act and final-stairs transitions are
 * currently driven by `arenaDirectorSystem`'s own phase timer
 * (`'slice2-auto-green-room-exit'` / `'slice2-auto-stairs'` in the phase
 * timeline) rather than a per-decision AI interaction with a physical Green
 * Room exit or stairs prop — see the code comment on `arenaDirectorSystem`'s
 * `INTERMISSION` case and `.specify/specs/floor4-arena.md`'s slice table
 * ("slice 5 — Green Room" is the real transaction slice, not yet built).
 * That auto-advance is identical in both headless and the visual AI-runner
 * (it lives in the shared `src/game/floor4Scenario.ts`, not a headless-only
 * or lab-only special case — see slice-2's runtime-parity requirement in the
 * epic), so it is not a *runner-only* shortcut, but it is not yet the
 * "resolves through its public scenario/UI interaction" contract slice 1 of
 * the epic ultimately wants either. This test asserts the current, honest
 * behavior (waves and Headliners are genuine combat; intermission/stairs
 * advance on a shared timer) rather than a stronger claim this session did
 * not implement. See the handoff for the full gap analysis.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  FLOOR4_ACTS,
  FLOOR4_AUTO_INTERMISSION_EXIT_REASONS,
  FLOOR4_STALL_BACKSTOP_MS,
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
    expect(arena!.headlinerTelemetry.overtimeStarted, telemetryFailure).toBe(0);
    expect(phaseActs(timeline, 'HEADLINE'), telemetryFailure).toEqual([...FLOOR4_ACTS]);

    // C5 — partially met (see the dedicated shortfall test below for the
    // gap): every act's intermission was entered AND resolved (each has a
    // successor timeline entry) and banked its act income.
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

  // C5 (not yet met) — isolated as an expected-failure characterization
  // rather than folded into the "completes" test above, so nothing here can
  // be mistaken for evidence the criterion passes. `FLOOR4_AUTO_INTERMISSION_
  // EXIT_REASONS` is the shared-timer allowlist; the criterion's actual bar
  // is that at least one intermission resolves for a reason OUTSIDE that
  // allowlist (a real Green Room/stairs interaction). Today every exit is in
  // the allowlist, so the inner assertion fails — `it.fails` records that as
  // the expected, documented result. Once a future slice adds the real
  // interaction, the inner assertion starts passing, which flips `it.fails`
  // into an *unexpected* pass and breaks this test — forcing whoever ships
  // that slice to drop `.fails` here and flip the C5 row in the spec table
  // to "met" in the same change. Reuses the same shared `stats` from
  // `beforeAll` rather than driving a second full headless run.
  it.fails(
    'C5: intermissions resolve through a public scenario/UI interaction, not the shared arena-director timer',
    () => {
      const timeline = stats.floor4Arena!.timeline;
      const intermissionExitReasons = timeline
        .map((entry, index) =>
          timeline[index - 1]?.phase.kind === 'INTERMISSION' ? entry.reason : undefined,
        )
        .filter((reason): reason is string => reason !== undefined);
      expect(
        intermissionExitReasons.some(
          (reason) => !FLOOR4_AUTO_INTERMISSION_EXIT_REASONS.includes(reason),
        ),
      ).toBe(true);
    },
  );

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
