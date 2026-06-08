/**
 * Sidecar CLI clean-shutdown test.
 *
 * Spec §F8 calls out "orphaned port-3010 servers from prior runs" as a
 * real footgun. We exercise the full process lifecycle by spawning the
 * CLI as a child, hitting /api/health, sending SIGTERM, and confirming
 * (a) the child exits with status 0 and (b) the port is immediately
 * rebindable.
 *
 * Windows skip: Node on Windows does not forward POSIX signals to child
 * processes the way it does on Linux/macOS, so this test is exercised
 * in CI (Linux) only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'sprites', 'sidecar', 'cli.ts');

const isWindows = process.platform === 'win32';

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        srv.close();
        reject(new Error('unexpected address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, deadlineMs = 8000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`sidecar did not become healthy in ${deadlineMs}ms: ${String(lastErr)}`);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => {
      srv.close(() => resolve(false));
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

describe.skipIf(isWindows)('sidecar CLI lifecycle', () => {
  let child: ChildProcess | null = null;

  beforeEach(() => {
    child = null;
  });

  afterEach(() => {
    if (child && child.exitCode == null && !child.killed) {
      child.kill('SIGKILL');
    }
  });

  it('starts, serves /api/health, and releases its port on SIGTERM', async () => {
    const port = await pickFreePort();
    // Spawn tsx directly (not via `npx`) so SIGTERM goes to the Node
    // process running cli.ts, not to an npm wrapper that may not forward
    // signals reliably on Linux runners.
    const tsxBin = path.join(REPO_ROOT, 'node_modules', '.bin', isWindows ? 'tsx.cmd' : 'tsx');
    child = spawn(tsxBin, [CLI_PATH], {
      cwd: REPO_ROOT,
      env: { ...process.env, SPRITES_SIDECAR_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Drain stdio so the pipes don't fill and block the child.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    await waitForHealth(port);

    const exited = new Promise<number | null>((resolve) => {
      child!.once('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<number | null>((_, reject) =>
        setTimeout(() => reject(new Error('sidecar did not exit within 5s of SIGTERM')), 5000),
      ),
    ]);
    expect(code).toBe(0);

    // Port should be immediately rebindable. A delay here would mean the
    // sidecar left an orphaned listener — the exact bug §F8 calls out.
    expect(await isPortFree(port)).toBe(true);
  }, 20_000);
});
