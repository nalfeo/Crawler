/**
 * Unit tests for the gallery lab's approve helper.
 *
 * The gallery's DOM rendering is exercised manually in the lab; this file
 * pins the network contract of `postApprove` so the sidecar wire shape
 * (POST /api/runs/:brief/:run/approve with `{ variantIndex }`) can't drift.
 */

import { describe, expect, it, vi } from 'vitest';
import { postApprove } from '../../src/labs/sprite-gallery-lab/index.js';

describe('postApprove (gallery lab → sidecar)', () => {
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
});
