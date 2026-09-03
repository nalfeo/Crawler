/**
 * Official visual Floor 4 completion gate — the "must be beatable ... in the
 * visual AI-runner MainGameScene" half of the `floor-4-playable-completion`
 * epic's narrower, non-balance contract, for the canonical deterministic
 * seed 404.
 *
 * Drives the REAL shipped `ai-runner-lab` (`MainGameScene`, `PhaserBridge`,
 * production `BehaviorTreeAI`) through its own public controls — the
 * floor/seed selects, `#ai-run-apply`, the speed buttons, `#ai-toggle-run` —
 * exactly as a human operator would, then polls the lab's own
 * `window.__aiRunnerDebug()` telemetry (which now includes `floor4Arena`,
 * mirroring headless `RunStats.floor4Arena`) until the arena director's
 * phase trace reaches `VICTORY`.
 *
 * ## Why the fast-restart timing matters
 *
 * Selecting Floor 4 + seed 404 via the lab UI calls `phaserScene.scene
 * .restart()`. Restarting immediately (as any automated driver naturally
 * does, unlike a human clicking through the UI) used to race the generated
 * player sprite's async texture load: `AnimationManager#generateFrameNumbers`
 * returned `[]` before the texture existed, and the project's animation
 * registration used to call `anims.create()` on that empty frame list
 * anyway — permanently poisoning the walk-cycle key in Phaser's *global*
 * (not per-scene) `AnimationManager`. The very first `.play()` on that
 * poisoned key threw inside `Animation#getFirstTick`, from inside
 * `MainGameScene.update()`, freezing the whole render/update loop
 * permanently (frame count stuck, no recovery). This made the visual runner
 * *unobservable* for Floor 4 — not a balance problem, a genuine crash.
 *
 * The fix (`confirmGeneratedSpriteAnimation` in
 * `src/engine/generatedAssets/animations.ts`, retried per-frame from
 * `PhaserBridge.sync()`) skips creating the animation when the texture isn't
 * ready yet instead of poisoning the key, then retries just the pending key
 * every frame until the texture loads. This test restarts fast on purpose
 * (~300ms after load, well inside the crash window previously observed) to
 * prove the race is actually fixed, not merely avoided by waiting.
 *
 * ## What this test does NOT claim
 *
 * Same honest scope as `tests/headless/floor4-arena-completion.test.ts`:
 * Floor 4's intermission-to-next-act and final-stairs transitions are still
 * driven by `arenaDirectorSystem`'s own phase timer (shared by both runners,
 * not a runner-only shortcut), not a genuine per-decision AI interaction
 * with a physical Green Room exit or stairs prop. That gap is open per the
 * epic's later slices and is not closed by this test. This test only proves
 * the visual runner can observe and complete the SAME run headless
 * completes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import { assessFloor4Completion } from '../helpers/floor4-completion-contract.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner`;

/** The canonical deterministic seed the epic names for both runners. */
const CANONICAL_SEED = '404';

/**
 * Restart-to-first-poll delay. Deliberately inside the previously-observed
 * crash window (a bare restart used to freeze within 1-16 frames) so a
 * regression in the animation fix would fail this test, not slip past it.
 */
const FAST_RESTART_SETTLE_MS = 300;

/** Poll cadence while waiting for VICTORY. */
const POLL_INTERVAL_MS = 3_000;
/** Generous ceiling: the headless baseline reaches VICTORY at ~608s game
 * time / ~36.5k frames; at 16x this needs well under 90s of wall time. */
const MAX_POLLS = 40;

async function loadAiRunner(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#ai-playback-dock', { timeout: 45_000 });
}

interface Floor4RunSnapshot {
  phaseKind: string | null;
  wavesReleased: number | undefined;
  enemiesSpawned: number | undefined;
  headlinerSpawned: number | undefined;
  headlinerDefeated: number | undefined;
  intermissionActs: number[];
  intermissionReasons: string[];
  actIncomeCount: number;
  timelineFingerprint: string;
  frame: number;
}

interface Floor4VisualRunResult {
  reachedVictory: boolean;
  pageErrors: string[];
  lastSnapshot: {
    frame: number;
    phase: unknown;
    wavesReleased: number | undefined;
    headlinerSpawned: number | undefined;
    headlinerDefeated: number | undefined;
  } | null;
  finalSnapshot: Floor4RunSnapshot;
}

async function runVisualFloor4Completion(browser: Browser): Promise<Floor4VisualRunResult> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    await loadAiRunner(page);
    await page.evaluate(() => {
      const details = document.getElementById('ai-run-setup');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });
    await page.selectOption('#ai-run-target-select', 'floor:floor4');
    await page.fill('#ai-seed-input', CANONICAL_SEED);
    await page.click('#ai-run-apply');
    await page.waitForTimeout(FAST_RESTART_SETTLE_MS);
    await page.click('#ai-speed-16');
    await page.click('#ai-toggle-run');

    let reachedVictory = false;
    let lastSnapshot: Floor4VisualRunResult['lastSnapshot'] = null;
    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      if (pageErrors.length > 0) break;
      const snapshot = await page.evaluate(() => {
        const snap = window.__aiRunnerDebug?.();
        const arena = snap?.floor4Arena;
        return {
          frame: snap?.frame ?? -1,
          phase: arena?.phase ?? null,
          wavesReleased: arena?.waveTelemetry?.wavesReleased,
          headlinerSpawned: arena?.headlinerTelemetry?.spawned,
          headlinerDefeated: arena?.headlinerTelemetry?.defeated,
        };
      });
      lastSnapshot = snapshot;
      if (
        snapshot.phase !== null &&
        typeof snapshot.phase === 'object' &&
        (snapshot.phase as { kind?: string }).kind === 'VICTORY'
      ) {
        reachedVictory = true;
        break;
      }
    }

    const finalSnapshot = await page.evaluate(() => {
      const arena = window.__aiRunnerDebug?.().floor4Arena;
      const timeline = Array.isArray(arena?.timeline) ? arena.timeline : [];
      const intermissionActs = timeline
        .filter(
          (entry) => entry?.phase?.kind === 'INTERMISSION' && typeof entry?.phase?.act === 'number',
        )
        .map((entry) => entry.phase.act);
      const intermissionReasons = timeline.flatMap((entry, index) =>
        timeline[index - 1]?.phase?.kind === 'INTERMISSION'
          ? [typeof entry?.reason === 'string' ? entry.reason : 'unknown']
          : [],
      );
      return {
        phaseKind: typeof arena?.phase?.kind === 'string' ? arena.phase.kind : null,
        wavesReleased: arena?.waveTelemetry?.wavesReleased,
        enemiesSpawned: arena?.waveTelemetry?.enemiesSpawned,
        headlinerSpawned: arena?.headlinerTelemetry?.spawned,
        headlinerDefeated: arena?.headlinerTelemetry?.defeated,
        intermissionActs,
        intermissionReasons,
        actIncomeCount: Array.isArray(arena?.actIncome) ? arena.actIncome.length : 0,
        timelineFingerprint: timeline
          .map((entry) => {
            const kind = typeof entry?.phase?.kind === 'string' ? entry.phase.kind : 'unknown';
            const act = typeof entry?.phase?.act === 'number' ? `:${String(entry.phase.act)}` : '';
            return `${kind}${act}`;
          })
          .join('|'),
        frame: window.__aiRunnerDebug?.().frame ?? -1,
      };
    });

    return { reachedVictory, pageErrors, lastSnapshot, finalSnapshot };
  } finally {
    await closeQuietly(page);
  }
}

describe('Floor 4 visual AI-runner completion gate (seed 404)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('completes: production BehaviorTreeAI drives the real MainGameScene to VICTORY with deterministic visual-run parity', async () => {
    const firstRun = await runVisualFloor4Completion(browser);
    const firstContext = `pageErrors=${JSON.stringify(firstRun.pageErrors)} lastSnapshot=${JSON.stringify(
      firstRun.lastSnapshot,
    )} finalSnapshot=${JSON.stringify(firstRun.finalSnapshot)}`;

    // The core regression proof: the fast-restart race that used to
    // freeze the render loop with a TypeError must not recur.
    expect(firstRun.pageErrors, firstContext).toEqual([]);
    expect(firstRun.reachedVictory, firstContext).toBe(true);
    expect(firstRun.finalSnapshot.phaseKind, firstContext).toBe('VICTORY');
    expect(firstRun.finalSnapshot.wavesReleased, firstContext).toBeGreaterThanOrEqual(5);
    expect(firstRun.finalSnapshot.enemiesSpawned, firstContext).toBeGreaterThanOrEqual(200);
    expect(firstRun.finalSnapshot.headlinerSpawned, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.headlinerDefeated, firstContext).toBe(5);
    expect(new Set(firstRun.finalSnapshot.intermissionActs).size, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.actIncomeCount, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.timelineFingerprint, firstContext).not.toBe('');
    const firstAssessment = assessFloor4Completion({
      scenarioInitialized: firstRun.finalSnapshot.phaseKind !== null,
      phaseKind: firstRun.finalSnapshot.phaseKind,
      wavesReleased: firstRun.finalSnapshot.wavesReleased,
      enemiesSpawned: firstRun.finalSnapshot.enemiesSpawned,
      headlinersSpawned: firstRun.finalSnapshot.headlinerSpawned,
      headlinersDefeated: firstRun.finalSnapshot.headlinerDefeated,
      intermissionActs: firstRun.finalSnapshot.intermissionActs,
      intermissionReasons: firstRun.finalSnapshot.intermissionReasons,
      // MainGameScene does not emit RunStats; the phase check above is its production outcome.
      runStatsOutcome: null,
      totalFrames: firstRun.finalSnapshot.frame,
      maxFrames: Number.MAX_SAFE_INTEGER,
      stallBackstopReached: false,
    });
    expect(firstAssessment.criteria['scenario-initialized'], firstContext).toBe(true);
    expect(firstAssessment.criteria['physical-wave-hostile-spawned'], firstContext).toBe(true);
    expect(firstAssessment.criteria['all-wave-windows-released'], firstContext).toBe(true);
    expect(firstAssessment.criteria['all-headliners-spawned-and-defeated'], firstContext).toBe(
      true,
    );
    expect(firstAssessment.criteria['phase-reached-victory'], firstContext).toBe(true);
    expect(firstAssessment.criteria['runstats-outcome-victory'], firstContext).toBe(false);
    expect(firstAssessment.criteria['terminated-before-stall-backstop'], firstContext).toBe(true);
    expect(firstAssessment.criteria['intermission-public-interaction'], firstContext).toBe(false);
    expect(firstAssessment.firstFailedCriterion, firstContext).toBe(
      'intermission-public-interaction',
    );

    const secondRun = await runVisualFloor4Completion(browser);
    const secondContext = `pageErrors=${JSON.stringify(
      secondRun.pageErrors,
    )} lastSnapshot=${JSON.stringify(secondRun.lastSnapshot)} finalSnapshot=${JSON.stringify(
      secondRun.finalSnapshot,
    )}`;

    // Deterministic parity check: the same canonical visual run repeats with
    // an identical phase progression fingerprint and completion contract.
    expect(secondRun.pageErrors, secondContext).toEqual([]);
    expect(secondRun.reachedVictory, secondContext).toBe(true);
    expect(secondRun.finalSnapshot.phaseKind, secondContext).toBe('VICTORY');
    expect(secondRun.finalSnapshot.wavesReleased, secondContext).toBe(
      firstRun.finalSnapshot.wavesReleased,
    );
    expect(secondRun.finalSnapshot.enemiesSpawned, secondContext).toBeGreaterThanOrEqual(200);
    expect(secondRun.finalSnapshot.headlinerSpawned, secondContext).toBe(
      firstRun.finalSnapshot.headlinerSpawned,
    );
    expect(secondRun.finalSnapshot.headlinerDefeated, secondContext).toBe(
      firstRun.finalSnapshot.headlinerDefeated,
    );
    expect(new Set(secondRun.finalSnapshot.intermissionActs).size, secondContext).toBe(
      new Set(firstRun.finalSnapshot.intermissionActs).size,
    );
    expect(secondRun.finalSnapshot.actIncomeCount, secondContext).toBe(
      firstRun.finalSnapshot.actIncomeCount,
    );
    expect(secondRun.finalSnapshot.timelineFingerprint, secondContext).not.toBe('');
    expect(secondRun.finalSnapshot.timelineFingerprint, secondContext).toBe(
      firstRun.finalSnapshot.timelineFingerprint,
    );
  }, 300_000);
});
