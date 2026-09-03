/**
 * Deterministic observation: the terminal run-bundle (RunStats payload)
 * upload actually reaches the configured ingest endpoint exactly once through
 * the REAL production scene/bootstrap path, and the player sees a visible
 * success/failure confirmation (AGENTS.md rule #9 — "observe before done").
 *
 * `tests/unit/run-bundle-upload.test.ts` and
 * `tests/unit/main-game-scene-run-bundle.test.ts` prove the isolated
 * `submitRunBundleUpload()` request-building logic and the
 * source-text-extracted `emitRunBundle()`/`showRunSurveyIfNeeded()` bodies —
 * but neither boots the real `MainGameScene` through the shipped
 * `createFloorMainSceneOptions()` bootstrap, so neither can prove that:
 *
 *   1. the default `onRunBundle` sink (`defaultRunBundleSink` in
 *      `src/bootstrap/floor-main-scene-options.ts`) is actually wired to the
 *      real scene and fires a real network request when a run ends, or
 *   2. the player-visible completion-telemetry status toast
 *      (`MainGameScene.flashActionStatus`) actually renders success vs.
 *      failure text depending on what the endpoint returns.
 *
 * This suite boots the real scene via `main-scene-probe-lab` (same
 * `createFloorMainSceneOptions()` bootstrap path the shipped game uses, with
 * no `onRunBundle` override — see the lab's `baseOptions`), forces the death
 * outcome through the real `world.state = 'game_over'` transition, and
 * observes the actual outbound `fetch` request plus the real rendered toast
 * text.
 *
 * Determinism: fixed lab seed, single scripted network response per test (no
 * timers/randomness in the assertions), and `waitForState` polls the real
 * rendered projection rather than a wall-clock sleep.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

const INGEST_URL = 'https://example.test/api/runs';

interface CapturedRunBundleRequest {
  readonly runStats?: unknown;
  readonly recorderJsonl?: unknown;
  readonly logs?: unknown;
  readonly meta?: {
    readonly endReason?: unknown;
    readonly seed?: unknown;
    readonly runId?: unknown;
  };
}

interface CapturedUpload {
  readonly mode?: string;
  readonly body: CapturedRunBundleRequest;
}

/** Inject the window-scoped ingest endpoint override BEFORE the lab boots. */
async function installRunBundleEndpoint(page: Page): Promise<void> {
  await page.addInitScript((url) => {
    (
      window as unknown as { __CRAWLER_RUN_BUNDLE_ENDPOINT__?: string }
    ).__CRAWLER_RUN_BUNDLE_ENDPOINT__ = url;
  }, INGEST_URL);
}

/** Answer the CORS preflight every cross-origin POST triggers. */
async function fulfillPreflight(route: Route): Promise<boolean> {
  if (route.request().method() !== 'OPTIONS') {
    return false;
  }
  await route.fulfill({
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-run-upload-mode',
    },
  });
  return true;
}

describe('terminal run-bundle completion telemetry (production scene/bootstrap boundary)', () => {
  let browser: Browser;
  let context: BrowserContext | undefined;

  afterAll(async () => {
    await closeQuietly(browser);
  });

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function newPage(): Promise<Page> {
    browser ??= await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    return context.newPage();
  }

  it('publishes the completion RunStats payload exactly once and shows a visible success confirmation', async () => {
    const page = await newPage();
    await installRunBundleEndpoint(page);

    const requests: CapturedUpload[] = [];
    await page.route(INGEST_URL, async (route) => {
      if (await fulfillPreflight(route)) {
        return;
      }
      const request = route.request();
      const body = request.postDataJSON() as CapturedRunBundleRequest;
      requests.push({
        mode: request.headers()['x-run-upload-mode'],
        body,
      });
      await route.fulfill({
        status: 202,
        headers: { 'access-control-allow-origin': '*' },
        json: { runId: 'e2e-completion-run' },
      });
    });

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.setWorldState(page, 'game_over');

    const state = await waitForState(page, (s) => s.runBundleUploadStatus !== null, {
      label: 'run-bundle completion upload to settle',
    });

    expect(state.runBundleUploadStatus).toBe('ok');
    expect(state.actionStatusToastVisible).toBe(true);
    expect(state.actionStatusToastText).toMatch(/uploaded/i);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mode).toBe('silent');
    expect(requests[0]?.body?.meta?.endReason).toBe('death');

    // Payload completeness: must be a full RunBundle.
    expect(requests[0]?.body?.runStats).toBeDefined();
    expect(requests[0]?.body?.recorderJsonl).toBeDefined();
    expect(requests[0]?.body?.logs).toBeDefined();
    expect(requests[0]?.body?.meta?.seed).toBeDefined();
    expect(requests[0]?.body?.meta?.runId).toBeDefined();

    // Exactly-once guard: re-driving the same terminal transition must not
    // fire a second request (`MainGameScene.runBundleEmitted` latch).
    await mainSceneProbe.setWorldState(page, 'game_over');
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(1);
  });

  it('keeps the real game-over picker usable while the terminal survey owns input', async () => {
    const page = await newPage();
    await installRunBundleEndpoint(page);
    await page.route(INGEST_URL, async (route) => {
      if (await fulfillPreflight(route)) {
        return;
      }
      await route.fulfill({
        status: 202,
        headers: { 'access-control-allow-origin': '*' },
        json: { runId: 'e2e-survey-reset-guard' },
      });
    });

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.setWorldState(page, 'game_over');
    await page.locator('[role="dialog"][aria-labelledby="crawler-run-survey-title"]').waitFor({
      state: 'visible',
    });
    const gameOverState = await waitForState(
      page,
      (s) => s.worldState === 'game_over' && s.gameOverOpen,
      {
        label: 'game-over picker visible behind run survey',
      },
    );
    expect(gameOverState.gameOverOpen).toBe(true);

    await mainSceneProbe.pressGameOverKey(page, 'Enter');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const blockedConfirmState = await mainSceneProbe.getState(page);
    expect(blockedConfirmState.worldState).toBe('game_over');
    expect(blockedConfirmState.gameOverOpen).toBe(true);

    await page.getByRole('button', { name: 'Skip' }).click();
    await page.locator('[role="dialog"][aria-labelledby="crawler-run-survey-title"]').waitFor({
      state: 'hidden',
    });
    const afterSkipState = await mainSceneProbe.getState(page);
    expect(afterSkipState.worldState).toBe('game_over');
    expect(afterSkipState.gameOverOpen).toBe(true);
  });

  it('shows a visible failure confirmation when the ingest endpoint rejects the upload', async () => {
    const page = await newPage();
    await installRunBundleEndpoint(page);

    let requestCount = 0;
    await page.route(INGEST_URL, async (route) => {
      if (await fulfillPreflight(route)) {
        return;
      }
      requestCount += 1;
      await route.fulfill({
        status: 500,
        headers: { 'access-control-allow-origin': '*' },
        json: { error: 'ingest unavailable' },
      });
    });

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.setWorldState(page, 'game_over');

    const state = await waitForState(page, (s) => s.runBundleUploadStatus !== null, {
      label: 'run-bundle completion upload to settle (failure)',
    });

    expect(state.runBundleUploadStatus).toBe('failed');
    expect(state.actionStatusToastVisible).toBe(true);
    expect(state.actionStatusToastText).toMatch(/failed/i);
    expect(requestCount).toBe(1);
  });
});
