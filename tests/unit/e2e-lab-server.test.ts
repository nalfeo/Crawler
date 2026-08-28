/**
 * Unit coverage for the e2e lab-server lifecycle helpers
 * (`tests/e2e/lab-server-lib.ts`).
 *
 * Regression context: the e2e harness used to accept ANY listener on its port
 * as "our lab server is ready". With `--strictPort`, a port owned by another
 * worktree killed our own Vite child while the readiness probe connected to
 * the foreign server, so the whole suite exercised someone else's code —
 * surfacing much later as `page.goto` timeouts and "missing" lab probe hooks.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendOutput,
  hasReadyBanner,
  isPortInUse,
  portInUseMessage,
  serverExitedMessage,
} from '../e2e/lab-server-lib.js';

let listener: Server | null = null;

function listenOnEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    listener = server;
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Expected a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  if (listener) {
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = null;
  }
});

describe('isPortInUse', () => {
  it('detects a port that already has a listener', async () => {
    const port = await listenOnEphemeralPort();

    await expect(isPortInUse(port)).resolves.toBe(true);
  });

  // Vite and the readiness probe may bind ::1 rather than 127.0.0.1, so a
  // v6-only foreign listener must not read as a free port.
  it('detects an IPv6-only listener', async () => {
    const port = await listenOnEphemeralPort('::1');

    await expect(isPortInUse(port)).resolves.toBe(true);
  });

  it('reports a free port as unused', async () => {
    // Bind then release, so the port is known-valid but no longer listening.
    const port = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = null;

    await expect(isPortInUse(port)).resolves.toBe(false);
  });
});

describe('e2e global setup', () => {
  // The whole point of the guard: setup must REFUSE a port it does not own,
  // instead of adopting a foreign server and failing 30s later inside a test.
  it('rejects before spawning Vite when the port is already taken', async () => {
    const port = await listenOnEphemeralPort();
    const previous = process.env.CRAWLER_E2E_LAB_PORT;
    process.env.CRAWLER_E2E_LAB_PORT = String(port);
    try {
      // The port is resolved at module load, so drop any cached copy first.
      vi.resetModules();
      const { setup, teardown } = await import('../e2e/global-setup.js');
      await expect(setup()).rejects.toThrow(new RegExp(`Port ${port} is already in use`));
      await teardown();
    } finally {
      if (previous === undefined) delete process.env.CRAWLER_E2E_LAB_PORT;
      else process.env.CRAWLER_E2E_LAB_PORT = previous;
    }
  });
});

describe('hasReadyBanner', () => {
  // Vite colours the banner and splits the port digits with escape codes, so a
  // naive `:<port>` match never fires.
  const BANNER =
    '\u001B[32m\u001B[1mVITE\u001B[22m ready in 428 ms\n' +
    '  \u001B[32m\u2192\u001B[39m  \u001B[1mLocal\u001B[22m:   ' +
    '\u001B[36mhttp://localhost:\u001B[1m23399\u001B[22m/\u001B[39m\n';

  it('matches the real ANSI-coloured Vite banner for our port', () => {
    expect(hasReadyBanner(BANNER, 23399)).toBe(true);
  });

  it('does not match a banner announcing a different port', () => {
    expect(hasReadyBanner(BANNER, 23400)).toBe(false);
  });

  it('does not match output with no banner at all', () => {
    expect(hasReadyBanner('Re-optimizing dependencies\n', 23399)).toBe(false);
  });
});

describe('failure messages', () => {
  it('names the port and the override knob when the port is taken', () => {
    const message = portInUseMessage(4321);

    expect(message).toContain('4321');
    expect(message).toContain('CRAWLER_E2E_LAB_PORT');
  });

  it('surfaces the server output when the server exits during boot', () => {
    const message = serverExitedMessage(4321, 1, null, 'Error: Port 4321 is already in use\n');

    expect(message).toContain('exit code 1');
    expect(message).toContain('Port 4321 is already in use');
  });

  it('reports the signal when the server was killed', () => {
    const message = serverExitedMessage(4321, null, 'SIGKILL', '');

    expect(message).toContain('signal SIGKILL');
    expect(message).toContain('no output');
  });
});

describe('appendOutput', () => {
  it('accumulates chunks in order', () => {
    expect(appendOutput(appendOutput('', 'a'), 'b')).toBe('ab');
  });

  it('keeps only the trailing window so a chatty server cannot grow unbounded', () => {
    const result = appendOutput('x'.repeat(10), 'abcde', 8);

    expect(result).toHaveLength(8);
    expect(result.endsWith('abcde')).toBe(true);
  });
});
