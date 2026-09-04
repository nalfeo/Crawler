/**
 * Floor 3 dual-runner acceptance gate — the visual half of the
 * `floor-3-ai-runner-completion` epic's `dual-runner-acceptance` slice.
 *
 * Unlike `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
 * (whose own narrower contract only requires every blocking Floor 3 surface
 * to resolve through its real callback and the run to survive ≥10 simulated
 * seconds outside the spawn room — and which force-finishes the run with the
 * debug-only `window.__aiRunnerJumpToStairs()` teleport once every other
 * surface is confirmed), this test asserts the FULL production completion
 * contract with **no debug hooks of any kind**: the AI must navigate itself
 * to the real exit and confirm the descent from real interaction range,
 * exactly like `tests/headless/floor3-completion.test.ts` already does.
 *
 * Both this test and the headless gate import the same fixed seed (3539)
 * and `startPlayerLevel` (20) from `tests/helpers/floor3-completion-contract.ts`
 * — "one committed deterministic seed shared by both runners" is enforced by
 * import, not by two independently-typed literals that could silently drift.
 *
 * This test drives the real shipped `ai-runner` lab (`MainGameScene`,
 * `PhaserBridge`, production `BehaviorTreeAI`) through only its public
 * controls — the floor/seed query params and the speed/run-toggle buttons —
 * then polls the lab's own `window.__aiRunnerDebug()` telemetry until
 * `runOutcome === 'cleared_floor'` (the same `floorScenario.runSummary`
 * field the headless gate's `runHeadless` maps to `RunStats.outcome ===
 * 'victory'` — see `scenario.getRunOutcome`/`finalizeRunSummary` in
 * `src/game/floorScenario.ts` and the `cleared_floor` check in
 * `src/game/ai/headless-runner.ts`). No gameplay keys, clicks, or direct
 * scene/world/ECS mutation are ever supplied after the run starts.
 *
 * Passing this one seed proves possibility only — it is NOT a win-rate or
 * broad-balance claim, and no other seeds are asserted here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import type { AiRunnerDebugSnapshot } from '../../src/labs/ai-runner-lab/index.js';
import {
  FLOOR3_COMPLETION_SEED,
  FLOOR3_COMPLETION_START_PLAYER_LEVEL,
  FLOOR3_MIN_ALIVE_OUTSIDE_SPAWN_MS,
  FLOOR3_REQUIRED_SURFACE_SEQUENCE,
  FLOOR3_SURFACE_EXPECTED_COUNTS,
  type Floor3SurfaceKind,
} from '../helpers/floor3-completion-contract.js';

const LAB_URL =
  `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner&floor=floor3` +
  `&seed=${FLOOR3_COMPLETION_SEED}&startPlayerLevel=${FLOOR3_COMPLETION_START_PLAYER_LEVEL}`;

/** Restart-to-first-poll settle delay, matching the sibling Floor 3/4 gates. */
const FAST_RESTART_SETTLE_MS = 300;
/** Poll cadence while waiting for the real production victory outcome. */
const POLL_INTERVAL_MS = 1_500;
/**
 * Generous poll ceiling: the headless baseline reaches victory at frame
 * 44,493 (~741s game time); at 16x playback that is well under 60s of wall
 * time for frame progression alone, but modal confirmations and rendering
 * overhead add real wall-clock cost, so this budgets well past that floor
 * (matches the sibling dialog-autonomy test's generous ceiling).
 */
const MAX_POLLS = 280;

type SurfaceEvent = AiRunnerDebugSnapshot['floor3SurfaceTrace'][number];

async function loadAiRunner(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#ai-playback-dock', { timeout: 45_000 });
}

async function readSnapshot(page: Page): Promise<AiRunnerDebugSnapshot | null> {
  const snapshot = await page.evaluate(
    () => (window as { __aiRunnerDebug?: () => unknown }).__aiRunnerDebug?.() ?? null,
  );
  return snapshot as AiRunnerDebugSnapshot | null;
}

function firstEventIndex(
  trace: readonly SurfaceEvent[],
  kind: Floor3SurfaceKind,
  action: 'opened' | 'confirmed',
): number {
  return trace.findIndex((entry) => entry.kind === kind && entry.action === action);
}

function eventCount(
  trace: readonly SurfaceEvent[],
  kind: Floor3SurfaceKind,
  action: 'opened' | 'confirmed',
): number {
  return trace.filter((entry) => entry.kind === kind && entry.action === action).length;
}

describe('Floor 3 dual-runner acceptance gate: visual production completion (seed 3539, no shortcuts)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it(
    "reaches the real production Floor 3 victory/exit outcome through the AI's own navigation, " +
      'with every blocking surface acknowledged and no debug/teleport hooks',
    async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      try {
        await loadAiRunner(page);
        await page.waitForTimeout(FAST_RESTART_SETTLE_MS);
        await page.click('#ai-speed-16');
        await page.click('#ai-toggle-run');

        const snapshots: AiRunnerDebugSnapshot[] = [];
        let lastSnapshot: AiRunnerDebugSnapshot | null = null;

        for (let poll = 0; poll < MAX_POLLS; poll += 1) {
          await page.waitForTimeout(POLL_INTERVAL_MS);
          if (pageErrors.length > 0) break;
          const snapshot = await readSnapshot(page);
          if (!snapshot) continue;
          snapshots.push(snapshot);
          lastSnapshot = snapshot;
          if (snapshot.runOutcome === 'cleared_floor') break;
        }

        expect(pageErrors).toEqual([]);
        expect(lastSnapshot).not.toBeNull();

        const trace = lastSnapshot!.floor3SurfaceTrace;
        const traceCounts = Object.fromEntries(
          Array.from(new Set(trace.map((entry) => `${entry.kind}:${entry.action}`))).map((key) => [
            key,
            trace.filter((entry) => `${entry.kind}:${entry.action}` === key).length,
          ]),
        );
        const context = JSON.stringify({
          frame: lastSnapshot!.frame,
          worldState: lastSnapshot!.worldState,
          health: lastSnapshot!.health,
          runOutcome: lastSnapshot!.runOutcome,
          aliveOutsideStreakMs: lastSnapshot!.floor3MaxAliveOutsideSpawnStreakMs,
          reason: lastSnapshot!.reason,
          target: { x: lastSnapshot!.targetX, y: lastSnapshot!.targetY },
          player: { x: lastSnapshot!.px, y: lastSnapshot!.py },
          traceCounts,
        });

        // The real production victory/exit outcome (`cleared_floor`) —
        // reached by the AI's own navigation, not asserted via any
        // mocked/forced completion. This is the same field headless
        // `runHeadless` maps to `RunStats.outcome === 'victory'`.
        expect(lastSnapshot!.runOutcome, context).toBe('cleared_floor');

        // Every required Floor 3 surface opened AND was acknowledged through
        // its real callback, in the documented order.
        for (const kind of FLOOR3_REQUIRED_SURFACE_SEQUENCE) {
          expect(
            firstEventIndex(trace, kind, 'opened'),
            `missing opened event for ${kind}; ${context}`,
          ).toBeGreaterThan(-1);
          expect(
            firstEventIndex(trace, kind, 'confirmed'),
            `missing confirmed event for ${kind}; ${context}`,
          ).toBeGreaterThan(-1);
        }
        for (const [kind, expectedCount] of Object.entries(FLOOR3_SURFACE_EXPECTED_COUNTS) as [
          Floor3SurfaceKind,
          number,
        ][]) {
          expect(eventCount(trace, kind, 'opened'), `${kind} opened count; ${context}`).toBe(
            expectedCount,
          );
          expect(eventCount(trace, kind, 'confirmed'), `${kind} confirmed count; ${context}`).toBe(
            expectedCount,
          );
        }
        for (let i = 1; i < FLOOR3_REQUIRED_SURFACE_SEQUENCE.length; i += 1) {
          const previous = FLOOR3_REQUIRED_SURFACE_SEQUENCE[i - 1]!;
          const current = FLOOR3_REQUIRED_SURFACE_SEQUENCE[i]!;
          expect(
            firstEventIndex(trace, previous, 'opened'),
            `${previous} should open before ${current}; ${context}`,
          ).toBeLessThan(firstEventIndex(trace, current, 'opened'));
          expect(
            firstEventIndex(trace, previous, 'confirmed'),
            `${previous} should confirm before ${current}; ${context}`,
          ).toBeLessThan(firstEventIndex(trace, current, 'confirmed'));
        }

        // Simulation genuinely resumed (no lingering modal, world back to
        // 'playing') after every non-terminal confirmation.
        for (const event of trace.filter(
          (entry) => entry.action === 'confirmed' && entry.kind !== 'floor3-stair-descend',
        )) {
          const resumeSample = snapshots.find(
            (sample) =>
              typeof sample.gameMs === 'number' &&
              typeof event.gameMs === 'number' &&
              sample.gameMs > event.gameMs &&
              sample.modalOpen === false &&
              sample.worldState === 'playing',
          );
          expect(
            Boolean(resumeSample),
            `simulation did not resume after ${event.kind} at ${event.gameMs}ms; ${context}`,
          ).toBe(true);
        }

        // Left the protected spawn room and stayed alive/simulating outside
        // it for the required minimum streak.
        const leftSpawn = snapshots.some((sample) => sample.inSpawnRoom === false);
        expect(leftSpawn, context).toBe(true);
        expect(lastSnapshot!.floor3MaxAliveOutsideSpawnStreakMs, context).toBeGreaterThanOrEqual(
          FLOOR3_MIN_ALIVE_OUTSIDE_SPAWN_MS,
        );
      } finally {
        await closeQuietly(page);
      }
    },
    600_000,
  );
});
