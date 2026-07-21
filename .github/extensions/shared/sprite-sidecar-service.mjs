import { execFile as defaultExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const pendingByRepo = new Map();
const SIDECAR_MANAGER_TIMEOUT_MS = 100_000;

function resolveExplicitSidecarBaseUrl(env = globalThis.process?.env ?? {}) {
  const override = env.VITE_SPRITES_SIDECAR_BASE_URL;
  if (typeof override !== 'string') return null;
  const trimmed = override.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/$/, '') : null;
}

function parseResult(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.ok === true) return parsed;
    } catch {
      // Bootstrap tools may write progress before the final JSON line.
    }
  }
  throw new Error('Sprite sidecar manager returned no result.');
}

export async function ensureSpriteSidecar(repoRoot, options = {}) {
  const key = path.resolve(repoRoot).toLowerCase();
  const existing = pendingByRepo.get(key);
  if (existing) return existing;

  const run = (async () => {
    const explicitBaseUrl = resolveExplicitSidecarBaseUrl(options.env);
    if (explicitBaseUrl) {
      return { ok: true, state: 'reused', pid: null, logPath: null, baseUrl: explicitBaseUrl };
    }
    const execFile = options.execFile ?? promisify(defaultExecFile);
    const nodeExecutable = options.nodeExecutable ?? 'node';
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serviceCli = path.join(repoRoot, 'scripts', 'sprites', 'sidecar', 'service-cli.ts');
    const { stdout } = await execFile(
      nodeExecutable,
      [tsxCli, serviceCli, 'ensure', '--repo-root', repoRoot],
      {
        cwd: repoRoot,
        timeout: SIDECAR_MANAGER_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    return parseResult(stdout);
  })();

  pendingByRepo.set(key, run);
  try {
    return await run;
  } finally {
    pendingByRepo.delete(key);
  }
}

export function beginSpriteSidecarStartup(entry, options = {}) {
  entry.sidecarStartup = { state: 'starting', error: null, logPath: null };
  void ensureSpriteSidecar(entry.workspaceRoot, options)
    .then((result) => {
      // Rebind to the manager's authoritative URL before publishing ready state.
      // The URL returned by the manager is the source of truth: it may differ from
      // the one computed at entry creation time (e.g. after a SPRITES_SIDECAR_PORT
      // env change, or when the port is loaded only from .env.local by the manager).
      if (typeof result.baseUrl === 'string' && result.baseUrl !== entry.baseUrl) {
        entry.baseUrl = result.baseUrl;
        options.rebindClients?.(result.baseUrl);
      }
      entry.sidecarStartup = {
        state: 'ready',
        error: null,
        logPath: result.logPath ?? null,
      };
      return entry.pushState();
    })
    .catch((error) => {
      entry.sidecarStartup = {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        logPath: null,
      };
      return entry.pushState();
    });
}
