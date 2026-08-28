/**
 * Vitest globalSetup for the e2e project.
 *
 * Spawns a Vite dev server in lab mode and waits for it to be ready before
 * any e2e test runs.  Kills the server after all tests complete.
 *
 * Setup fails fast — with the server's own output — when the port is already
 * taken or the server dies during boot, rather than letting the suite run
 * against whatever else happens to be listening (see `lab-server-lib.ts`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { E2E_LAB_HOST, E2E_LAB_PORT } from './e2e-constants.js';
import {
  appendOutput,
  hasReadyBanner,
  isPortInUse,
  portInUseMessage,
  serverExitedMessage,
  serverNotReadyMessage,
} from './lab-server-lib.js';

interface SharedServer {
  process: ChildProcess;
  ready: Promise<void>;
  users: number;
}

declare global {
  // Vitest initializes this setup independently for each selected e2e project.
  // Keep lifecycle state on the process-global object so all projects share one
  // server instead of mistaking it for a foreign listener.
  var __crawlerE2ELabServer: SharedServer | undefined;
}

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      // Probe the exact host the tests will navigate to (E2E_LAB_HOST), never a
      // resolver-dependent name: a same-port listener on the *other* address
      // family would otherwise satisfy this probe without serving the browser.
      const sock = createConnection({ port, host: E2E_LAB_HOST });
      sock.once('connect', () => {
        sock.destroy();
        res();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          rej(new Error(`Timed out waiting for lab server on port ${port}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

/** Poll the child's captured output until it announces our port, or time out. */
async function waitForBanner(read: () => string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasReadyBanner(read(), E2E_LAB_PORT)) return;
    if (Date.now() > deadline) throw new Error(serverNotReadyMessage(E2E_LAB_PORT, read()));
    await new Promise((res) => setTimeout(res, 200));
  }
}

export async function setup(): Promise<void> {
  const shareActiveServer = async (): Promise<boolean> => {
    const shared = globalThis.__crawlerE2ELabServer;
    if (!shared) return false;
    shared.users += 1;
    await shared.ready;
    return true;
  };

  if (await shareActiveServer()) return;

  // A listener already on the port means `--strictPort` will kill our child
  // while the readiness probe happily connects to the *other* server. Refuse
  // instead: running the suite against a foreign worktree's code is far more
  // expensive to diagnose than an immediate, explicit failure here.
  if (await isPortInUse(E2E_LAB_PORT)) {
    throw new Error(portInUseMessage(E2E_LAB_PORT));
  }

  // Another project can complete its pre-check and begin starting the server
  // while this setup is awaiting the port probe above.
  if (await shareActiveServer()) return;

  // Invoke Vite's JS entry through the current Node executable so the spawn is
  // cross-platform. Spawning the bare `node_modules/.bin/vite` shell wrapper
  // fails with ENOENT on Windows (it has no executable extension), which broke
  // local e2e runs there.
  const viteBin = resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
  const child = spawn(
    process.execPath,
    [
      viteBin,
      '--mode',
      'lab',
      '--host',
      E2E_LAB_HOST,
      '--port',
      String(E2E_LAB_PORT),
      '--strictPort',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, CRAWLER_LAB_PORT: String(E2E_LAB_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Retain a bounded tail of the server's own output so a boot failure reports
  // Vite's message instead of an opaque timeout.
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output = appendOutput(output, chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output = appendOutput(output, chunk.toString());
  });

  const exited = new Promise<never>((_res, rej) => {
    child.on('error', (err) => {
      rej(new Error(`[e2e] Lab server process error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      rej(new Error(serverExitedMessage(E2E_LAB_PORT, code, signal, output)));
    });
  });
  // The exit rejection is only consumed by the race below; without this a late
  // (post-setup) exit would surface as an unhandled rejection.
  exited.catch(() => {});

  // Readiness is OUR child's ready banner first, then a reachable port. The
  // banner is what ties the listening socket to the process we spawned: a bare
  // port probe would also accept a foreign server that grabbed the port in the
  // window between the pre-check above and Vite's bind.
  const ready = (async () => {
    await waitForBanner(() => output);
    await waitForPort(E2E_LAB_PORT);
  })();
  const shared: SharedServer = { process: child, ready, users: 1 };
  globalThis.__crawlerE2ELabServer = shared;

  try {
    await Promise.race([ready, exited]);
  } catch (err) {
    if (globalThis.__crawlerE2ELabServer === shared) {
      globalThis.__crawlerE2ELabServer = undefined;
    }
    child.kill('SIGTERM');
    throw err;
  }
}

export async function teardown(): Promise<void> {
  const shared = globalThis.__crawlerE2ELabServer;
  if (!shared) return;

  shared.users -= 1;
  if (shared.users === 0) {
    shared.process.kill('SIGTERM');
    globalThis.__crawlerE2ELabServer = undefined;
  }
}
