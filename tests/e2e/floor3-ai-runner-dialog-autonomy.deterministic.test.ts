import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import type { AiRunnerDebugSnapshot } from '../../src/labs/ai-runner-lab/index.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner`;
const FLOOR3_SEED = '3539';
const FAST_RESTART_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 240;

const REQUIRED_SEQUENCE = [
  'floor3-intro',
  'floor3-starter',
  'floor3-studio-versus',
  'floor3-poach',
  'floor3-final-four-versus',
  'floor3-keep-companion',
] as const;

type SurfaceKind = (typeof REQUIRED_SEQUENCE)[number];
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

function longestAliveOutsideSpawnStreakMs(samples: readonly AiRunnerDebugSnapshot[]): number {
  let max = 0;
  let streakStart: number | null = null;
  for (const sample of samples) {
    const gameMs = sample.gameMs;
    const activeOutside =
      typeof gameMs === 'number' &&
      sample.worldState === 'playing' &&
      sample.inSpawnRoom === false &&
      typeof sample.health === 'number' &&
      sample.health > 0;
    if (!activeOutside) {
      streakStart = null;
      continue;
    }
    if (streakStart === null) {
      streakStart = gameMs;
      continue;
    }
    max = Math.max(max, gameMs - streakStart);
  }
  return max;
}

function firstEventIndex(
  trace: readonly SurfaceEvent[],
  kind: SurfaceKind,
  action: 'opened' | 'confirmed',
) {
  return trace.findIndex((entry) => entry.kind === kind && entry.action === action);
}

describe('Floor 3 AI runner modal autonomy (real scene)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('drives every blocking Floor 3 surface through modal callbacks and keeps simulation alive after leaving spawn', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    try {
      await loadAiRunner(page);
      await page.evaluate(() => {
        const details = document.getElementById('ai-run-setup');
        if (details instanceof HTMLDetailsElement) details.open = true;
      });
      await page.selectOption('#ai-run-target-select', 'floor:floor3');
      await page.fill('#ai-seed-input', FLOOR3_SEED);
      await page.click('#ai-run-apply');
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

        const trace = snapshot.floor3SurfaceTrace;
        const hasKeepConfirm = trace.some(
          (entry) => entry.kind === 'floor3-keep-companion' && entry.action === 'confirmed',
        );
        const hasAllFinalFour =
          trace.filter(
            (entry) => entry.kind === 'floor3-final-four-versus' && entry.action === 'confirmed',
          ).length >= 4;
        const hasOutside10s = longestAliveOutsideSpawnStreakMs(snapshots) >= 10_000;
        if (hasKeepConfirm && hasAllFinalFour && hasOutside10s) break;
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
        traceCounts,
      });

      for (const kind of REQUIRED_SEQUENCE) {
        expect(
          firstEventIndex(trace, kind, 'opened'),
          `missing opened event for ${kind}; ${context}`,
        ).toBeGreaterThan(-1);
        expect(
          firstEventIndex(trace, kind, 'confirmed'),
          `missing confirmed event for ${kind}; ${context}`,
        ).toBeGreaterThan(-1);
      }

      expect(
        trace.filter(
          (entry) => entry.kind === 'floor3-final-four-versus' && entry.action === 'opened',
        ).length,
      ).toBe(4);
      expect(
        trace.filter(
          (entry) => entry.kind === 'floor3-final-four-versus' && entry.action === 'confirmed',
        ).length,
      ).toBe(4);

      for (let i = 1; i < REQUIRED_SEQUENCE.length; i += 1) {
        const previous = REQUIRED_SEQUENCE[i - 1]!;
        const current = REQUIRED_SEQUENCE[i]!;
        expect(firstEventIndex(trace, previous, 'opened')).toBeLessThan(
          firstEventIndex(trace, current, 'opened'),
        );
        expect(firstEventIndex(trace, previous, 'confirmed')).toBeLessThan(
          firstEventIndex(trace, current, 'confirmed'),
        );
      }

      for (const event of trace.filter((entry) => entry.action === 'confirmed')) {
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
          `simulation did not resume after ${event.kind} at ${event.gameMs}ms`,
        ).toBe(true);
      }

      const leftSpawn = snapshots.some((sample) => sample.inSpawnRoom === false);
      expect(leftSpawn).toBe(true);
      const aliveOutsideStreakMs = longestAliveOutsideSpawnStreakMs(snapshots);
      expect(aliveOutsideStreakMs).toBeGreaterThanOrEqual(10_000);
    } finally {
      await closeQuietly(page);
    }
  }, 420_000);
});
