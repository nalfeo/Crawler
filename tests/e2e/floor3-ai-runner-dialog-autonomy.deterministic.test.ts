import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import type { AiRunnerDebugSnapshot } from '../../src/labs/ai-runner-lab/index.js';

const FLOOR3_SEED = '3539';
const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner&floor=floor3&seed=${FLOOR3_SEED}&startPlayerLevel=20`;
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
  'floor3-stair-descend',
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

function firstEventIndex(
  trace: readonly SurfaceEvent[],
  kind: SurfaceKind,
  action: 'opened' | 'confirmed' | 'resumed',
) {
  return trace.findIndex((entry) => entry.kind === kind && entry.action === action);
}

function eventCount(
  trace: readonly SurfaceEvent[],
  kind: SurfaceKind,
  action: 'opened' | 'confirmed' | 'resumed',
): number {
  return trace.filter((entry) => entry.kind === kind && entry.action === action).length;
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
        const hasStairConfirm = eventCount(trace, 'floor3-stair-descend', 'confirmed') === 1;
        const hasEveryRepeatedSurface =
          eventCount(trace, 'floor3-studio-versus', 'confirmed') === 6 &&
          eventCount(trace, 'floor3-poach', 'confirmed') === 5 &&
          eventCount(trace, 'floor3-final-four-versus', 'confirmed') === 4;
        const hasKeepConfirm = eventCount(trace, 'floor3-keep-companion', 'confirmed') === 1;
        const hasOutside10s = snapshot.floor3MaxAliveOutsideSpawnStreakMs >= 10_000;
        if (
          snapshot.worldState === 'safe_room' &&
          hasStairConfirm &&
          hasEveryRepeatedSurface &&
          hasKeepConfirm &&
          hasOutside10s
        )
          break;
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
        floor3LossReason: lastSnapshot!.floor3LossReason,
        aliveOutsideStreakMs: lastSnapshot!.floor3MaxAliveOutsideSpawnStreakMs,
        reason: lastSnapshot!.reason,
        target: { x: lastSnapshot!.targetX, y: lastSnapshot!.targetY },
        player: { x: lastSnapshot!.px, y: lastSnapshot!.py },
        traceCounts,
        trace,
        quests: lastSnapshot!.quests,
        objectiveHistory: snapshots.slice(-20).map((sample) => ({
          frame: sample.frame,
          gameMs: sample.gameMs,
          state: sample.state,
          reason: sample.reason,
          target: { x: sample.targetX, y: sample.targetY },
          player: { x: sample.px, y: sample.py },
        })),
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

      expect(eventCount(trace, 'floor3-studio-versus', 'opened')).toBe(6);
      expect(eventCount(trace, 'floor3-studio-versus', 'confirmed')).toBe(6);
      expect(eventCount(trace, 'floor3-poach', 'opened')).toBe(5);
      expect(eventCount(trace, 'floor3-poach', 'confirmed')).toBe(5);
      expect(eventCount(trace, 'floor3-final-four-versus', 'opened')).toBe(4);
      expect(eventCount(trace, 'floor3-final-four-versus', 'confirmed')).toBe(4);
      expect(eventCount(trace, 'floor3-stair-descend', 'opened')).toBe(1);
      expect(eventCount(trace, 'floor3-stair-descend', 'confirmed')).toBe(1);
      expect(
        lastSnapshot!.worldState,
        `Floor 3 did not reach the post-exit safe room; ${context}`,
      ).toBe('safe_room');

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

      // Resume evidence comes from the lab's own tick-recorded `resumed`
      // events, not from this test's polling snapshots: at 16x speed a whole
      // confirm -> resume -> next-modal window can fit between two polls, which
      // made snapshot sampling flaky.
      for (let i = 0; i < trace.length; i += 1) {
        const event = trace[i]!;
        if (event.action !== 'confirmed' || event.kind === 'floor3-stair-descend') continue;
        const resumed = trace.some(
          (entry, index) => index > i && entry.action === 'resumed' && entry.kind === event.kind,
        );
        expect(
          resumed,
          `simulation did not resume after ${event.kind} at ${event.gameMs}ms; ${context}`,
        ).toBe(true);
      }

      const leftSpawn = snapshots.some((sample) => sample.inSpawnRoom === false);
      expect(leftSpawn).toBe(true);
      expect(lastSnapshot!.floor3MaxAliveOutsideSpawnStreakMs).toBeGreaterThanOrEqual(10_000);

      // #4205: once a starter companion is confirmed, the AI Runner debug
      // snapshot must expose that companion's current decision + path with
      // parity to the player's own targetX/targetY/path telemetry above —
      // proven here in the real scene, not a lab-only unit test.
      const starterConfirmedGameMs = trace.find(
        (entry) => entry.kind === 'floor3-starter' && entry.action === 'confirmed',
      )?.gameMs;
      expect(typeof starterConfirmedGameMs).toBe('number');
      const companionSample = snapshots.find(
        (sample) =>
          typeof sample.gameMs === 'number' &&
          sample.gameMs > starterConfirmedGameMs! &&
          sample.companions.length > 0,
      );
      expect(
        Boolean(companionSample),
        `no snapshot after starter confirm (${starterConfirmedGameMs}ms) reported a companion; ${context}`,
      ).toBe(true);
      const companion = companionSample!.companions[0]!;
      expect(typeof companion.kind).toBe('string');
      expect(Number.isFinite(companion.x)).toBe(true);
      expect(Number.isFinite(companion.y)).toBe(true);
      expect(Number.isFinite(companion.targetX)).toBe(true);
      expect(Number.isFinite(companion.targetY)).toBe(true);
      expect(Number.isFinite(companion.targetDist)).toBe(true);
      expect(Array.isArray(companion.path)).toBe(true);
      expect(companion.path.length).toBeGreaterThan(0);
    } finally {
      await closeQuietly(page);
    }
  }, 420_000);
});
