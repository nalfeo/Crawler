import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import {
  resolveRunBundleUploadConfig,
  submitRunBundleUpload,
  submitRunSurvey,
} from '../../src/engine/run-bundle-upload.js';

const makeBundle = () =>
  createRunBundle({
    runStats: { outcome: 'victory', finalLevel: 5 },
    recorderJsonl: 'event=run-start\n',
    logs: ['run start', 'player died'],
    meta: { endReason: 'victory', floorId: 'floor1', seed: 13, runId: 'run-abc123' },
  });

describe('run bundle upload delivery', () => {
  const originalWindow = (globalThis as unknown as { window?: Window }).window;
  const originalNavigator = (globalThis as unknown as { navigator?: Navigator }).navigator;

  afterEach(() => {
    try {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis as typeof globalThis & { window?: Window }, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: originalWindow,
          configurable: true,
          writable: true,
        });
      }
    } catch (_) {
      // globalThis.window may not be configurable in some environments
    }
    try {
      if (originalNavigator === undefined) {
        Reflect.deleteProperty(
          globalThis as typeof globalThis & { navigator?: Navigator },
          'navigator',
        );
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        });
      }
    } catch (_) {
      // globalThis.navigator may not be configurable in some environments
    }
  });

  it('disables uploads when no endpoint is configured', () => {
    const config = resolveRunBundleUploadConfig();
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBeNull();
  });

  it('resolves the endpoint from VITE_CRAWLER_RUNS_API_ENDPOINT (vite.config.ts define key)', () => {
    const original = process.env.VITE_CRAWLER_RUNS_API_ENDPOINT;
    process.env.VITE_CRAWLER_RUNS_API_ENDPOINT = 'https://example.test/api/runs';
    try {
      const config = resolveRunBundleUploadConfig();
      expect(config.enabled).toBe(true);
      expect(config.endpoint).toBe('https://example.test/api/runs');
      expect(config.source).toBe('env');
    } finally {
      if (original === undefined) {
        delete process.env.VITE_CRAWLER_RUNS_API_ENDPOINT;
      } else {
        process.env.VITE_CRAWLER_RUNS_API_ENDPOINT = original;
      }
    }
  });

  it('uses sendBeacon during quit/unload-safe submits', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(globalThis, 'window', {
      value: {
        __CRAWLER_RUN_BUNDLE_ENDPOINT__: 'https://example.test/uploads/run-bundle',
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        sendBeacon: beacon,
      },
      configurable: true,
      writable: true,
    });

    const bundle = makeBundle();
    const result = await submitRunBundleUpload(bundle, {
      endReason: 'quit',
      navigatorLike: { sendBeacon: beacon } as unknown as Pick<Navigator, 'sendBeacon'>,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result.used).toBe('sendBeacon');
    expect(result.ok).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    const calls = beacon.mock.calls as unknown[][];
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0] as unknown[])[0]).toBe('https://example.test/uploads/run-bundle');
  });

  it('serializes the silent upload body with top-level runStats/recorderJsonl/logs/meta', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    Object.defineProperty(globalThis, 'window', {
      value: {
        __CRAWLER_RUN_BUNDLE_ENDPOINT__: 'https://example.test/uploads/run-bundle',
      },
      configurable: true,
      writable: true,
    });

    const bundle = makeBundle();
    const result = await submitRunBundleUpload(bundle, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    const calls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const [, init] = (calls[0] ?? []) as [unknown, { body?: string }];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      runStats: bundle.runStats,
      recorderJsonl: bundle.recorderJsonl,
      logs: bundle.logs,
      meta: bundle.meta,
    });
    expect(body.survey).toBeUndefined();
  });

  it('emits a survey payload with the same top-level shape plus survey', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    Object.defineProperty(globalThis, 'window', {
      value: {
        __CRAWLER_RUN_BUNDLE_ENDPOINT__: 'https://example.test/uploads/run-bundle',
      },
      configurable: true,
      writable: true,
    });

    const bundle = makeBundle();
    const payload = {
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 5,
      tension: 2,
      comment: 'The tension was excellent.  ',
    };

    const result = await submitRunSurvey(bundle, payload, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, init] = (calls[0] ?? []) as [unknown, { body?: string }];
    const body = JSON.parse(String(init?.body));
    expect(body.runStats).toEqual(bundle.runStats);
    expect(body.recorderJsonl).toBe(bundle.recorderJsonl);
    expect(body.logs).toEqual(bundle.logs);
    expect(body.meta).toEqual(bundle.meta);
    expect(body.survey).toEqual(payload);
  });
});
