import { describe, expect, it, vi } from 'vitest';
import {
  extractVariantIndices,
  listSidecarRuns,
  postApprove,
  postCheckin,
  prepareCheckin,
  ApproveRequestError,
  CheckinRequestError,
} from '../../src/devtools/sprite-approval-api.js';

describe('devtools sprite approval api', () => {
  it('posts JSON {variantIndex} to the approve endpoint and returns the parsed entry', async () => {
    const fakeEntry = {
      briefId: 'iron-sword',
      spriteName: 'iron-sword-var-1',
      assetPath: 'generated/iron-sword-var-1.png',
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

  it('throws ApproveRequestError carrying status + errorCode on a 409 conflict', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'already-approved', message: 'Variant is already approved.' }),
        {
          status: 409,
          statusText: 'Conflict',
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const error = await postApprove(
      'iron-sword',
      'run-1',
      1,
      fetcher as unknown as typeof fetch,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApproveRequestError);
    expect((error as ApproveRequestError).status).toBe(409);
    expect((error as ApproveRequestError).errorCode).toBe('already-approved');
    expect((error as ApproveRequestError).message).toMatch(/approve failed \(409\): /);
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
              promotionState: 'not-promoted',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const runs = await listSidecarRuns({}, fetcher as unknown as typeof fetch);
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

describe('devtools sprite check-in api', () => {
  it('POSTs an empty body to /api/checkin and returns the parsed payload', async () => {
    const payload = {
      branch: 'assets/checkin-2026-06-08-abc123',
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/42',
      issueTitle: 'Asset check-in: 1 approved asset (checkin-20260608-190815-abc123)',
      issueBody: '## Asset check-in\n\nFiled from devtools.\n',
      assets: [
        {
          assetPath: 'generated/slime-king-var-1.png',
          manifestKey: 'slime-king-var-1',
          briefId: 'slime-king',
          variantIndex: 1,
        },
      ],
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await postCheckin(undefined, fetcher as unknown as typeof fetch);

    expect(result).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3010/api/checkin');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws CheckinRequestError carrying status + errorCode on a 409 nothing-to-checkin', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'nothing-to-checkin',
          message: 'No approved assets differ from origin/main.',
        }),
        { status: 409, statusText: 'Conflict', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const error = await postCheckin(undefined, fetcher as unknown as typeof fetch).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(CheckinRequestError);
    expect((error as CheckinRequestError).status).toBe(409);
    expect((error as CheckinRequestError).errorCode).toBe('nothing-to-checkin');
    expect((error as CheckinRequestError).message).toMatch(/check-in failed \(409\): /);
  });

  it('falls back to status text when the error body is not JSON', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 502, statusText: 'Bad Gateway' }));
    await expect(postCheckin(undefined, fetcher as unknown as typeof fetch)).rejects.toThrow(
      /check-in failed \(502\): Bad Gateway/,
    );
  });

  it('POSTs {slug} to /api/checkin when slug is provided', async () => {
    const payload = {
      branch: 'assets/checkin-2026-06-08-abc123',
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/42',
      issueTitle: 'Asset check-in: 1 approved asset (checkin-20260608-190815-abc123)',
      issueBody: '## Asset check-in\n\nFiled from devtools.\n',
      assets: [],
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await postCheckin('checkin-20260608-190815-abc123', fetcher as unknown as typeof fetch);
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ slug: 'checkin-20260608-190815-abc123' });
  });

  it('POSTs to /api/checkin/prepare and returns the parsed payload', async () => {
    const payload = {
      assetCount: 1,
      branch: 'assets/checkin-20260608-190815-abc123',
      slug: 'checkin-20260608-190815-abc123',
      assets: [
        {
          assetPath: 'generated/slime-king-var-1.png',
          manifestKey: 'slime-king-var-1',
          briefId: 'slime-king',
          variantIndex: 1,
        },
      ],
      estimatedDuration: 'Pushing: ~5s · Filing issue: ~3s',
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const result = await prepareCheckin(fetcher as unknown as typeof fetch);
    expect(result).toEqual(payload);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3010/api/checkin/prepare');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws CheckinRequestError for prepare checkin non-2xx responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'nothing-to-checkin',
          message: 'No approved assets differ from origin/main.',
        }),
        { status: 409, statusText: 'Conflict', headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const error = await prepareCheckin(fetcher as unknown as typeof fetch).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(CheckinRequestError);
    expect((error as CheckinRequestError).status).toBe(409);
    expect((error as CheckinRequestError).errorCode).toBe('nothing-to-checkin');
    expect((error as CheckinRequestError).message).toMatch(/prepare failed \(409\): /);
  });
});
