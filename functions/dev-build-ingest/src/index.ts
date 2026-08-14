import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_REQUEST_BYTES,
  decodePngBase64,
  validateRunBundle,
  type ValidatedBundle,
} from './validation.js';

const DEFAULT_ORIGINS = ['https://nalfeo.github.io', 'http://localhost:5173'];
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function response(status: number, body: unknown, origin?: string): HttpResponseInit {
  return {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' },
    jsonBody: body,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required configuration: ${name}`);
  return value;
}

function getContainer() {
  const connectionString = requiredEnv('AZURE_STORAGE_CONNECTION_STRING');
  const service = BlobServiceClient.fromConnectionString(connectionString);
  return service.getContainerClient(process.env.RUNS_CONTAINER ?? 'playtest-runs');
}

function callerKey(req: HttpRequest): string {
  // Azure's edge infrastructure supplies x-azure-clientip. X-Forwarded-For is
  // retained for local/proxy hosting, but is client-spoofable on a direct edge.
  const clientIp = req.headers.get('x-azure-clientip')?.trim();
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const value = clientIp || forwarded || 'unknown';
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

async function checkRateLimit(
  container: ReturnType<typeof getContainer>,
  key: string,
): Promise<void> {
  const bucket = Math.floor(new Date().getTime() / RATE_WINDOW_MS);
  const prefix = `rate-limit/${key}/${bucket}/`;
  let count = 0;
  for await (const blob of container.listBlobsFlat({ prefix })) {
    void blob;
    count += 1;
    if (count >= RATE_LIMIT) throw new Error('rate limit exceeded; retry later');
  }
  await container.getBlockBlobClient(`${prefix}${randomUUID()}`).uploadData(Buffer.from('1'), {
    conditions: { ifNoneMatch: '*' },
  });
}

function bundleKey(runId: string): string {
  return `runs/${runId}`;
}

function signedBlobUrl(container: ReturnType<typeof getContainer>, blobName: string): string {
  const connectionString = requiredEnv('AZURE_STORAGE_CONNECTION_STRING');
  const accountName = connectionString.match(/(?:^|;)AccountName=([^;]+)/i)?.[1];
  const accountKey = connectionString.match(/(?:^|;)AccountKey=([^;]+)/i)?.[1];
  if (!accountName || !accountKey)
    throw new Error('storage connection string lacks shared-key credentials');
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: container.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(new Date().getTime() - 60_000),
      expiresOn: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
    },
    credential,
  ).toString();
  return `${container.url}/${blobName}?${sas}`;
}

async function persistBundle(
  container: ReturnType<typeof getContainer>,
  validated: ValidatedBundle,
): Promise<{
  runId: string;
  blobUrl: string;
  screenshotUrl?: string;
  issueUrl?: string;
}> {
  const runId = validated.requestedRunId ?? randomUUID();
  const key = bundleKey(runId);
  const bundleBlob = container.getBlockBlobClient(`${key}/bundle.json`);
  if (!(await bundleBlob.exists())) {
    const bundle = Buffer.from(
      JSON.stringify({ ...validated.bundle, receivedAt: new Date().toISOString(), runId }),
    );
    await bundleBlob.uploadData(bundle, {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      conditions: { ifNoneMatch: '*' },
    });
  }
  let storedScreenshotUrl: string | undefined;
  if (validated.screenshotBase64) {
    const screenshot = decodePngBase64(validated.screenshotBase64);
    const screenshotBlob = container.getBlockBlobClient(`${key}/screenshot.png`);
    if (!(await screenshotBlob.exists())) {
      await screenshotBlob.uploadData(screenshot, {
        blobHTTPHeaders: { blobContentType: 'image/png' },
        conditions: { ifNoneMatch: '*' },
      });
    }
    storedScreenshotUrl = signedBlobUrl(container, `${key}/screenshot.png`);
  }
  const issueBlob = container.getBlockBlobClient(`${key}/issue.json`);
  let issueUrl: string | undefined;
  if (await issueBlob.exists()) {
    const issue = JSON.parse((await issueBlob.downloadToBuffer()).toString('utf8')) as {
      url?: unknown;
    };
    if (typeof issue.url === 'string') issueUrl = issue.url;
  }
  return {
    runId,
    blobUrl: signedBlobUrl(container, `${key}/bundle.json`),
    ...(storedScreenshotUrl ? { screenshotUrl: storedScreenshotUrl } : {}),
    ...(issueUrl ? { issueUrl } : {}),
  };
}

async function fileGitHubIssue(
  container: ReturnType<typeof getContainer>,
  validated: ValidatedBundle,
  persisted: { runId: string; blobUrl: string; screenshotUrl?: string },
): Promise<string> {
  const token = requiredEnv('CRAWLER_CI_PAT');
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const pendingBlob = container.getBlockBlobClient(`${bundleKey(persisted.runId)}/issue.pending`);
  if (await pendingBlob.exists()) {
    const properties = await pendingBlob.getProperties();
    const lastModified = properties.lastModified?.getTime() ?? new Date().getTime();
    if (new Date().getTime() - lastModified > 10 * 60 * 1000) {
      await pendingBlob.deleteIfExists();
    }
  }
  try {
    await pendingBlob.uploadData(Buffer.from(new Date().toISOString()), {
      conditions: { ifNoneMatch: '*' },
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { statusCode?: unknown }).statusCode === 412
    ) {
      throw new Error('issue filing in progress', { cause: error });
    }
    throw new Error('failed to claim issue filing marker', { cause: error });
  }
  const description = validated.bundle.issue_description?.trim();
  const survey = validated.bundle.survey;
  const title = description
    ? `Dev build issue: ${description.slice(0, 80)}`
    : 'Dev build playtest feedback';
  const lines = [
    description ?? 'A player submitted post-run feedback from the dev build.',
    '',
    `Run bundle: ${persisted.blobUrl}`,
    `Run ID: \`${persisted.runId}\``,
    ...(persisted.screenshotUrl
      ? [`Screenshot (expires in 7 days): ${persisted.screenshotUrl}`]
      : []),
    ...(survey ? ['', 'Survey:', '```json', JSON.stringify(survey, null, 2), '```'] : []),
  ];
  const result = await fetch(`https://api.github.com/repos/${repository}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'crawler-dev-build-ingest',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body: lines.join('\n'),
      labels: [survey ? 'playtest-feedback' : 'user-reported'],
    }),
  });
  if (!result.ok) throw new Error(`GitHub issue creation failed with HTTP ${result.status}`);
  const issue = (await result.json()) as { html_url?: unknown };
  if (typeof issue.html_url !== 'string')
    throw new Error('GitHub issue response did not include html_url');
  const issueUrl = issue.html_url;
  await container
    .getBlockBlobClient(`${bundleKey(persisted.runId)}/issue.json`)
    .uploadData(Buffer.from(JSON.stringify({ url: issueUrl })), {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      conditions: { ifNoneMatch: '*' },
    });
  await pendingBlob.deleteIfExists();
  return issueUrl;
}

export async function handleRuns(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const origin = req.headers.get('origin') ?? undefined;
  if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders(origin) };
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES)
    return response(413, { error: 'request too large' }, origin);
  try {
    const raw = await req.text();
    const validated = validateRunBundle(JSON.parse(raw) as unknown, Buffer.byteLength(raw, 'utf8'));
    const container = getContainer();
    await checkRateLimit(container, callerKey(req));
    const persisted = await persistBundle(container, validated);
    let issueUrl = persisted.issueUrl;
    if (validated.shouldFileIssue && !issueUrl)
      issueUrl = await fileGitHubIssue(container, validated, persisted);
    context.info(`stored dev build run ${persisted.runId}${issueUrl ? ' and filed issue' : ''}`);
    return response(201, { runId: persisted.runId, ...(issueUrl ? { issueUrl } : {}) }, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed';
    const status = message.includes('rate limit')
      ? 429
      : message.includes('issue filing in progress')
        ? 409
        : error instanceof SyntaxError ||
            message.includes('must be') ||
            message.includes('exceeds') ||
            message.includes('screenshot is') ||
            message.includes('required when')
          ? 400
          : 500;
    context.error(message);
    return response(status, { error: message }, origin);
  }
}

app.http('runs', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'runs',
  handler: handleRuns,
});
