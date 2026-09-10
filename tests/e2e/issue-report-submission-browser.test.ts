/**
 * Deterministic observation: filing an in-game issue through the REAL F8
 * issue-report picker (not an isolated `submitFileIssue()` import) actually
 * reaches the configured deployed issue endpoint, and the player sees a
 * visible success/failure confirmation (AGENTS.md rule #9 — "observe before
 * done").
 *
 * `tests/e2e/run-bundle-upload-browser.test.ts` proves the isolated
 * `submitFileIssue()`/`buildFileIssuePayload()` request-building logic, and
 * `tests/e2e/main-game-scene-ui-exclusivity.test.ts` proves the F8 picker's
 * pause/exclusivity behavior — but neither drives the full real
 * describe-then-submit flow through the shipped `MainGameScene` and checks
 * (a) the actual outbound request payload, or (b) the rendered
 * `flashActionStatus()` confirmation text `submitIssueReport()` shows afterward.
 *
 * This suite boots the real scene via `main-scene-probe-lab` (same
 * `createFloorMainSceneOptions()` bootstrap the shipped game uses), presses
 * the real F8 shortcut, answers the real `window.prompt()` description
 * dialog, navigates the real `issueReportPicker` (a second `ModalPickerUI`
 * instance, distinct from the shared `modalPicker`) to "Submit issue" via
 * keyboard, and observes the actual outbound `fetch` request plus the real
 * rendered `flashActionStatus()` confirmation text.
 *
 * Determinism: fixed lab seed, single scripted network response per test (no
 * timers/randomness in the assertions), and both `waitForState` and the
 * local `waitForIssueReportContent` poll the real rendered projection rather
 * than a wall-clock sleep.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

const INGEST_URL = 'https://example.test/api/runs';

interface CapturedIssueRequest {
  readonly file_issue?: boolean;
  readonly issue_description?: string;
  readonly runStats?: unknown;
  readonly recorderJsonl?: unknown;
  readonly logs?: unknown;
  readonly meta?: {
    readonly seed?: unknown;
    readonly runId?: unknown;
  };
}

/** Inject the window-scoped ingest endpoint override BEFORE the lab boots. */
async function installRunBundleEndpoint(page: Page): Promise<void> {
  await page.addInitScript((url) => {
    (
      window as unknown as { __CRAWLER_RUN_BUNDLE_ENDPOINT__?: string }
    ).__CRAWLER_RUN_BUNDLE_ENDPOINT__ = url;
  }, INGEST_URL);
}

/** Answer the CORS preflight every cross-origin POST with a JSON body triggers. */
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

/** Poll the real F8 issue-report picker's rendered content until `predicate` holds. */
async function waitForIssueReportContent(
  page: Page,
  predicate: (
    content: Awaited<ReturnType<typeof mainSceneProbe.getIssueReportPickerContent>>,
  ) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const content = await mainSceneProbe.getIssueReportPickerContent(page);
    if (predicate(content)) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last content: ${JSON.stringify(content)}`);
    }
    await page.waitForTimeout(80);
  }
}

describe('in-game issue filing (production scene/bootstrap boundary)', () => {
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

  /** Drives F8 → describe → Submit through the real picker via keyboard only. */
  async function fileIssueThroughRealPicker(page: Page, description: string): Promise<void> {
    await page.keyboard.press('F8');
    await waitForState(page, (s) => s.issueReportOpen, { label: 'issue picker opened' });

    // Option 0 ("Describe issue") is selected by default on open — Enter
    // triggers the real `window.prompt()` dialog, intercepted above.
    await page.keyboard.press('Enter');
    await waitForIssueReportContent(
      page,
      (content) => content?.body === `Description: ${description}`,
      'description recorded in the reopened picker',
    );

    // The picker's selection resets to option 0 on every reopen, so walk
    // down from "Describe issue" (0) past "logs" (1) and "screenshot" (2)
    // to reach "Submit issue" (3).
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    // Exactly-once guard: hammering the submit button should not bypass the submitting latch.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  }

  it('publishes the issue payload exactly once and shows a visible success confirmation', async () => {
    const page = await newPage();
    const description = 'Sword swing did not register a hit against the training dummy.';
    page.once('dialog', (dialog) => {
      void dialog.accept(description);
    });
    await installRunBundleEndpoint(page);

    const requests: CapturedIssueRequest[] = [];
    await page.route(INGEST_URL, async (route) => {
      if (await fulfillPreflight(route)) {
        return;
      }
      const body = route.request().postDataJSON() as CapturedIssueRequest;
      requests.push(body);
      await route.fulfill({
        status: 202,
        headers: { 'access-control-allow-origin': '*' },
        json: {
          runId: 'e2e-issue-run',
          issueUrl: 'https://github.com/example/crawler/issues/1234',
        },
      });
    });

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);

    await fileIssueThroughRealPicker(page, description);

    await waitForState(page, (s) => !s.issueReportOpen, {
      label: 'issue picker closed after successful submit',
    });
    await waitForState(page, (s) => s.actionStatusToastVisible, {
      label: 'issue submission success feedback visible',
    });

    const state = await mainSceneProbe.getState(page);
    expect(state.actionStatusToastText).toMatch(/^Issue created: /);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.file_issue).toBe(true);
    expect(requests[0]?.issue_description).toBe(description);

    // Payload completeness: must be a full RunBundle.
    expect(requests[0]?.runStats).toBeDefined();
    expect(requests[0]?.recorderJsonl).toBeDefined();
    expect(requests[0]?.logs).toBeDefined();
    expect(requests[0]?.meta?.seed).toBeDefined();
    expect(requests[0]?.meta?.runId).toBeDefined();
  });

  it('shows a visible failure confirmation when the issue endpoint rejects the submission', async () => {
    const page = await newPage();
    const description = 'Enemy AI got stuck inside a wall on Floor 1.';
    page.once('dialog', (dialog) => {
      void dialog.accept(description);
    });
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
        json: { error: 'issue service unavailable' },
      });
    });

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);

    await fileIssueThroughRealPicker(page, description);

    await waitForState(page, (s) => !s.issueReportOpen, {
      label: 'issue picker closed after failed submit',
    });
    await waitForState(page, (s) => s.actionStatusToastVisible, {
      label: 'issue submission failure feedback visible',
    });

    const state = await mainSceneProbe.getState(page);
    expect(state.actionStatusToastText).toMatch(/^Could not submit issue: /);
    expect(requestCount).toBe(1);
  });
});
