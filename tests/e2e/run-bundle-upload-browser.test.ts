import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';

const PORT = 5301;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const INGEST_URL = 'https://example.test/api/runs';

let server: ChildProcess | null = null;
let browser: Browser;
let page: Page;

// A bare TCP connect can succeed the instant Vite's listening socket is bound
// (accepted into the kernel backlog) even if the dev-server process then
// crashes or is still mid-startup, leaving `page.goto` to race an
// ERR_CONNECTION_REFUSED a few milliseconds later. Probe with an actual HTTP
// request instead so readiness means "serving", not just "listening".
function waitForServerReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (): Promise<void> => {
    try {
      await fetch(url);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for Vite to serve ${url}`);
      }
      await new Promise((r) => setTimeout(r, 100));
      return attempt();
    }
  };
  return attempt();
}

describe('run bundle upload browser configuration', () => {
  beforeAll(async () => {
    const viteBin = resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
    server = spawn(
      process.execPath,
      [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      {
        cwd: process.cwd(),
        env: { ...process.env, VITE_RUNS_INGEST_URL: INGEST_URL },
        stdio: 'ignore',
      },
    );
    await waitForServerReady(BASE_URL);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    server?.kill('SIGTERM');
    server = null;
    await closeQuietly(browser);
  });

  it('injects the dev ingest endpoint into browser run and survey uploads', async () => {
    const requests: { url: string; mode: string | undefined }[] = [];
    await page.route(INGEST_URL, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type,x-run-upload-mode',
          },
        });
        return;
      }
      requests.push({
        url: request.url(),
        mode: request.headers()['x-run-upload-mode'],
      });
      await route.fulfill({
        status: 202,
        headers: { 'access-control-allow-origin': '*' },
      });
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const [{ submitRunBundleUpload, submitRunSurvey }, { createRunBundle }] = (await new Function(
        'return Promise.all([import("/src/engine/run-bundle-upload.ts"), import("/src/shared/run-bundle.ts")])',
      )()) as [
        {
          submitRunBundleUpload: (bundle: unknown) => Promise<unknown>;
          submitRunSurvey: (bundle: unknown, survey: unknown) => Promise<unknown>;
        },
        { createRunBundle: (options: unknown) => unknown },
      ];
      const bundle = createRunBundle({
        runStats: { outcome: 'victory', finalLevel: 5 },
        recorderJsonl: 'event=run-start\n',
        logs: ['run start'],
        meta: { endReason: 'victory', floorId: 'floor1', seed: 13, runId: 'browser-run' },
      });
      return Promise.all([
        submitRunBundleUpload(bundle),
        submitRunSurvey(bundle, {
          enjoyment: 5,
          immersion: 5,
          mastery: 5,
          control: 5,
          tension: 5,
          comment: '',
        }),
      ]);
    });

    expect(result).toEqual([
      { ok: true, used: 'fetch', status: 202 },
      { ok: true, used: 'fetch', status: 202 },
    ]);
    expect(requests).toEqual([
      { url: INGEST_URL, mode: 'silent' },
      { url: INGEST_URL, mode: 'survey' },
    ]);
  });
});
