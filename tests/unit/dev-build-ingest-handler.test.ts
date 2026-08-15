import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

interface FakeBlob {
  data: Buffer;
  lastModified: Date;
}

const blobs = new Map<string, FakeBlob>();

function makeBlockBlobClient(name: string) {
  return {
    exists: async () => blobs.has(name),
    uploadData: async (data: Uint8Array, options?: { conditions?: { ifNoneMatch?: string } }) => {
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

function makeRequest(body: unknown, origin = 'https://nalfeo.github.io'): HttpRequest {
  const text = JSON.stringify(body);
  return {
    method: 'POST',
    headers: new Headers({ origin, 'content-length': String(Buffer.byteLength(text, 'utf8')) }),
    text: async () => text,
  } as unknown as HttpRequest;
}

const context = { info: () => undefined, error: () => undefined } as unknown as InvocationContext;

describe('handleRuns (mocked storage + GitHub)', () => {
  beforeEach(() => {
    blobs.clear();
    fetchMock.mockReset();
    process.env.AZURE_STORAGE_CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=${fakeAccountKey};EndpointSuffix=core.windows.net`;
    process.env.RUNS_CONTAINER = 'playtest-runs';
    process.env.CRAWLER_CI_PAT = 'unit-test-token';
    process.env.GITHUB_REPOSITORY = 'nalfeo/Crawler';
  });

  afterEach(() => {
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

  it('files a GitHub issue for survey submissions and stores the issue URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/nalfeo/Crawler/issues/101' }),
    });
    const run = {
      ...validRun,
      meta: { runId: 'survey-run-1' },
      survey: { enjoyment: 5, immersion: 4, mastery: 3, control: 4, tension: 2 },
    };
    const result = await handleRuns(makeRequest(run), context);
    expect(result.status).toBe(201);
    const body = result.jsonBody as { runId: string; issueUrl?: string };
    expect(body.issueUrl).toBe('https://github.com/nalfeo/Crawler/issues/101');
    expect(blobs.has('runs/survey-run-1/issue.json')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.method).toBe('POST');
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
