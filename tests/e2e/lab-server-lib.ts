/**
 * Pure-ish helpers for the e2e lab server lifecycle, split out of
 * `global-setup.ts` so the failure modes can be unit tested without spawning
 * Vite.
 *
 * The bug these exist to prevent: the e2e harness used to `waitForPort()` and
 * treat *any* listener on the port as "our server is up". Because Vite is
 * spawned with `--strictPort`, a port already owned by another worktree (or a
 * leftover run) killed our own child while `waitForPort()` still resolved
 * against the foreign server. The suite then exercised another checkout's code,
 * surfacing as unrelated `page.goto` timeouts and "missing" lab probe hooks
 * many minutes later, in a different file.
 */
import { createConnection } from 'node:net';

function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const sock = createConnection({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      sock.destroy();
      finish(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      finish(false);
    });
    sock.once('error', () => {
      sock.destroy();
      finish(false);
    });
  });
}

/**
 * Resolve `true` when something is already listening on `port`.
 *
 * Probes IPv6 **and** IPv4: Vite (and the readiness probe) may bind either
 * depending on the OS resolver, so a v6-only foreign listener must not read as
 * a free port.
 */
export async function isPortInUse(port: number, timeoutMs = 1_000): Promise<boolean> {
  const results = await Promise.all([
    connects('::1', port, timeoutMs),
    connects('127.0.0.1', port, timeoutMs),
  ]);
  return results.some(Boolean);
}

// eslint-disable-next-line no-control-regex -- terminal colour codes, by definition
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Has the spawned Vite announced *our* port as ready?
 *
 * A reachable port only proves that SOMETHING is listening — with a
 * check-then-spawn race, that something can still be a foreign server that
 * grabbed the port after the pre-check. Vite's own `Local: http://…:<port>/`
 * banner is emitted by our child after it successfully bound, so requiring it
 * ties readiness to the process we started. The banner is ANSI-coloured and
 * splits the port digits with escape codes, so strip colours before matching.
 */
export function hasReadyBanner(output: string, port: number): boolean {
  const plain = output.replace(ANSI, '');
  return new RegExp(`Local:\\s*https?://[^\\s]*:${port}/`).test(plain);
}

/** Message for a port that is occupied before we ever spawn our own server. */
export function portInUseMessage(port: number): string {
  return [
    `[e2e] Port ${port} is already in use, so the e2e lab server cannot start.`,
    'Refusing to run against a foreign server: it may serve a different worktree,',
    'which shows up as page.goto timeouts and missing lab probe hooks.',
    'Stop the process holding the port, or set CRAWLER_E2E_LAB_PORT to a free one.',
  ].join('\n');
}

/** Message for a server that never announced readiness within the deadline. */
export function serverNotReadyMessage(port: number, output: string): string {
  const tail = output.trim();
  return [
    `[e2e] Lab server never announced "Local: http://localhost:${port}/" in time.`,
    tail ? `Server output:\n${tail}` : 'Server produced no output.',
  ].join('\n');
}

/** Message for a server child that exited before the port became ready. */
export function serverExitedMessage(
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  const tail = stderr.trim();
  return [
    `[e2e] Lab server for port ${port} exited before it was ready (${how}).`,
    tail ? `Server output:\n${tail}` : 'Server produced no output.',
  ].join('\n');
}

/** Keep only the last `maxChars` of accumulated server output. */
export function appendOutput(buffer: string, chunk: string, maxChars = 4_000): string {
  const next = buffer + chunk;
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}
