import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { HttpRequest, InvocationContext } from '@azure/functions';

interface FakeBlob {
  data: Buffer;
  lastModified: Date;
}

const blobs = new Map<string, FakeBlob>();
let beforeUploadData: ((name: string, data: Uint8Array) => void) | undefined;

function makeBlockBlobClient(name: string) {
  return {
    exists: async () => blobs.has(name),
    uploadData: async (data: Uint8Array, options?: { conditions?: { ifNoneMatch?: string } }) => {
      beforeUploadData?.(name, data);
      if (options?.conditions?.ifNoneMatch === '*' && blobs.has(name)) {
        const conflict = new Error('blob already exists') as Error & { statusCode?: number };
        conflict.statusCode = 412;
        throw conflict;
      }
      blobs.set(name, { data: Buffer.from(data), lastModified: new Date() });
    },
    downloadToBuffer: async () => blobs.get(name)?.data ?? Buffer.alloc(0),
    deleteIfExists: async () => {
      blobs.delete(name);
    },
    getProperties: async () => ({ lastModified: blobs.get(name)?.lastModified }),
  };
}

function makeContainer() {
  return {
    containerName: 'playtest-runs',
    url: 'https://example.blob.core.windows.net/playtest-runs',
    getBlockBlobClient: (name: string) => makeBlockBlobClient(name),
    listBlobsFlat: (options: { prefix: string }) => {
      const names = [...blobs.keys()].filter((key) => key.startsWith(options.prefix));
      return (async function* () {
        for (const name of names) yield { name };
      })();
    },
  };
}

vi.mock('@azure/storage-blob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azure/storage-blob')>();
  return {
    ...actual,
    BlobServiceClient: {
      fromConnectionString: () => ({
        getContainerClient: () => makeContainer(),
      }),
    },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { handleRuns } = await import('../../functions/dev-build-ingest/src/index.js');

const fakeAccountKey = Buffer.from('unit-test-account-key').toString('base64');

const validRun = {
  runStats: { outcome: 'win' },
  recorderJsonl: '{"frame":1}\n',
  logs: 'ok',
  meta: { version: 'dev' },
};

function makeRequest(
  body: unknown,
  origin = 'https://nalfeo.github.io',
  headers: Record<string, string> = {},
): HttpRequest {
  const text = JSON.stringify(body);
  return {
    method: 'POST',
    headers: new Headers({
      origin,
      'content-length': String(Buffer.byteLength(text, 'utf8')),
      ...headers,
    }),
    text: async () => text,
  } as unknown as HttpRequest;
}

const context = { info: () => undefined, error: () => undefined } as unknown as InvocationContext;

describe('handleRuns (mocked storage + GitHub)', () => {
  beforeEach(() => {
    blobs.clear();
    beforeUploadData = undefined;
    fetchMock.mockReset();
    process.env.AZURE_STORAGE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=${fakeAccountKey};EndpointSuffix=core.windows.net`;
    process.env.RUNS_CONTAINER = 'playtest-runs';
    process.env.CRAWLER_CI_PAT = 'unit-test-token';
    process.env.GITHUB_REPOSITORY = 'nalfeo/Crawler';
  });

  afterEach(() => {
    beforeUploadData = undefined;
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    delete process.env.RUNS_CONTAINER;
    delete process.env.CRAWLER_CI_PAT;
    delete process.env.GITHUB_REPOSITORY;
  });

  it('persists a silent run bundle without filing an issue', async () => {
    const result = await handleRuns(makeRequest(validRun), context);
    expect(result.status).toBe(201);
    const body = result.jsonBody as { runId: string; issueUrl?: string };
    expect(body.runId).toBeTruthy();
    expect(body.issueUrl).toBeUndefined();
    expect(blobs.has(`runs/${body.runId}/bundle.json`)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appends survey submissions to the existing runId without rewriting the bundle', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/nalfeo/Crawler/issues/101' }),
    });
    const completion = { ...validRun, meta: { runId: 'survey-run-1' } };
    const run = {
      meta: { runId: 'survey-run-1' },
      survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
    };
    const completed = await handleRuns(makeRequest(completion), context);
    expect(completed.status).toBe(201);
    const before = blobs.get('runs/survey-run-1/bundle.json')?.data.toString('utf8');

    const result = await handleRuns(
      makeRequest(run, 'https://nalfeo.github.io', { 'x-run-upload-mode': 'survey' }),
      context,
    );
    expect(result.status).toBe(201);
    const body = result.jsonBody as { runId: string; issueUrl?: string };
    expect(body.runId).toBe('survey-run-1');
    expect(body.issueUrl).toBe('https://github.com/nalfeo/Crawler/issues/101');
    expect(blobs.has('runs/survey-run-1/issue.json')).toBe(true);
    expect(blobs.has('runs/survey-run-1/survey.json')).toBe(true);
    expect(blobs.get('runs/survey-run-1/bundle.json')?.data.toString('utf8')).toBe(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.method).toBe('POST');
    expect(String(requestInit.body)).toContain('Survey ID: `');
  });

  it('includes an existing screenshot when survey append files the run issue', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/nalfeo/Crawler/issues/111' }),
    });
    const runId = 'survey-screenshot-run';
    await handleRuns(
      makeRequest(
        {
          ...validRun,
          meta: { runId },
          screenshot: 'iVBORw0KGgo=',
        },
        'https://nalfeo.github.io',
      ),
      context,
    );

    const result = await handleRuns(
      makeRequest(
        {
          meta: { runId },
          survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
        },
        'https://nalfeo.github.io',
        { 'x-run-upload-mode': 'survey' },
      ),
      context,
    );

    expect(result.status).toBe(201);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(requestInit.body)).toContain('Screenshot (expires in 7 days):');
  });

  it('keeps survey append retries idempotent and rejects conflicting feedback', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/nalfeo/Crawler/issues/102' }),
    });
    const completion = { ...validRun, meta: { runId: 'survey-retry-run' } };
    await handleRuns(makeRequest(completion), context);
    const survey = { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 };
    const request = () =>
      makeRequest({ meta: { runId: 'survey-retry-run' }, survey }, 'https://nalfeo.github.io', {
        'x-run-upload-mode': 'survey',
      });

    const first = await handleRuns(request(), context);
    const second = await handleRuns(request(), context);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const conflict = await handleRuns(
      makeRequest(
        {
          meta: { runId: 'survey-retry-run' },
          survey: { ...survey, tension: 5 },
        },
        'https://nalfeo.github.io',
        { 'x-run-upload-mode': 'survey' },
      ),
      context,
    );
    expect(conflict.status).toBe(409);
  });

  it('returns too early when survey append arrives before completion is stored', async () => {
    const result = await handleRuns(
      makeRequest(
        {
          meta: { runId: 'missing-completion-run' },
          survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
        },
        'https://nalfeo.github.io',
        { 'x-run-upload-mode': 'survey' },
      ),
      context,
    );

    expect(result.status).toBe(425);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appends survey feedback as a comment when an issue already exists for the run', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });
    const runId = 'existing-issue-run';
    await handleRuns(makeRequest({ ...validRun, meta: { runId } }), context);
    blobs.set(`runs/${runId}/issue.json`, {
      data: Buffer.from(JSON.stringify({ url: 'https://github.com/nalfeo/Crawler/issues/303' })),
      lastModified: new Date(),
    });

    const result = await handleRuns(
      makeRequest(
        {
          meta: { runId },
          survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
        },
        'https://nalfeo.github.io',
        { 'x-run-upload-mode': 'survey' },
      ),
      context,
    );

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/nalfeo/Crawler/issues/303/comments');
    expect(requestInit.method).toBe('POST');
  });

  it('returns the existing survey marker when an identical concurrent append wins the race', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1 }) });
    const runId = 'survey-race-run';
    const survey = { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 };
    await handleRuns(makeRequest({ ...validRun, meta: { runId } }), context);
    blobs.set(`runs/${runId}/issue.json`, {
      data: Buffer.from(JSON.stringify({ url: 'https://github.com/nalfeo/Crawler/issues/404' })),
      lastModified: new Date(),
    });
    beforeUploadData = (name, data) => {
      if (name === `runs/${runId}/survey.json`) {
        blobs.set(name, { data: Buffer.from(data), lastModified: new Date() });
      }
    };

    const result = await handleRuns(
      makeRequest({ meta: { runId }, survey }, 'https://nalfeo.github.io', {
        'x-run-upload-mode': 'survey',
      }),
      context,
    );

    expect(result.status).toBe(201);
    expect(result.jsonBody).toMatchObject({
      runId,
      issueUrl: 'https://github.com/nalfeo/Crawler/issues/404',
    });
  });

  it('claims survey append before commenting so concurrent retries do not duplicate comments', async () => {
    let resolveComment: (() => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveComment = () => resolve({ ok: true, json: async () => ({ id: 1 }) });
      }),
    );
    const runId = 'survey-comment-race-run';
    const survey = { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 };
    await handleRuns(makeRequest({ ...validRun, meta: { runId } }), context);
    blobs.set(`runs/${runId}/issue.json`, {
      data: Buffer.from(JSON.stringify({ url: 'https://github.com/nalfeo/Crawler/issues/505' })),
      lastModified: new Date(),
    });

    const request = () =>
      makeRequest({ meta: { runId }, survey }, 'https://nalfeo.github.io', {
        'x-run-upload-mode': 'survey',
      });
    const first = handleRuns(request(), context);
    await Promise.resolve();
    const second = await handleRuns(request(), context);
    resolveComment?.();
    const firstResult = await first;

    expect(firstResult.status).toBe(201);
    expect(second.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconciles stale survey append claims before reposting comments', async () => {
    const runId = 'survey-stale-comment-run';
    const survey = { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 };
    const contentHash = createHash('sha256').update(JSON.stringify(survey)).digest('hex');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ body: 'issue body without marker' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ body: `Survey ID: \`${contentHash}\`\n\nSurvey already posted.` }],
      });
    await handleRuns(makeRequest({ ...validRun, meta: { runId } }), context);
    blobs.set(`runs/${runId}/issue.json`, {
      data: Buffer.from(JSON.stringify({ url: 'https://github.com/nalfeo/Crawler/issues/606' })),
      lastModified: new Date(),
    });
    blobs.set(`runs/${runId}/survey.pending`, {
      data: Buffer.from('stale'),
      lastModified: new Date(Date.now() - 15 * 60 * 1000),
    });

    const result = await handleRuns(
      makeRequest({ meta: { runId }, survey }, 'https://nalfeo.github.io', {
        'x-run-upload-mode': 'survey',
      }),
      context,
    );

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [issueUrl] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(issueUrl).toBe('https://api.github.com/repos/nalfeo/Crawler/issues/606');
    const [url, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(url).toBe(
      'https://api.github.com/repos/nalfeo/Crawler/issues/606/comments?per_page=100',
    );
    expect(requestInit?.method).toBeUndefined();
    expect(blobs.has(`runs/${runId}/survey.json`)).toBe(true);
  });

  it('reconciles stale survey append claims against survey markers in the issue body', async () => {
    const runId = 'survey-stale-issue-body-run';
    const survey = { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 };
    const contentHash = createHash('sha256').update(JSON.stringify(survey)).digest('hex');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ body: `Survey ID: \`${contentHash}\`\n\nSurvey already filed.` }),
    });
    await handleRuns(makeRequest({ ...validRun, meta: { runId } }), context);
    blobs.set(`runs/${runId}/issue.json`, {
      data: Buffer.from(JSON.stringify({ url: 'https://github.com/nalfeo/Crawler/issues/707' })),
      lastModified: new Date(),
    });
    blobs.set(`runs/${runId}/survey.pending`, {
      data: Buffer.from('stale'),
      lastModified: new Date(Date.now() - 15 * 60 * 1000),
    });

    const result = await handleRuns(
      makeRequest({ meta: { runId }, survey }, 'https://nalfeo.github.io', {
        'x-run-upload-mode': 'survey',
      }),
      context,
    );

    expect(result.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('https://api.github.com/repos/nalfeo/Crawler/issues/707');
    expect(requestInit?.method).toBeUndefined();
    expect(blobs.has(`runs/${runId}/survey.json`)).toBe(true);
  });

  it('retries the same runId idempotently and rejects a mismatched retry', async () => {
    const run = { ...validRun, meta: { runId: 'retry-run-1' } };
    const first = await handleRuns(makeRequest(run), context);
    expect(first.status).toBe(201);

    const second = await handleRuns(makeRequest(run), context);
    expect(second.status).toBe(201);
    expect((second.jsonBody as { runId: string }).runId).toBe('retry-run-1');

    const mismatched = {
      ...validRun,
      recorderJsonl: '{"frame":2}\n',
      meta: { runId: 'retry-run-1' },
    };
    const conflict = await handleRuns(makeRequest(mismatched), context);
    expect(conflict.status).toBe(409);
  });

  it('reconciles against an existing GitHub issue instead of filing a duplicate', async () => {
    const runId = 'crash-recovery-run';
    const run = {
      ...validRun,
      meta: { runId },
      survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
    };
    // Simulate a prior request that claimed the issue-filing marker, created
    // the GitHub issue, but crashed before recording issue.json.
    fetchMock.mockRejectedValueOnce(new Error('simulated crash before issue.json was written'));
    await handleRuns(makeRequest(run), context).catch(() => undefined);
    blobs.set(`runs/${runId}/issue.pending`, {
      data: Buffer.from('stale'),
      lastModified: new Date(Date.now() - 15 * 60 * 1000),
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ html_url: 'https://github.com/nalfeo/Crawler/issues/202' }],
      }),
    });

    const result = await handleRuns(makeRequest(run), context);
    expect(result.status).toBe(201);
    const body = result.jsonBody as { issueUrl?: string };
    expect(body.issueUrl).toBe('https://github.com/nalfeo/Crawler/issues/202');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toContain('/search/issues');
  });
});
