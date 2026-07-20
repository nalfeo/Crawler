import { execFile as defaultExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const pendingByRepo = new Map();

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
    const execFile = options.execFile ?? promisify(defaultExecFile);
    const nodeExecutable = options.nodeExecutable ?? 'node';
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serviceCli = path.join(repoRoot, 'scripts', 'sprites', 'sidecar', 'service-cli.ts');
    const { stdout } = await execFile(
      nodeExecutable,
      [tsxCli, serviceCli, 'ensure', '--repo-root', repoRoot],
      {
        cwd: repoRoot,
        timeout: 65_000,
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
