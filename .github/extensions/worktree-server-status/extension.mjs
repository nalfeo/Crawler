import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

import { renderHtml } from './renderer.mjs';

const execFileAsync = promisify(execFile);

const ROUTES = [
  { id: 'game', label: 'Game', path: '/', expectedTitle: 'Crawler' },
  { id: 'labs', label: 'Labs', path: '/lab.html', expectedTitle: 'Crawler Labs' },
  { id: 'devtools', label: 'DevTools', path: '/devtools.html', expectedTitle: 'Crawler DevTools' },
];
const POLL_INTERVAL_MS = 5000;
const WORKSPACE_METADATA_TTL_MS = 15_000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const WORKTREE_MARKER = '\\repos\\copilot-worktrees\\crawler\\';
const MAIN_CHECKOUT_MARKER = '\\repos\\crawler';

const servers = new Map();
let trackedWorktreePath = null;
let latestState = null;
let refreshTimer = null;
let refreshInFlight = null;
const workspaceMetadataCache = new Map();

function rememberWorkingDirectory(workingDirectory) {
  if (typeof workingDirectory !== 'string') {
    return;
  }
  const normalized = workingDirectory.trim();
  if (!normalized) {
    return;
  }
  trackedWorktreePath = normalized;
}

function getTrackedWorktreePath() {
  return trackedWorktreePath;
}

function getSessionWorkspacePath(session) {
  return session.workspacePath ?? getTrackedWorktreePath();
}

function escapeForPowerShell(value) {
  return value.replaceAll("'", "''");
}

function buildProcessScanScript() {
  return `
$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$processById = @{}
foreach ($process in $processes) {
  $processId = [int]$process.ProcessId
  $processById[$processId] = $process
}
function Get-AncestorProcessIds([int]$rootId) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $currentId = $rootId
  while ($currentId -gt 0 -and $processById.ContainsKey($currentId) -and -not $seen.Contains($currentId)) {
    $seen.Add($currentId) | Out-Null
    $currentId = [int]$processById[$currentId].ParentProcessId
  }
  return @($seen | Sort-Object)
}
function Get-LaunchMode([string[]]$commandLines) {
  foreach ($line in $commandLines) {
    if (-not $line) {
      continue
    }
    $normalized = $line.ToLowerInvariant()
    if ($normalized.Contains('--mode devtools') -or $normalized.Contains(' run devtools')) {
      return 'devtools'
    }
  }
  foreach ($line in $commandLines) {
    if (-not $line) {
      continue
    }
    $normalized = $line.ToLowerInvariant()
    if ($normalized.Contains('--mode lab') -or $normalized.Contains(' run lab')) {
      return 'lab'
    }
  }
  return 'game'
}
function IsWorktreeViteCommand([string]$commandLine) {
  if (-not $commandLine) {
    return $false
  }
  $normalized = $commandLine.ToLowerInvariant().Replace('/', '\\')
  if (
    -not $normalized.Contains('\\copilot-worktrees\\crawler\\') -and
    -not $normalized.Contains('\\repos\\crawler\\') -and
    -not $normalized.Contains('\\crawler\\node_modules\\vite\\bin\\vite.js')
  ) {
    return $false
  }
  return (
    $normalized.Contains('vite.js') -or
    $normalized.Contains(' run dev') -or
    $normalized.Contains(' run lab') -or
    $normalized.Contains(' run devtools') -or
    $normalized.Contains(' /c vite ')
  )
}
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -gt 0 -and $_.LocalPort -gt 0 } |
  Sort-Object LocalPort, OwningProcess)
$workspaceMatches = @($processes | Where-Object { IsWorktreeViteCommand($_.CommandLine) })
$results = @()
foreach ($match in $workspaceMatches) {
  $ancestorIds = Get-AncestorProcessIds([int]$match.ProcessId)
  $relatedListeners = @($listeners | Where-Object { $ancestorIds -contains [int]$_.OwningProcess })
  foreach ($listener in $relatedListeners) {
    $commandLines = @($ancestorIds | ForEach-Object { $processById[[int]$_].CommandLine } | Where-Object { $_ })
    $results += [pscustomobject]@{
      localAddress = [string]$listener.LocalAddress
      localPort = [int]$listener.LocalPort
      owningProcess = [int]$listener.OwningProcess
      launchProcessId = [int]$match.ProcessId
      familyProcessIds = @($ancestorIds)
      familyCommandLines = @($commandLines)
      mode = Get-LaunchMode($commandLines)
      matchedCommandLines = @($match.CommandLine)
    }
  }
}
$results | ConvertTo-Json -Depth 6 -Compress
`;
}

async function runPowerShellJson(script) {
  const { stdout, stderr } = await execFileAsync(
    'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return [];
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    throw error;
  }
}

function addressPriority(address) {
  switch ((address || '').toLowerCase()) {
    case '127.0.0.1':
    case 'localhost':
      return 0;
    case '::1':
      return 1;
    case '0.0.0.0':
    case '::':
      return 2;
    default:
      return 3;
  }
}

function dedupeCandidates(rawCandidates) {
  const byPort = new Map();
  for (const candidate of rawCandidates) {
    const existing = byPort.get(candidate.localPort);
    if (
      !existing ||
      addressPriority(candidate.localAddress) < addressPriority(existing.localAddress)
    ) {
      byPort.set(candidate.localPort, candidate);
    }
  }
  return [...byPort.values()].sort((left, right) => left.localPort - right.localPort);
}

function formatLinkHost(localAddress) {
  const normalized = (localAddress || '').toLowerCase();
  if (!normalized || normalized === '0.0.0.0' || normalized === '::') {
    return '127.0.0.1';
  }
  if (normalized === '::1') {
    return '[::1]';
  }
  if (normalized.includes(':') && !normalized.startsWith('[')) {
    return `[${localAddress}]`;
  }
  return localAddress;
}

function extractWorkspacePathFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return null;
  }

  const vitePathMatch = /([a-z]:\\[^"'`]+?)\\node_modules\\vite\\bin\\vite\.js/i.exec(commandLine);
  if (vitePathMatch?.[1]) {
    return vitePathMatch[1];
  }

  const worktreePathMatch =
    /([a-z]:\\[^"'`]*?\\repos\\copilot-worktrees\\crawler\\[^\\"'`\s]+)/i.exec(commandLine);
  if (worktreePathMatch?.[1]) {
    return worktreePathMatch[1];
  }

  const mainCheckoutMatch = /([a-z]:\\[^"'`]*?\\repos\\crawler)(?:\\|["'`\s]|$)/i.exec(commandLine);
  if (mainCheckoutMatch?.[1]) {
    return mainCheckoutMatch[1];
  }

  return null;
}

function inferWorkspacePath(candidate) {
  const commandLines = [
    ...(Array.isArray(candidate.familyCommandLines) ? candidate.familyCommandLines : []),
    ...(Array.isArray(candidate.matchedCommandLines) ? candidate.matchedCommandLines : []),
  ];
  for (const commandLine of commandLines) {
    const workspacePath = extractWorkspacePathFromCommandLine(commandLine);
    if (workspacePath) {
      return workspacePath;
    }
  }
  return null;
}

function inferSessionName(workspacePath) {
  if (!workspacePath) {
    return null;
  }
  const normalized = workspacePath.replaceAll('/', '\\');
  const lower = normalized.toLowerCase();
  const markerIndex = lower.indexOf(WORKTREE_MARKER);
  if (markerIndex >= 0) {
    const suffix = normalized.slice(markerIndex + WORKTREE_MARKER.length);
    const [sessionName] = suffix.split('\\');
    return sessionName || null;
  }
  if (lower.endsWith(MAIN_CHECKOUT_MARKER)) {
    return 'main-checkout';
  }
  return basename(normalized);
}

async function resolveBranchName(workspacePath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const branchName = stdout.trim();
    return branchName || null;
  } catch {
    return null;
  }
}

async function getWorkspaceMetadata(workspacePath) {
  if (!workspacePath) {
    return {
      workspacePath: null,
      workspaceName: null,
      sessionName: null,
      branchName: null,
    };
  }

  const now = Date.now();
  const cached = workspaceMetadataCache.get(workspacePath);
  if (cached && now - cached.fetchedAtMs < WORKSPACE_METADATA_TTL_MS) {
    return await cached.metadataPromise;
  }

  const metadataPromise = (async () => ({
    workspacePath,
    workspaceName: basename(workspacePath),
    sessionName: inferSessionName(workspacePath),
    branchName: await resolveBranchName(workspacePath),
  }))();
  workspaceMetadataCache.set(workspacePath, {
    fetchedAtMs: now,
    metadataPromise,
  });

  try {
    return await metadataPromise;
  } catch (error) {
    // Avoid pinning a failing lookup in cache.
    workspaceMetadataCache.delete(workspacePath);
    return {
      workspacePath,
      workspaceName: basename(workspacePath),
      sessionName: inferSessionName(workspacePath),
      branchName: null,
      metadataError: error instanceof Error ? error.message : String(error),
    };
  }
}

function getModeLabel(mode) {
  switch (mode) {
    case 'lab':
      return 'Lab server';
    case 'devtools':
      return 'DevTools server';
    default:
      return 'Game server';
  }
}

function extractTitle(html) {
  const match = /<title>([^<]+)<\/title>/i.exec(html);
  return match ? match[1].trim() : null;
}

async function probeRoute(baseUrl, route) {
  const url = `${baseUrl}${route.path === '/' ? '' : route.path}`;

  try {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: 'GET',
          headers: { accept: 'text/html' },
          timeout: 2000,
        },
        (incoming) => {
          const chunks = [];
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk) => chunks.push(chunk));
          incoming.on('end', () => {
            resolve({
              statusCode: incoming.statusCode ?? null,
              body: chunks.join(''),
            });
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('Request timed out'));
      });
      request.on('error', reject);
      request.end();
    });
    const title = extractTitle(response.body);
    const available = response.statusCode === 200 && title === route.expectedTitle;

    return {
      id: route.id,
      label: route.label,
      path: route.path,
      url,
      expectedTitle: route.expectedTitle,
      available,
      status: response.statusCode,
      title,
    };
  } catch (error) {
    return {
      id: route.id,
      label: route.label,
      path: route.path,
      url,
      expectedTitle: route.expectedTitle,
      available: false,
      status: null,
      title: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function enrichCandidate(candidate) {
  const host = formatLinkHost(candidate.localAddress);
  const baseUrl = `http://${host}:${candidate.localPort}`;
  const routes = await Promise.all(ROUTES.map((route) => probeRoute(baseUrl, route)));
  const availableRoutes = routes.filter((route) => route.available);
  const workspacePath = inferWorkspacePath(candidate);
  const workspaceMetadata = await getWorkspaceMetadata(workspacePath);
  const matchedCommandLines = Array.isArray(candidate.matchedCommandLines)
    ? candidate.matchedCommandLines
    : [];
  const familyCommandLines = Array.isArray(candidate.familyCommandLines)
    ? candidate.familyCommandLines
    : [];
  const primaryFamilyCommand = familyCommandLines.find(
    (line) => typeof line === 'string' && line.trim(),
  );
  const primaryMatchedCommand = matchedCommandLines.find(
    (line) => typeof line === 'string' && line.trim(),
  );
  const commandSummary = primaryFamilyCommand || primaryMatchedCommand || null;

  return {
    baseUrl,
    localAddress: candidate.localAddress,
    port: candidate.localPort,
    owningProcess: candidate.owningProcess,
    launchProcessId: candidate.launchProcessId ?? null,
    familyProcessIds: candidate.familyProcessIds,
    workspacePath: workspaceMetadata.workspacePath,
    workspaceName: workspaceMetadata.workspaceName,
    sessionName: workspaceMetadata.sessionName,
    branchName: workspaceMetadata.branchName,
    mode: candidate.mode,
    modeLabel: getModeLabel(candidate.mode),
    availableRouteCount: availableRoutes.length,
    verified: availableRoutes.length > 0,
    matchedCommandLines,
    familyCommandLines,
    commandSummary,
    routes,
  };
}

function sortServers(serversList) {
  return [...serversList].sort((left, right) => {
    if (Number(right.verified) !== Number(left.verified)) {
      return Number(right.verified) - Number(left.verified);
    }
    if (right.availableRouteCount !== left.availableRouteCount) {
      return right.availableRouteCount - left.availableRouteCount;
    }
    return left.port - right.port;
  });
}

function getArtifactPath(session) {
  const workspacePath = getSessionWorkspacePath(session);
  if (!workspacePath) {
    return null;
  }
  return join(workspacePath, 'files', 'worktree-server-status.json');
}

async function persistState(session, state) {
  const artifactPath = getArtifactPath(session);
  if (!artifactPath) {
    return null;
  }

  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return artifactPath;
}

async function refreshState(session) {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    latestState = await discoverState(session);
    return latestState;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function getCachedState() {
  return (
    latestState ?? {
      workspaceName: getTrackedWorktreePath() ? basename(getTrackedWorktreePath()) : null,
      workspacePath: getTrackedWorktreePath(),
      platform: process.platform,
      scannedAt: new Date().toISOString(),
      discoveryMethod: 'windows-process-scan',
      activeServerCount: 0,
      servers: [],
      error: 'State is loading.',
    }
  );
}

async function discoverState(session) {
  const worktreePath = getTrackedWorktreePath();
  const baseState = {
    workspaceName: worktreePath ? basename(worktreePath) : null,
    workspacePath: worktreePath,
    platform: process.platform,
    scannedAt: new Date().toISOString(),
    discoveryMethod: 'windows-process-scan',
    activeServerCount: 0,
    servers: [],
  };

  if (!worktreePath) {
    return {
      ...baseState,
      error: 'The session worktree path is not available yet.',
    };
  }

  if (process.platform !== 'win32') {
    return {
      ...baseState,
      error: 'This canvas currently supports Windows worktrees only.',
    };
  }

  try {
    const rawResult = await runPowerShellJson(buildProcessScanScript());
    const rawCandidates = Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : [];
    const candidates = dedupeCandidates(rawCandidates);
    const discoveredServers = sortServers(
      await Promise.all(candidates.map((candidate) => enrichCandidate(candidate))),
    );
    const runningServers = discoveredServers.filter((server) => server.verified);
    const nextState = {
      ...baseState,
      activeServerCount: runningServers.length,
      verifiedServerCount: runningServers.length,
      hasActiveServer: runningServers.length > 0,
      hasVerifiedServer: runningServers.length > 0,
      servers: runningServers,
    };

    try {
      const artifactPath = await persistState(session, nextState);
      if (artifactPath) {
        nextState.artifactPath = artifactPath;
      }
    } catch (error) {
      nextState.artifactWriteError = error instanceof Error ? error.message : String(error);
    }

    return nextState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedState = {
      ...baseState,
      error: `Server discovery failed: ${message}`,
    };

    try {
      const artifactPath = await persistState(session, failedState);
      if (artifactPath) {
        failedState.artifactPath = artifactPath;
      }
    } catch (artifactError) {
      failedState.artifactWriteError =
        artifactError instanceof Error ? artifactError.message : String(artifactError);
    }

    return failedState;
  }
}

function setJsonResponse(res, body, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}

async function readJsonRequestBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        const error = new Error(`Request body too large (max ${MAX_JSON_BODY_BYTES} bytes).`);
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body || !body.trim()) {
        settled = true;
        resolve({});
        return;
      }
      try {
        settled = true;
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Invalid JSON body.');
        error.code = 'INVALID_JSON';
        fail(error);
      }
    });

    req.on('error', (error) => {
      fail(error);
    });
  });
}

async function openInSystemBrowser(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('A non-empty URL is required.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported.');
  }

  if (process.platform !== 'win32') {
    throw new Error('System browser launching is currently supported on Windows only.');
  }

  const escapedUrl = escapeForPowerShell(parsedUrl.toString());
  await execFileAsync(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${escapedUrl}'`,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}

async function startServer(instanceId, session) {
  const server = createServer((req, res) => {
    void handleRequest(req, res, instanceId, session).catch((error) => {
      setJsonResponse(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function handleRequest(req, res, instanceId, session) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (requestUrl.pathname === '/api/state') {
    setJsonResponse(res, getCachedState());
    return;
  }

  if (requestUrl.pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      setJsonResponse(res, { error: 'Method not allowed' }, 405);
      return;
    }
    const state = await refreshState(session);
    setJsonResponse(res, state);
    return;
  }

  if (requestUrl.pathname === '/api/open') {
    if (req.method !== 'POST') {
      setJsonResponse(res, { error: 'Method not allowed' }, 405);
      return;
    }

    let payload;
    try {
      payload = await readJsonRequestBody(req);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        setJsonResponse(res, { error: error.message }, 413);
        return;
      }
      if (error?.code === 'INVALID_JSON') {
        setJsonResponse(res, { error: 'Invalid JSON body.' }, 400);
        return;
      }
      setJsonResponse(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }

    try {
      await openInSystemBrowser(payload.url);
      setJsonResponse(res, { ok: true });
    } catch (error) {
      setJsonResponse(res, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    renderHtml({
      instanceId,
      pollIntervalMs: POLL_INTERVAL_MS,
      workspacePath: getTrackedWorktreePath() ?? 'Waiting for worktree path…',
    }),
  );
}

const session = await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      rememberWorkingDirectory(input.workingDirectory);
    },
    onUserPromptSubmitted: async (input) => {
      rememberWorkingDirectory(input.workingDirectory);
    },
    onPreToolUse: async (input) => {
      rememberWorkingDirectory(input.workingDirectory);
    },
    onPostToolUse: async (input) => {
      rememberWorkingDirectory(input.workingDirectory);
    },
    onPostToolUseFailure: async (input) => {
      rememberWorkingDirectory(input.workingDirectory);
    },
  },
  canvases: [
    createCanvas({
      id: 'worktree-server-status',
      displayName: 'Worktree Server',
      description:
        'Shows all live Crawler Vite instances with session, branch, and links to game/labs/devtools entrypoints.',
      actions: [
        {
          name: 'refresh',
          description: 'Refresh live worktree server discovery and return the current state.',
          handler: async () => {
            return await discoverState(session);
          },
        },
        {
          name: 'get_state',
          description: 'Return the current worktree server discovery state.',
          handler: async () => {
            return await discoverState(session);
          },
        },
      ],
      open: async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, session);
          servers.set(ctx.instanceId, entry);
        }

        const state = await refreshState(session);
        if (!refreshTimer) {
          refreshTimer = setInterval(() => {
            void refreshState(session);
          }, POLL_INTERVAL_MS);
        }
        return {
          title: 'Worktree Server',
          status:
            state.activeServerCount > 0
              ? `${state.activeServerCount} active`
              : state.error
                ? 'discovery error'
                : 'no active server',
          url: entry.url,
        };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) {
          return;
        }
        servers.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
        if (servers.size === 0 && refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
      },
    }),
  ],
});
