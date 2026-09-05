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
 * This is the **visual half of the slice-1 acceptance contract**; every
 * assertion below is tagged with its criterion id (`C1`..`C8`) from the
 * contract table in `.specify/specs/floor4-playable-completion.md`, matching
 * the headless gate in `tests/headless/floor4-arena-completion.test.ts`.
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
 * The intermission-to-next-act and final-stairs transitions are confirmed by
 * the real scene's modal path: the AI-runner bridge only presses the public
 * ModalPicker confirmation, and the scenario's `confirmFloor4StairDescend`
 * remains the sole phase authority.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import {
  FLOOR4_ACTS,
  FLOOR4_PUBLIC_INTERMISSION_EXIT_REASONS,
  FLOOR4_STALL_BACKSTOP_MS,
  FLOOR4_TOTAL_WAVES_RELEASED,
} from '../helpers/floor4-completion-contract.js';

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
const CHECKPOINT_DIR = resolve(process.cwd(), 'tmp', 'e2e-screenshots', 'floor4-ai-completion');
const FLOOR4_MODAL_SEQUENCE = Array.from({ length: 5 }, () => [
  'floor4-stair-descend:opened',
  'floor4-stair-descend:confirmed',
  'floor4-stair-descend:resumed',
]).flat();

async function loadAiRunner(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#ai-playback-dock', { timeout: 45_000 });
}

function surfaceActionSequence(events: readonly Floor4SurfaceEvent[]): string[] {
  return events.map((entry) => `${entry.kind}:${entry.action}`);
}

interface Floor4SurfaceEvent {
  kind: string;
  action: 'opened' | 'confirmed' | 'resumed';
  frame: number | null;
  gameMs: number | null;
  worldState: string | null;
}

interface Floor4RunSnapshot {
  effectiveFloor: string | null;
  openingPhaseKind: string | null;
  openingReason: string | null;
  phaseKind: string | null;
  wavesReleased: number | undefined;
  enemiesSpawned: number | undefined;
  gateTelegraphsArmed: number | undefined;
  headlinerSpawned: number | undefined;
  headlinerDefeated: number | undefined;
  headlinerOvertimeStarted: number | undefined;
  waveActs: number[];
  headlineActs: number[];
  intermissionActs: number[];
  intermissionExitReasons: string[];
  actIncomeCount: number;
  arenaElapsedMs: number | undefined;
  gameMs: number | null;
  manualControl: boolean;
  worldState: string | null;
  floor4SurfaceTrace: Floor4SurfaceEvent[];
  timelineFingerprint: string;
}

interface Floor4VisualRunResult {
  reachedVictory: boolean;
  pageErrors: string[];
  lastSnapshot: {
    frame: number;
    phase: unknown;
    wavesReleased: number | undefined;
    enemiesSpawned: number | undefined;
    headlinerSpawned: number | undefined;
    headlinerDefeated: number | undefined;
  } | null;
  finalSnapshot: Floor4RunSnapshot;
  liveWaveCheckpointSaved: boolean;
  victoryCheckpointSaved: boolean;
}

async function runVisualFloor4Completion(browser: Browser): Promise<Floor4VisualRunResult> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  mkdirSync(CHECKPOINT_DIR, { recursive: true });

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
    let liveWaveCheckpointSaved = false;
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
          enemiesSpawned: arena?.waveTelemetry?.enemiesSpawned,
          headlinerSpawned: arena?.headlinerTelemetry?.spawned,
          headlinerDefeated: arena?.headlinerTelemetry?.defeated,
        };
      });
      lastSnapshot = snapshot;
      if (
        !liveWaveCheckpointSaved &&
        snapshot.phase !== null &&
        typeof snapshot.phase === 'object' &&
        (snapshot.phase as { kind?: string }).kind === 'WAVES' &&
        (snapshot.enemiesSpawned ?? 0) > 0
      ) {
        await page.screenshot({ path: join(CHECKPOINT_DIR, 'live-wave.png'), type: 'png' });
        liveWaveCheckpointSaved = true;
      }
      if (
        snapshot.phase !== null &&
        typeof snapshot.phase === 'object' &&
        (snapshot.phase as { kind?: string }).kind === 'VICTORY'
      ) {
        reachedVictory = true;
        break;
      }
    }
    let victoryCheckpointSaved = false;
    if (reachedVictory) {
      await page.screenshot({ path: join(CHECKPOINT_DIR, 'victory.png'), type: 'png' });
      victoryCheckpointSaved = true;
    }

    const finalSnapshot = await page.evaluate(() => {
      const snap = window.__aiRunnerDebug?.();
      const arena = snap?.floor4Arena;
      const timeline = Array.isArray(arena?.timeline) ? arena.timeline : [];
      const actsFor = (kind: string): number[] =>
        timeline
          .filter((entry) => entry?.phase?.kind === kind && typeof entry?.phase?.act === 'number')
          .map((entry) => entry.phase.act as number);
      const intermissionExitReasons = timeline
        .map((entry, index) =>
          timeline[index - 1]?.phase?.kind === 'INTERMISSION' ? entry?.reason : undefined,
        )
        .filter((reason): reason is string => typeof reason === 'string');
      return {
        effectiveFloor: typeof snap?.effectiveFloor === 'string' ? snap.effectiveFloor : null,
        openingPhaseKind:
          typeof timeline[0]?.phase?.kind === 'string' ? timeline[0].phase.kind : null,
        openingReason: typeof timeline[0]?.reason === 'string' ? timeline[0].reason : null,
        phaseKind: typeof arena?.phase?.kind === 'string' ? arena.phase.kind : null,
        wavesReleased: arena?.waveTelemetry?.wavesReleased,
        enemiesSpawned: arena?.waveTelemetry?.enemiesSpawned,
        gateTelegraphsArmed: arena?.waveTelemetry?.gateTelegraphsArmed,
        headlinerSpawned: arena?.headlinerTelemetry?.spawned,
        headlinerDefeated: arena?.headlinerTelemetry?.defeated,
        headlinerOvertimeStarted: arena?.headlinerTelemetry?.overtimeStarted,
        waveActs: actsFor('WAVES'),
        headlineActs: actsFor('HEADLINE'),
        intermissionActs: actsFor('INTERMISSION'),
        intermissionExitReasons,
        actIncomeCount: Array.isArray(arena?.actIncome) ? arena.actIncome.length : 0,
        arenaElapsedMs: arena?.arenaElapsedMs,
        gameMs: typeof snap?.gameMs === 'number' ? snap.gameMs : null,
        manualControl: snap?.manualControl === true,
        worldState: typeof snap?.worldState === 'string' ? snap.worldState : null,
        floor4SurfaceTrace: Array.isArray(snap?.floor4SurfaceTrace) ? snap.floor4SurfaceTrace : [],
        timelineFingerprint: timeline
          .map((entry) => {
            const kind = typeof entry?.phase?.kind === 'string' ? entry.phase.kind : 'unknown';
            const act = typeof entry?.phase?.act === 'number' ? `:${String(entry.phase.act)}` : '';
            return `${kind}${act}`;
          })
          .join('|'),
      };
    });

    return {
      reachedVictory,
      pageErrors,
      lastSnapshot,
      finalSnapshot,
      liveWaveCheckpointSaved,
      victoryCheckpointSaved,
    };
  } finally {
    await closeQuietly(page);
  }
}

describe('Floor 4 visual AI-runner completion gate (seed 404)', () => {
  let browser: Browser;
  let firstRun: Floor4VisualRunResult;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Shared across this describe's tests (the main completion test AND the
    // isolated C5 characterization below) so the second test doesn't need to
    // pay for another real browser run of the same canonical seed.
    firstRun = await runVisualFloor4Completion(browser);
  }, 300_000);

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('completes: production BehaviorTreeAI drives the real MainGameScene to VICTORY with deterministic visual-run parity', async () => {
    const firstContext = `pageErrors=${JSON.stringify(firstRun.pageErrors)} lastSnapshot=${JSON.stringify(
      firstRun.lastSnapshot,
    )} finalSnapshot=${JSON.stringify(firstRun.finalSnapshot)}`;

    // The core regression proof: the fast-restart race that used to
    // freeze the render loop with a TypeError must not recur.
    expect(firstRun.pageErrors, firstContext).toEqual([]);
    expect(firstRun.finalSnapshot.manualControl, firstContext).toBe(false);
    expect(firstRun.reachedVictory, firstContext).toBe(true);
    expect(firstRun.liveWaveCheckpointSaved, firstContext).toBe(true);
    expect(firstRun.victoryCheckpointSaved, firstContext).toBe(true);

    // C1 — the standard Floor 4 scenario initialized inside the real scene.
    expect(firstRun.finalSnapshot.effectiveFloor, firstContext).toBe('floor4');
    expect(firstRun.finalSnapshot.openingPhaseKind, firstContext).toBe('COUNTDOWN');
    expect(firstRun.finalSnapshot.openingReason, firstContext).toBe('floor4-initialized');
    // C2 — physical hostiles released through the authored feed-gate path.
    expect(firstRun.finalSnapshot.enemiesSpawned, firstContext).toBeGreaterThanOrEqual(200);
    expect(firstRun.finalSnapshot.gateTelegraphsArmed, firstContext).toBeGreaterThan(0);
    // C3 — all five wave windows opened AND released every authored wave
    // (manifest-derived full-release ceiling; see the headless gate's
    // identical comment for why a bare lower bound would also pass with
    // earlier acts alone).
    expect(firstRun.finalSnapshot.wavesReleased, firstContext).toBe(FLOOR4_TOTAL_WAVES_RELEASED);
    expect(firstRun.finalSnapshot.waveActs, firstContext).toEqual([...FLOOR4_ACTS]);
    // C4 — all five Headliners physically spawned and fell to ordinary combat.
    expect(firstRun.finalSnapshot.headlinerSpawned, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.headlinerDefeated, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.headlineActs, firstContext).toEqual([...FLOOR4_ACTS]);
    // C5 — every act's intermission was entered, banked income, and resolved
    // through the real scene's public modal confirmation path.
    expect(firstRun.finalSnapshot.intermissionActs, firstContext).toEqual([...FLOOR4_ACTS]);
    expect(firstRun.finalSnapshot.actIncomeCount, firstContext).toBe(5);
    expect(firstRun.finalSnapshot.intermissionExitReasons, firstContext).toHaveLength(5);
    expect(firstRun.finalSnapshot.intermissionExitReasons, firstContext).toEqual([
      'public-green-room-exit',
      'public-green-room-exit',
      'public-green-room-exit',
      'public-green-room-exit',
      'public-stairs',
    ]);
    expect(
      firstRun.finalSnapshot.intermissionExitReasons.every((reason) =>
        FLOOR4_PUBLIC_INTERMISSION_EXIT_REASONS.includes(reason),
      ),
      firstContext,
    ).toBe(true);
    expect(firstRun.finalSnapshot.floor4SurfaceTrace, firstContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'floor4-stair-descend',
          action: 'opened',
        }),
        expect.objectContaining({
          kind: 'floor4-stair-descend',
          action: 'confirmed',
        }),
        expect.objectContaining({
          kind: 'floor4-stair-descend',
          action: 'resumed',
        }),
      ]),
    );
    expect(
      firstRun.finalSnapshot.floor4SurfaceTrace.filter(
        (entry) => entry.kind === 'floor4-stair-descend' && entry.action === 'confirmed',
      ),
      firstContext,
    ).toHaveLength(5);
    expect(surfaceActionSequence(firstRun.finalSnapshot.floor4SurfaceTrace), firstContext).toEqual(
      FLOOR4_MODAL_SEQUENCE,
    );
    // C6/C7 — the terminal phase is VICTORY, which is exactly the predicate
    // (`isFloor4ArenaVictory`) the shared `ScenarioDefinition.isVictoryReached`
    // uses to produce headless `RunStats.outcome === 'victory'`; the visual
    // runner produces no `RunStats` of its own.
    expect(firstRun.finalSnapshot.phaseKind, firstContext).toBe('VICTORY');
    expect(firstRun.finalSnapshot.worldState, firstContext).not.toBe('game_over');
    expect(firstRun.finalSnapshot.timelineFingerprint, firstContext).not.toBe('');
    // C8 — terminated under the real Floor 4 stall backstop. `arenaElapsedMs`
    // only advances during WAVES/HEADLINE and is capped well below the
    // backstop, so it can't prove this; compare the raw clock
    // (`gameMs` === `world.elapsedMs`) that `floor4ObjectiveTick` itself
    // measures against the manifest deadline — the same field headless
    // `RunStats.gameTimeMs` reports for the identical C8 assertion.
    expect(firstRun.finalSnapshot.gameMs, firstContext).not.toBeNull();
    expect(firstRun.finalSnapshot.gameMs, firstContext).toBeLessThan(FLOOR4_STALL_BACKSTOP_MS);

    const secondRun = await runVisualFloor4Completion(browser);
    const secondContext = `pageErrors=${JSON.stringify(
      secondRun.pageErrors,
    )} lastSnapshot=${JSON.stringify(secondRun.lastSnapshot)} finalSnapshot=${JSON.stringify(
      secondRun.finalSnapshot,
    )}`;

    // Deterministic parity check: the same canonical visual run repeats with
    // an identical phase progression fingerprint and completion contract.
    expect(secondRun.pageErrors, secondContext).toEqual([]);
    expect(secondRun.finalSnapshot.manualControl, secondContext).toBe(false);
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
    expect(secondRun.finalSnapshot.gameMs, secondContext).not.toBeNull();
    expect(secondRun.finalSnapshot.gameMs, secondContext).toBeLessThan(FLOOR4_STALL_BACKSTOP_MS);
    expect(
      surfaceActionSequence(secondRun.finalSnapshot.floor4SurfaceTrace),
      secondContext,
    ).toEqual(surfaceActionSequence(firstRun.finalSnapshot.floor4SurfaceTrace));
    expect(secondRun.finalSnapshot.timelineFingerprint, secondContext).not.toBe('');
  }, 300_000);
});
