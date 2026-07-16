/**
 * Sprite-workflow sensor-failure visibility + force-judge override (PR2c).
 *
 * Pure DOM render regression for the devtools sprite-generation workflow. Unlike
 * the Phaser pixel-sampling specs in this folder, this drives `devtools.html`
 * (served by the same lab dev server) and asserts on the rendered DOM.
 *
 * What we're guarding against:
 *   • The PostProcess/Judge run-candidates panel must show WHICH sensors failed
 *     and why (reason + the pixelCount magnitude hint) per variant — not just a
 *     pass/fail tally.
 *   • A force-judge override must be offered (run-level "Force judge" button +
 *     a per-variant "Force judge variant" affordance) when a run has variants
 *     the normal sensor gate would skip.
 *
 * CI-safety (Constitution §3): this test stands up NO Azure/LLM/vision sidecar.
 * It seeds a deterministic queue into `localStorage` and reloads, exercising the
 * resume-after-refresh render path purely from cached state. All `/api/**`
 * sidecar calls are aborted so the render is hermetic and never depends on a
 * live backend (a live-Azure end-to-end run is kept as documented manual
 * evidence, out of CI).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import {
  addItem,
  createEmptyQueue,
  serializeQueue,
  updateItem,
  QUEUE_STORAGE_KEY,
  type QueueRun,
} from '../../src/devtools/sprite-workflow-queue.js';

// The run-candidates panel + workflow buttons only mount on the sprite-workflow
// page (and only on a localhost host, which the lab server satisfies).
const DEVTOOLS_URL = `${E2E_LAB_BASE_URL}/devtools.html?page=sprite-generation-workflow`;

// A failing sensor reason + magnitude we assert renders verbatim in the panel.
const FAILED_SENSOR_REASON = 'bg-not-transparent';
const FAILED_SENSOR_PIXELS = 1234;

/**
 * Build a deterministic, post-processed run whose top variant fails the
 * transparency sensor (so the sensor gate would skip it) and a second variant
 * that passes — enough to exercise both the failure-detail render and the
 * force-judge eligibility.
 */
function makeSeededQueueJson(): string {
  const run: QueueRun = {
    briefId: 'purple-potion',
    runId: 'run-0001',
    candidates: [
      {
        index: 0,
        score: 2,
        outOf: 3,
        passed: false,
        combinedPassed: false,
        judge: null,
        sensors: [
          { sensor: 'silhouette', ok: true, reason: null, pixelCount: null },
          {
            sensor: 'transparency',
            ok: false,
            reason: FAILED_SENSOR_REASON,
            pixelCount: FAILED_SENSOR_PIXELS,
          },
          { sensor: 'edge-bleed', ok: false, reason: 'edge-halo', pixelCount: null },
        ],
      },
      {
        index: 1,
        score: 3,
        outOf: 3,
        passed: true,
        combinedPassed: true,
        judge: null,
        sensors: [
          { sensor: 'silhouette', ok: true, reason: null, pixelCount: null },
          { sensor: 'transparency', ok: true, reason: null, pixelCount: null },
          { sensor: 'edge-bleed', ok: true, reason: null, pixelCount: null },
        ],
      },
    ],
  };
  let state = addItem(createEmptyQueue(), 'Purple Potion');
  const itemId = state.items[0]?.id ?? 'item-1';
  state = updateItem(state, itemId, { stage: 'postprocessed', run });
  return serializeQueue(state);
}

/**
 * Build a run that exercises the candidate-detail sidebar + the unjudged-label
 * regression:
 *   • variant 0 — all sensors pass but it was NOT judged (combinedPassed=false,
 *     judge=null). It must read as neutral "not judged", never red "sensor fail".
 *   • variant 1 — judged + combined-pass, with axis scores in persisted state so
 *     clicking its sprite opens the detail panel with the named judge axes
 *     (Style match / Brief match / Readability) straight from cache (no sidecar).
 */
function makeDetailSeededQueueJson(): string {
  const allPass = [
    { sensor: 'silhouette', ok: true, reason: null, pixelCount: null },
    { sensor: 'transparency', ok: true, reason: null, pixelCount: null },
    { sensor: 'edge-bleed', ok: true, reason: null, pixelCount: null },
  ];
  const run: QueueRun = {
    briefId: 'amber-amulet',
    runId: 'run-0002',
    candidates: [
      {
        index: 0,
        score: 3,
        outOf: 3,
        passed: true,
        combinedPassed: false,
        judge: null,
        sensors: allPass,
      },
      {
        index: 1,
        score: 3,
        outOf: 3,
        passed: true,
        combinedPassed: true,
        judge: {
          passed: true,
          minScore: 4,
          styleMatch: 5,
          briefMatch: 4,
          readability: 4,
          rejectedBy: [],
        },
        sensors: allPass,
      },
    ],
  };
  let state = addItem(createEmptyQueue(), 'Amber Amulet');
  const itemId = state.items[0]?.id ?? 'item-1';
  state = updateItem(state, itemId, { stage: 'postprocessed', run });
  return serializeQueue(state);
}

/** Save a screenshot to tmp/e2e-screenshots/ for debugging failures. */
function saveDebugShot(buf: Buffer, filename: string): void {
  try {
    const dir = resolve(process.cwd(), 'tmp', 'e2e-screenshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, filename), buf);
  } catch {
    // Non-fatal — debug screenshots are best-effort.
  }
}

describe('sprite workflow sensor-failure visibility + force-judge', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const seededQueue = makeSeededQueueJson();
  const detailQueue = makeDetailSeededQueueJson();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    page = await context.newPage();
    // Keep the render hermetic: abort every sidecar call so hydrate/health/state
    // fetches fail fast and the seeded localStorage cache stays authoritative.
    await page.route('**/api/**', (route) => route.abort());
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function loadSeededDevtools(queueJson: string = seededQueue): Promise<void> {
    // First load primes the origin so localStorage is writable, then we seed the
    // queue and reload — exercising the resume-after-refresh path from cache.
    await page.goto(DEVTOOLS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.evaluate(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [QUEUE_STORAGE_KEY, queueJson] as const,
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The run-candidates panel renders synchronously from cache on boot; wait for
    // its run header to confirm the panel mounted. The header reads either
    // "…post-processed, not yet judged" (no judged variant) or "…pass the judge"
    // (once any variant carries a verdict), so accept both. The timeout is
    // generous because a cold Vite dev server pays a one-time transform cost for
    // the large devtools module graph on the first hit under CI load.
    await page.waitForFunction(
      () => /post-processed|pass the judge/.test(document.body.textContent ?? ''),
      undefined,
      { timeout: 60_000 },
    );
  }

  it('renders which sensors failed and why per variant', async () => {
    await loadSeededDevtools();
    const buf = await page.screenshot({ type: 'png', fullPage: true });
    saveDebugShot(buf, 'sprite-workflow-sensors.png');

    const bodyText = (await page.locator('body').textContent()) ?? '';
    // The failing transparency sensor must surface its reason + pixel magnitude.
    expect(bodyText).toContain(`transparency: ${FAILED_SENSOR_REASON} (${FAILED_SENSOR_PIXELS}px)`);
    // The second failing sensor (no pixelCount) renders its bare reason.
    expect(bodyText).toContain('edge-bleed: edge-halo');
    // A failure tally header is shown for the gated variant.
    expect(bodyText).toMatch(/2\/3 sensors? failed/);
    // The all-passing variant shows the passed summary, not a failure list.
    expect(bodyText).toMatch(/3 sensors? passed/);
  });

  it('offers a force-judge override when a run has sensor failures', async () => {
    await loadSeededDevtools();
    // Run-level override button (hidden unless the run has gated variants). Its
    // visible label is "Force judge"; the override intent is in its tooltip.
    const forceRunButton = page.getByRole('button', { name: /^Force judge$/ });
    await forceRunButton.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await forceRunButton.isVisible()).toBe(true);
    // Per-variant override on the sensor-failed card.
    const forceVariantButton = page.getByRole('button', { name: /^Force judge variant$/ }).first();
    await forceVariantButton.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await forceVariantButton.isVisible()).toBe(true);
  });

  it('posts force flags to the judge endpoint from the override controls', async () => {
    // Mock the judge endpoint so the override controls have a real network call
    // to drive — still no Azure/LLM: we only assert the request payload, proving
    // the force wiring (force / variantIndexes) end-to-end through the UI.
    await page.route('**/api/runs/**/judge', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: { candidates: [] } }),
      });
    });
    try {
      // Run-level override → force the whole run past the sensor gate: { force: true }.
      await loadSeededDevtools();
      page.once('dialog', (dialog) => void dialog.accept());
      const runJudgeRequest = page.waitForRequest((req) => req.url().includes('/judge'));
      await page.getByRole('button', { name: /^Force judge$/ }).click();
      expect((await runJudgeRequest).postDataJSON()).toEqual({ force: true });

      // Per-variant override → force only the sensor-failed variant #0:
      // { force: true, variantIndexes: [0] }. Re-seed first to reset the run.
      await loadSeededDevtools();
      const variantJudgeRequest = page.waitForRequest((req) => req.url().includes('/judge'));
      await page
        .getByRole('button', { name: /^Force judge variant$/ })
        .first()
        .click();
      expect((await variantJudgeRequest).postDataJSON()).toEqual({
        force: true,
        variantIndexes: [0],
      });
    } finally {
      await page.unroute('**/api/runs/**/judge');
    }
  });

  // Parity guard (mirrors PR2b-1 discipline): the shared runJudge refactor only
  // ADDS the force option — the normal Judge button must keep PR2b-2's behavior
  // and send NO force/variantIndexes flags. An empty POST body proves the default
  // judge call is byte-identical (server applies the sensor gate as before).
  it('posts no force flag from the normal Judge button', async () => {
    await page.route('**/api/runs/**/judge', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: { candidates: [] } }),
      });
    });
    try {
      await loadSeededDevtools();
      // The normal Judge button (label exactly "Judge") is not confirm-gated and
      // is enabled at the `postprocessed` stage.
      const normalJudgeRequest = page.waitForRequest((req) => req.url().includes('/judge'));
      await page.getByRole('button', { name: /^Judge$/ }).click();
      // Empty body — no `force`, no `variantIndexes`: the default path is unchanged.
      expect((await normalJudgeRequest).postDataJSON()).toEqual({});
    } finally {
      await page.unroute('**/api/runs/**/judge');
    }
  });

  // Candidate-detail sidebar + the unjudged-label regression. A variant whose
  // sensors all pass but which was never judged (combinedPassed=false,
  // judge=null) must read as neutral "not judged" — NOT red "sensor fail" — and
  // clicking a judged variant's sprite must open an inline detail panel with the
  // named judge axes drawn straight from cache (the sidecar is aborted).
  it('labels an unjudged variant correctly and opens the detail sidebar on click', async () => {
    await loadSeededDevtools(detailQueue);
    const bodyText = (await page.locator('body').textContent()) ?? '';
    // Regression: the sensors-pass-but-unjudged variant reads as "not judged".
    expect(bodyText.toLowerCase()).toContain('not judged');
    // It is an all-sensors-pass variant, so it must NOT be tallied as a failure.
    expect(bodyText).not.toMatch(/sensors? failed/);

    // Clicking a card sprite opens the inline detail panel. Cards are ranked
    // combined-pass-first, so the first sprite is the judged variant #1.
    const sprite = page
      .locator('img[title="Click for the full judge scorecard + sensor detail"]')
      .first();
    await sprite.click();

    // The detail panel surfaces the FULL named judge axes (not the S/B/R chips).
    const judgeTitle = page.getByText('Judge (advisory)');
    await judgeTitle.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await judgeTitle.isVisible()).toBe(true);
    for (const axis of ['Crawler design language', 'Reference style match', 'Brief match', 'Readability']) {
      const axisLabel = page.getByText(axis, { exact: true });
      await axisLabel.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await axisLabel.isVisible()).toBe(true);
    }
    // And the per-variant header identifies which variant is open.
    const variantHeader = page.getByText('Variant #1', { exact: true });
    await variantHeader.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await variantHeader.isVisible()).toBe(true);

    const buf = await page.screenshot({ type: 'png', fullPage: true });
    saveDebugShot(buf, 'sprite-workflow-detail-panel.png');
  });

  // Issue #1 the user hit: approving a sprite never surfaced a GitHub issue,
  // because approve is local-only and the issue-creating check-in step had no UI
  // button. Drive the new "Check in to GitHub" button against a mocked
  // /api/checkin and prove the filed issue URL is rendered as a clickable link.
  it('checks in approved sprites and surfaces the filed asset-checkin issue link', async () => {
    await page.route('**/api/checkin/prepare', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assetCount: 1,
          branch: 'assets/checkin-2026-06-08-abc123',
          slug: 'checkin-2026-06-08-abc123',
          assets: [
            {
              assetPath: 'generated/slime-king-var-1.png',
              manifestKey: 'slime-king-var-1',
              briefId: 'slime-king',
              variantIndex: 1,
            },
          ],
          estimatedDuration: 'Pushing: ~5s · Filing issue: ~3s',
        }),
      });
    });
    await page.route('**/api/checkin', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          branch: 'assets/checkin-2026-06-08-abc123',
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
          assets: [
            {
              assetPath: 'generated/slime-king-var-1.png',
              manifestKey: 'slime-king-var-1',
              briefId: 'slime-king',
              variantIndex: 1,
            },
          ],
        }),
      });
    });
    try {
      await loadSeededDevtools();
      // The check-in button confirms before pushing/filing; accept the dialog.
      page.once('dialog', (dialog) => void dialog.accept());
      // Gate on the mocked /api/checkin response so the assertions below run once
      // the success result has been rendered.
      const checkinResponse = page.waitForResponse((res) => res.url().endsWith('/api/checkin'));
      await page.getByRole('button', { name: /^Check in to GitHub$/ }).click();
      await checkinResponse;
      const issueLink = page.getByRole('link', { name: /View asset-checkin issue/ });
      await issueLink.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await issueLink.getAttribute('href')).toBe(
        'https://github.com/nalfeo/Crawler/issues/99',
      );
      expect(await page.locator('body').textContent()).toContain(
        'Successfully checked in 1 asset on',
      );
      // Regression guard (issue #1 follow-up): the result + filed-issue link must
      // PERSIST. They used to live on the shared workflow-status line, which the
      // 1s renderWorkflowSelection poll overwrote with "Next: ..." within a
      // second — making the issue link vanish before the operator could click it.
      // The result now renders in a dedicated element; assert it survives a full
      // poll cycle (the poll interval is 1s).
      await page.waitForTimeout(1_200);
      expect(await issueLink.isVisible()).toBe(true);
      expect(await page.locator('body').textContent()).toContain(
        'Successfully checked in 1 asset on',
      );
    } finally {
      await page.unroute('**/api/checkin/prepare');
      await page.unroute('**/api/checkin');
    }
  });

  // Regression for the stale-sidecar 404 the user hit: a long-lived sidecar started
  // before the pre-flight route (#635) 404s on /api/checkin/prepare but still serves
  // the older /api/checkin. The UI must fall back — skip pre-flight, check in anyway
  // (sending NO slug so the sidecar computes its own branch) — and persist a
  // "restart the sidecar" note instead of aborting on the raw 404.
  it('falls back to a slug-less check-in when the sidecar lacks the pre-flight route', async () => {
    let checkinBody: unknown = null;
    await page.route('**/api/checkin/prepare', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Route POST:/api/checkin/prepare not found',
          error: 'Not Found',
          statusCode: 404,
        }),
      });
    });
    await page.route('**/api/checkin', async (route) => {
      checkinBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          branch: 'assets/checkin-2026-06-08-stale01',
          issueUrl: 'https://github.com/nalfeo/Crawler/issues/101',
          issueTitle: 'Asset check-in',
          issueBody: 'body',
          assets: [
            {
              assetPath: 'generated/slime-king-var-1.png',
              manifestKey: 'slime-king-var-1',
              briefId: 'slime-king',
              variantIndex: 1,
            },
          ],
        }),
      });
    });
    try {
      await loadSeededDevtools();
      page.once('dialog', (dialog) => void dialog.accept());
      const checkinResponse = page.waitForResponse((res) => res.url().endsWith('/api/checkin'));
      await page.getByRole('button', { name: /^Check in to GitHub$/ }).click();
      await checkinResponse;
      // The check-in still succeeds despite the missing pre-flight route.
      const issueLink = page.getByRole('link', { name: /View asset-checkin issue/ });
      await issueLink.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await issueLink.getAttribute('href')).toBe(
        'https://github.com/nalfeo/Crawler/issues/101',
      );
      // The fallback must NOT thread a stale slug — it sends an empty body so the
      // sidecar computes its own branch (exactly the pre-#635 behavior).
      expect(checkinBody).toEqual({});
      // The actionable stale-sidecar hint persists past a full poll cycle (1s).
      await page.waitForTimeout(1_200);
      expect(await page.locator('body').textContent()).toContain('sprites:gallery');
      expect(await issueLink.isVisible()).toBe(true);
    } finally {
      await page.unroute('**/api/checkin/prepare');
      await page.unroute('**/api/checkin');
    }
  });

  // A sidecar so old it lacks even /api/checkin (or any route regression) must not
  // dump the raw Fastify 404 on the operator — it gets the actionable hint instead,
  // in the persistent result element, with no false success banner.
  it('shows the stale-sidecar hint (not a raw 404) when /api/checkin is missing', async () => {
    await page.route('**/api/checkin/prepare', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assetCount: 1,
          branch: 'assets/checkin-2026-06-08-stale02',
          slug: 'checkin-2026-06-08-stale02',
          assets: [
            {
              assetPath: 'generated/slime-king-var-1.png',
              manifestKey: 'slime-king-var-1',
              briefId: 'slime-king',
              variantIndex: 1,
            },
          ],
          estimatedDuration: 'Pushing: ~5s · Filing issue: ~3s',
        }),
      });
    });
    await page.route('**/api/checkin', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Route POST:/api/checkin not found',
          error: 'Not Found',
          statusCode: 404,
        }),
      });
    });
    try {
      await loadSeededDevtools();
      page.once('dialog', (dialog) => void dialog.accept());
      const checkinResponse = page.waitForResponse((res) => res.url().endsWith('/api/checkin'));
      await page.getByRole('button', { name: /^Check in to GitHub$/ }).click();
      await checkinResponse;
      await page.waitForFunction(() => document.body.textContent?.includes('sprites:gallery'));
      const bodyText = await page.locator('body').textContent();
      // The raw Fastify 404 text must NOT be surfaced to the operator...
      expect(bodyText).not.toContain('Route POST:/api/checkin not found');
      // ...and there must be no false success banner.
      expect(bodyText).not.toContain('Successfully checked in');
    } finally {
      await page.unroute('**/api/checkin/prepare');
      await page.unroute('**/api/checkin');
    }
  });

  // Issue #2 the user hit: a Judge (or PostProcess) request had no Cancel/retry,
  // so a hung step wedged the button until a page reload. Hold the judge request
  // pending, prove the shared "Cancel step" button appears, cancel it, and prove
  // the prior stage is restored (Judge re-enabled) so the step can be retried.
  it('cancels a running Judge step and restores the prior stage for retry', async () => {
    let releaseJudge: () => void = () => {};
    const judgeHang = new Promise<void>((resolve) => {
      releaseJudge = resolve;
    });
    await page.route('**/api/runs/**/judge', async (route) => {
      await judgeHang; // keep the request pending so the Cancel button stays visible
      try {
        await route.abort();
      } catch {
        // The client AbortController already canceled the request — nothing to do.
      }
    });
    try {
      await loadSeededDevtools();
      // Drain the startup checkWorkflowHealth() async call before interacting.
      // All /api/** requests are aborted in this suite, so the health check
      // fails fast and writes "Sidecar unreachable…" to workflowStatus. Without
      // this drain, the health-check write can race the synchronous "Canceled
      // Judge" assertion below and overwrite it before waitForFunction polls —
      // causing a 10 s timeout flake in CI under heavy CPU load.
      await page.waitForFunction(
        () => /Sidecar unreachable/.test(document.body.textContent ?? ''),
        undefined,
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: /^Judge$/ }).click();
      const cancelStep = page.getByRole('button', { name: /^Cancel step$/ });
      await cancelStep.waitFor({ state: 'visible', timeout: 10_000 });
      await cancelStep.click();
      // The cancel handler restores the prior stage and records a sticky
      // "Canceled Judge" note that renderWorkflowSelection re-surfaces, so a slow
      // boot task finishing later can no longer clobber it back to "Next: Judge".
      // Poll for the status text rather than racing a single synchronous read.
      await page.waitForFunction(
        () => /Canceled Judge/.test(document.body.textContent ?? ''),
        undefined,
        { timeout: 10_000 },
      );
      expect(await page.locator('body').textContent()).toMatch(/Canceled Judge/);
      // Retry is possible: the trigger button is re-enabled and the cancel button
      // hides again now that no step is in flight.
      await cancelStep.waitFor({ state: 'hidden', timeout: 10_000 });
      expect(await page.getByRole('button', { name: /^Judge$/ }).isEnabled()).toBe(true);
      expect(await cancelStep.isVisible()).toBe(false);
    } finally {
      releaseJudge();
      await page.unroute('**/api/runs/**/judge');
    }
  });
});
