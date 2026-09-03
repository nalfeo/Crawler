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
 * `BehaviorTreeAI`, asserting:
 *
 *   - the arena director's real feed-gate wave path spawns physical hostiles
 *     (`waveTelemetry.enemiesSpawned > 0`),
 *   - all five wave windows release at least one wave
 *     (`waveTelemetry.wavesReleased >= 5`),
 *   - all five Headliners physically spawn and are defeated through ordinary
 *     combat (`headlinerTelemetry.spawned === 5 && defeated === 5`),
 *   - the phase trace reaches `VICTORY`,
 *   - `RunStats.outcome === 'victory'`,
 *   - the run terminates well inside the Floor 4 stall backstop, and
 *   - re-running the identical seed produces byte-identical completion
 *     telemetry (determinism, AGENTS.md r1).
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

    // Real physical hostiles spawned through the authored feed-gate path —
    // this is not a cherry-picked kill count, it's the "did anything actually
    // happen" floor the epic's slice 1 baseline exists to check.
    expect(arena!.waveTelemetry.enemiesSpawned, telemetryFailure).toBeGreaterThan(0);
    // All five wave windows released at least one wave.
    expect(arena!.waveTelemetry.wavesReleased, telemetryFailure).toBeGreaterThanOrEqual(5);
    // All five Headliners physically spawned and were defeated in ordinary
    // combat (not force-resolved — `resolveFloor4HeadlinerDefeat` only marks
    // `defeated` on a genuine health-zero kill).
    expect(arena!.headlinerTelemetry.spawned, telemetryFailure).toBe(5);
    expect(arena!.headlinerTelemetry.defeated, telemetryFailure).toBe(5);
    // The phase trace actually reached the terminal VICTORY phase.
    expect(arena!.phase.kind, telemetryFailure).toBe('VICTORY');
    // And the run-level outcome agrees.
    expect(stats.outcome, telemetryFailure).toBe('victory');

    // Terminates well inside the Floor 4 stall backstop (observed baseline
    // ~608s / ~36.5k frames; this just proves it isn't grinding to the frame
    // cap because something silently stalled).
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
