/**
 * Focused unit coverage for `defaultRunBundleSink` — the default `onRunBundle`
 * hook wired into every real floor via `createFloorMainSceneOptions()` (see
 * `src/bootstrap/floor-main-scene-options.ts`). The function itself isn't
 * exported (it's an implementation detail of the bootstrap module), so this
 * exercises it the same way the shipped game does: through
 * `createFloorMainSceneOptions(floorId).onRunBundle`.
 *
 * This complements (does not replace) the real-network, real-scene proof in
 * `tests/e2e/run-bundle-completion-telemetry.test.ts` — that suite observes
 * the production scene/bootstrap boundary end-to-end in a browser; this test
 * isolates the previously-buggy swallow-on-throw branch at unit speed.
 *
 * Regression covered: an unexpected rejection from `submitRunBundleUpload`
 * (which normally catches its own fetch/network errors and *resolves*
 * instead of rejecting) used to be swallowed by a bare `.catch(console.warn)`
 * that returned `undefined`, discarding the failure from anything awaiting
 * this sink's result — including `MainGameScene`'s completion-telemetry
 * status toast, which then had nothing to report to the player.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import type { RunBundleUploadResult } from '../../src/engine/run-bundle-upload.js';

vi.mock('../../src/engine/run-bundle-upload.js', () => ({
  submitRunBundleUpload: vi.fn(),
}));

// Imported AFTER the mock so both pick up the mocked module (vi.mock calls
// are hoisted above imports by Vitest, but the ordering here keeps the
// dependency intentionally explicit for readers).
const { submitRunBundleUpload } = await import('../../src/engine/run-bundle-upload.js');
const { createFloorMainSceneOptions } =
  await import('../../src/bootstrap/floor-main-scene-options.js');

const makeBundle = () =>
  createRunBundle({
    runStats: { outcome: 'death' },
    recorderJsonl: '',
    logs: [],
    meta: { endReason: 'death', floorId: 'floor1', seed: 1, runId: 'run-sink-test' },
  });

describe('defaultRunBundleSink (createFloorMainSceneOptions().onRunBundle)', () => {
  const originalWindow = (globalThis as unknown as { window?: Window }).window;

  afterEach(() => {
    vi.mocked(submitRunBundleUpload).mockReset();
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
    } catch {
      // globalThis.window may not be configurable in some environments.
    }
  });

  function stubBrowserWindow(): void {
    Object.defineProperty(globalThis, 'window', {
      value: { dispatchEvent: vi.fn() },
      configurable: true,
      writable: true,
    });
  }

  it('resolves a well-formed failure result instead of swallowing an unexpected rejection into undefined', async () => {
    stubBrowserWindow();
    vi.mocked(submitRunBundleUpload).mockRejectedValueOnce(new Error('network exploded'));

    const options = createFloorMainSceneOptions('floor1');
    const result = await options.onRunBundle?.(makeBundle());

    expect(result).toEqual({
      ok: false,
      used: 'fetch',
      reason: 'network exploded',
    } satisfies RunBundleUploadResult);
  });

  it('resolves a well-formed failure result with a generic reason for a non-Error rejection', async () => {
    stubBrowserWindow();
    vi.mocked(submitRunBundleUpload).mockRejectedValueOnce('a string, not an Error');

    const options = createFloorMainSceneOptions('floor1');
    const result = await options.onRunBundle?.(makeBundle());

    expect(result).toEqual({
      ok: false,
      used: 'fetch',
      reason: 'run bundle upload failed',
    } satisfies RunBundleUploadResult);
  });

  it('passes through the ok/used/status/reason result submitRunBundleUpload reports, unmodified', async () => {
    stubBrowserWindow();
    const reported: RunBundleUploadResult = { ok: true, used: 'fetch', status: 202 };
    vi.mocked(submitRunBundleUpload).mockResolvedValueOnce(reported);

    const options = createFloorMainSceneOptions('floor1');
    const result = await options.onRunBundle?.(makeBundle());

    expect(result).toEqual(reported);
  });

  it('passes through a disabled result without re-deriving it from resolveRunBundleUploadConfig', async () => {
    stubBrowserWindow();
    const reported: RunBundleUploadResult = {
      ok: false,
      used: 'disabled',
      reason: 'no ingest endpoint configured for this build',
    };
    vi.mocked(submitRunBundleUpload).mockResolvedValueOnce(reported);

    const options = createFloorMainSceneOptions('floor1');
    const result = await options.onRunBundle?.(makeBundle());

    expect(result).toEqual(reported);
  });

  it('no-ops (does not throw) when window is undefined (non-browser/SSR context)', async () => {
    const options = createFloorMainSceneOptions('floor1');
    const result = await options.onRunBundle?.(makeBundle());
    expect(result).toBeUndefined();
    expect(submitRunBundleUpload).not.toHaveBeenCalled();
  });
});
