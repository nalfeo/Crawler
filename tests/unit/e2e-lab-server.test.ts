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
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendOutput,
  isPortInUse,
  portInUseMessage,
  serverExitedMessage,
} from '../e2e/lab-server-lib.js';

let listener: Server | null = null;

function listenOnEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    listener = server;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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

  it('reports a free port as unused', async () => {
    // Bind then release, so the port is known-valid but no longer listening.
    const port = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = null;

    await expect(isPortInUse(port)).resolves.toBe(false);
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
