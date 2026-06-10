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

const servers = new Map();
let trackedWorktreePath = null;
let latestState = null;
let refreshTimer = null;
let refreshInFlight = null;

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

function buildProcessScanScript(worktreePath) {
  const escapedPath = escapeForPowerShell(worktreePath);
  return `
$workspacePath = '${escapedPath}'
$needle = $workspacePath.ToLowerInvariant().Replace('/', '\\')
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
  $normalized = $commandLine.ToLowerInvariant()
  if (-not $normalized.Contains($needle)) {
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
      familyProcessIds = @($ancestorIds)
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
  return {
    baseUrl,
    localAddress: candidate.localAddress,
    port: candidate.localPort,
    owningProcess: candidate.owningProcess,
    familyProcessIds: candidate.familyProcessIds,
    mode: candidate.mode,
    modeLabel: getModeLabel(candidate.mode),
    availableRouteCount: availableRoutes.length,
    verified: availableRoutes.length > 0,
    matchedCommandLines: candidate.matchedCommandLines,
    commandSummary: candidate.matchedCommandLines[0] ?? null,
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
    const rawResult = await runPowerShellJson(buildProcessScanScript(worktreePath));
    const rawCandidates = Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : [];
    const candidates = dedupeCandidates(rawCandidates);
    const discoveredServers = sortServers(
      await Promise.all(candidates.map((candidate) => enrichCandidate(candidate))),
    );
    const activeServers = discoveredServers.filter((server) => server.verified);
    const nextState = {
      ...baseState,
      activeServerCount: activeServers.length,
      hasActiveServer: activeServers.length > 0,
      servers: activeServers,
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
        'Shows live Vite servers for this worktree and links to the game, labs, and devtools entrypoints.',
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
