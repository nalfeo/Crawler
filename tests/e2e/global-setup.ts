/**
 * Vitest globalSetup for the e2e project.
 *
 * Spawns a Vite dev server in lab mode and waits for it to be ready before
 * any e2e test runs.  Kills the server after all tests complete.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { E2E_LAB_PORT } from './e2e-constants.js';

let serverProcess: ChildProcess | null = null;

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      // Vite may bind to ::1 (IPv6) or 127.0.0.1 (IPv4) depending on OS resolver.
      // Try IPv6 first, then fall back to IPv4.
      const tryConnect = (host: string, fallback: (() => void) | null) => {
        const sock = createConnection({ port, host });
        sock.once('connect', () => {
          sock.destroy();
          res();
        });
        sock.once('error', () => {
          sock.destroy();
          if (fallback) {
            fallback();
          } else if (Date.now() > deadline) {
            rej(new Error(`Timed out waiting for lab server on port ${port}`));
          } else {
            setTimeout(attempt, 300);
          }
        });
      };
      tryConnect('::1', () => tryConnect('127.0.0.1', null));
    };
    attempt();
  });
}

export async function setup(): Promise<void> {
  // Invoke Vite's JS entry through the current Node executable so the spawn is
  // cross-platform. Spawning the bare `node_modules/.bin/vite` shell wrapper
  // fails with ENOENT on Windows (it has no executable extension), which broke
  // local e2e runs there.
  const viteBin = resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
  serverProcess = spawn(
    process.execPath,
    [viteBin, '--mode', 'lab', '--port', String(E2E_LAB_PORT), '--strictPort'],
    {
      cwd: process.cwd(),
      env: { ...process.env, CRAWLER_LAB_PORT: String(E2E_LAB_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  serverProcess.on('error', (err) => {
    console.error('[e2e] Lab server process error:', err.message);
  });
  await waitForPort(E2E_LAB_PORT);
}

export async function teardown(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}
