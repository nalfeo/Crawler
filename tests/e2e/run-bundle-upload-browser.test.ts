import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';

const PORT = 5301;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const INGEST_URL = 'https://example.test/api/runs';

let server: ChildProcess | null = null;
let browser: Browser;
let page: Page;

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          rejectReady(new Error(`Timed out waiting for Vite on port ${port}`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
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
    await waitForPort(PORT);
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
