import { describe, expect, it, vi } from 'vitest';
import { extractSensorFailures, postReprocess } from '../../src/labs/sprite-gallery-lab/index.js';

describe('extractSensorFailures', () => {
  it('returns only failing sensors with reasons', () => {
    const candidate = {
      breakdown: [
        { ok: true, sensor: 'dimensions-exact' },
        { ok: false, sensor: 'opaque-bbox-fits', reason: 'main silhouette touches frame edge' },
        { ok: false, sensor: 'weapon-orientation', reason: 'expected diagonal' },
      ],
    } as Record<string, unknown>;

    expect(extractSensorFailures(candidate)).toEqual([
      { sensor: 'opaque-bbox-fits', reason: 'main silhouette touches frame edge' },
      { sensor: 'weapon-orientation', reason: 'expected diagonal' },
    ]);
  });

  it('ignores malformed breakdown entries', () => {
    const candidate = {
      breakdown: [{ ok: false, sensor: 'a' }, { ok: false, reason: 'missing sensor' }, null],
    } as Record<string, unknown>;

    expect(extractSensorFailures(candidate)).toEqual([]);
  });
});

describe('postReprocess (gallery lab → sidecar)', () => {
  it('posts JSON payload to the reprocess endpoint and returns parsed runs', async () => {
    const fakeResponse = {
      sourceRunDir: 'generated/runs/characters/old-run',
      briefPath: 'briefs/characters/african-american-female.yaml',
      runs: [
        {
          profile: 'edge-drop',
          briefId: 'african-american-female',
          runId: 'new-run-a',
          runDir: 'generated/runs/african-american-female/new-run-a',
          summaryPath: 'generated/runs/african-american-female/new-run-a/summary.json',
        },
      ],
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const payload = {
      sourceBriefId: 'african-american-female',
      sourceRunId: 'old-run',
      profileA: { name: 'edge-drop', modules: { speckleMode: 'edge-drop' as const } },
    };

    const out = await postReprocess(payload, fetcher as unknown as typeof fetch);

    expect(out).toEqual(fakeResponse);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3010/api/workflow/reprocess');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('surfaces sidecar errors for non-2xx responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'reprocess-failed', message: 'bad source run' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      postReprocess(
        { sourceBriefId: 'a', sourceRunId: 'b', profileA: { name: 'A' } },
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/reprocess failed \(500\): bad source run/);
  });
});
