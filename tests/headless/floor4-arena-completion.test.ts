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
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';

/**
 * The canonical deterministic seed the `floor-4-playable-completion` epic
 * names as the acceptance seed for both the headless and visual runners.
 */
const CANONICAL_SEED = 404;

/**
 * The real Floor 4 stall backstop (FR8.4): `floor4ObjectiveTick` flips the run
 * to `game_over` with the `floor4-stall-backstop` goal flag once raw
 * `world.elapsedMs` reaches the manifest timer. Read from the manifest rather
 * than hardcoded so retuning the backstop retunes this gate with it.
 */
const STALL_BACKSTOP_MS = getFloorManifest('floor4')?.timer?.durationMs ?? 0;

/** The five authored acts, in order. */
const ACTS = [1, 2, 3, 4, 5] as const;

/**
 * Phase-transition reasons the arena director currently uses to leave an
 * `INTERMISSION`. Both are the shared timer-driven auto-advance documented as
 * the open C5 shortfall in `.specify/specs/floor4-playable-completion.md`; the
 * Green Room slice that replaces them with a real public interaction must
 * update this list (and the contract table) deliberately.
 */
const AUTO_INTERMISSION_EXIT_REASONS = ['slice2-auto-green-room-exit', 'slice2-auto-stairs'];

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
  it('completes: production BehaviorTreeAI reaches VICTORY with genuine wave/Headliner combat', async () => {
    const stats = await runFloor4(CANONICAL_SEED);
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
    ).toEqual([...ACTS]);

    // C2 — real physical hostiles spawned through the authored feed-gate path.
    // Not a cherry-picked kill count: it's the "did anything actually happen"
    // floor the epic's slice 1 baseline exists to check.
    expect(arena!.waveTelemetry.enemiesSpawned, telemetryFailure).toBeGreaterThan(0);
    expect(arena!.waveTelemetry.gateTelegraphsArmed, telemetryFailure).toBeGreaterThan(0);
    // C3 — all five wave windows opened and released at least one wave each.
    expect(arena!.waveTelemetry.wavesReleased, telemetryFailure).toBeGreaterThanOrEqual(5);
    expect(phaseActs(timeline, 'WAVES'), telemetryFailure).toEqual([...ACTS]);
    // C4 — all five Headliners physically spawned and were defeated through
    // ordinary combat (not force-resolved — `resolveFloor4HeadlinerDefeat`
    // only marks `defeated` on a genuine health-zero kill, and
    // `overtimeStarted` staying zero shows no out-of-band finisher ran).
    expect(arena!.headlinerTelemetry.spawned, telemetryFailure).toBe(5);
    expect(arena!.headlinerTelemetry.defeated, telemetryFailure).toBe(5);
    expect(arena!.headlinerTelemetry.overtimeStarted, telemetryFailure).toBe(0);
    expect(phaseActs(timeline, 'HEADLINE'), telemetryFailure).toEqual([...ACTS]);

    // C5 — every act's intermission was entered AND resolved (each has a
    // successor timeline entry) and banked its act income.
    //
    // NOTE (recorded slice-1 shortfall): resolution is currently the arena
    // director's shared phase timer, not a public Green Room/stairs
    // interaction. That is asserted explicitly below so the gap is visible in
    // the gate itself rather than only in prose.
    expect(phaseActs(timeline, 'INTERMISSION'), telemetryFailure).toEqual([...ACTS]);
    expect(
      arena!.actIncome.map((entry) => entry.act),
      telemetryFailure,
    ).toEqual([...ACTS]);
    const intermissionExitReasons = timeline
      .map((entry, index) =>
        timeline[index - 1]?.phase.kind === 'INTERMISSION' ? entry.reason : undefined,
      )
      .filter((reason): reason is string => reason !== undefined);
    expect(intermissionExitReasons, telemetryFailure).toHaveLength(5);
    for (const reason of intermissionExitReasons) {
      expect(AUTO_INTERMISSION_EXIT_REASONS, telemetryFailure).toContain(reason);
    }

    // C6 — the phase trace actually reached the terminal VICTORY phase.
    expect(arena!.phase.kind, telemetryFailure).toBe('VICTORY');
    expect(timeline[timeline.length - 1]?.phase.kind, telemetryFailure).toBe('VICTORY');
    // C7 — and the run-level outcome agrees.
    expect(stats.outcome, telemetryFailure).toBe('victory');

    // C8 — terminates under the real stall backstop: game time stayed well
    // inside `floor4ObjectiveTick`'s raw-elapsed deadline (observed baseline
    // ~608s against a 3600s backstop), and the run did not grind out the test
    // frame cap because something silently stalled.
    expect(STALL_BACKSTOP_MS, 'floor4 manifest has no timer').toBeGreaterThan(0);
    expect(stats.gameTimeMs, telemetryFailure).toBeLessThan(STALL_BACKSTOP_MS);
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
