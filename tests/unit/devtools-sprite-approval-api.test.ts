import { describe, expect, it, vi } from 'vitest';
import {
  extractVariantIndices,
  listSidecarRuns,
  postApprove,
} from '../../src/devtools/sprite-approval-api.js';

describe('devtools sprite approval api', () => {
  it('posts JSON {variantIndex} to the approve endpoint and returns the parsed entry', async () => {
    const fakeEntry = {
      briefId: 'iron-sword',
      spriteName: 'iron-sword',
      assetPath: 'generated/iron-sword.png',
      approvedAt: '2026-06-08T15:30:00.000Z',
      sourceRun: 'generated/runs/iron-sword/2026-06-08T12-00-00-deadbeef',
      variantIndex: 1,
      anchor: { x: 8, y: 13, source: 'brief' },
      sensorScore: '7/7',
      judgeScore: '4',
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeEntry), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const entry = await postApprove(
      'iron-sword',
      '2026-06-08T12-00-00-deadbeef',
      1,
      fetcher as unknown as typeof fetch,
    );

    expect(entry).toEqual(fakeEntry);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      'http://127.0.0.1:3010/api/runs/iron-sword/2026-06-08T12-00-00-deadbeef/approve',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ variantIndex: 1 });
  });

  it('URL-encodes path segments so a slash in briefId cannot escape the route', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    await postApprove('a/b', 'run-1', 0, fetcher as unknown as typeof fetch);
    const [url] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3010/api/runs/a%2Fb/run-1/approve');
  });

  it('surfaces the sidecar error message on a non-2xx response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'variant-not-found', message: 'no such variant' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      postApprove('iron-sword', 'run-1', 99, fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/approve failed \(404\): no such variant/);
  });

  it('falls back to status text when the error body is not JSON', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
      );
    await expect(
      postApprove('iron-sword', 'run-1', 0, fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/approve failed \(500\): Internal Server Error/);
  });

  it('parses sidecar run list response payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          runs: [
            {
              briefId: 'iron-sword',
              runId: '2026-06-08T12-00-00-deadbeef',
              timestamp: '2026-06-08T12:00:00Z',
              briefHash: 'deadbeef',
              chosenIndex: 2,
              candidateCount: 4,
              hasJudge: true,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const runs = await listSidecarRuns(fetcher as unknown as typeof fetch);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.briefId).toBe('iron-sword');
  });

  it('extracts variant indices from summary candidates with index fallback', () => {
    const indices = extractVariantIndices({
      candidates: [{ index: 3 }, {}, { index: 5 }, { index: 3 }],
    });
    expect(indices).toEqual([3, 1, 5]);
  });
});
