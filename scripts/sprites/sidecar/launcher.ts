/**
 * `npm run sprites:gallery` launcher.
 *
 * Spawns two foreground child processes — the read-only sidecar and the
 * Vite lab dev server — and forwards SIGINT/SIGTERM to both so Ctrl-C
 * tears down the whole stack cleanly. When either child exits the
 * launcher initiates shutdown of the other child, then exits itself
 * after the remaining child closes (or after a 4-second hard fallback
 * if it ignores SIGINT) — "one half is dead" is a useless state for
 * review.
 *
 * Intentionally avoids `concurrently` / `npm-run-all` — they obscure
 * child PIDs and signal forwarding gets flaky on Windows. Vanilla
 * `child_process.spawn` is good enough for two children.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionServerPorts } from '../../shared/session-server-ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SESSION_PORTS = getSessionServerPorts({ cwd: REPO_ROOT, env: process.env });

interface ChildSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly color: string;
}

const CHILDREN: readonly ChildSpec[] = [
  {
    name: 'sidecar',
    // Windows requires .cmd shims to be invoked via the shell wrapper; tsx
    // ships as `tsx.cmd`. Spawning with `shell: true` papers over both
    // platforms.
    command: 'npx',
    args: ['tsx', path.join('scripts', 'sprites', 'sidecar', 'cli.ts')],
    color: '\x1b[36m', // cyan
  },
  {
    name: 'vite-lab',
    command: 'npx',
    args: ['vite', '--mode', 'lab'],
    color: '\x1b[35m', // magenta
  },
];

const RESET = '\x1b[0m';

function prefixedWrite(name: string, color: string, chunk: Buffer | string): void {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
  }
}

function runLauncher(): void {
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  function shutdown(reason: string, exitCode: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    // Record the intended status immediately so that if both children
    // exit cleanly before the 4s hard-fallback timer fires, Node's
    // natural exit still surfaces the correct code (`.unref()` on the
    // timer otherwise lets the process exit 0 and lose this signal).
    process.exitCode = exitCode;
    process.stdout.write(`\n[launcher] ${reason} — stopping children…\n`);
    for (const child of children) {
      if (child.exitCode == null && !child.killed) {
        // SIGINT lets the sidecar run its clean-shutdown path (Fastify
        // close + port release). SIGKILL would orphan the listener.
        child.kill('SIGINT');
      }
    }
    // Hard fallback if a child ignores the signal.
    setTimeout(() => {
      for (const child of children) {
        if (child.exitCode == null && !child.killed) {
          child.kill('SIGKILL');
        }
      }
      process.exit(exitCode);
    }, 4000).unref();
  }

  process.on('SIGINT', () => shutdown('received SIGINT', 0));
  process.on('SIGTERM', () => shutdown('received SIGTERM', 0));

  for (const spec of CHILDREN) {
    const child = spawn(spec.command, [...spec.args], {
      cwd: REPO_ROOT,
      // Windows needs the shell wrapper to resolve `.cmd` shims (npx.cmd,
      // tsx.cmd, vite.cmd). On POSIX we spawn the binary directly so the
      // child PID is the real process and SIGINT reaches it instead of
      // being absorbed by an intermediate `sh -c`.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    children.push(child);

    child.stdout?.on('data', (chunk: Buffer) => prefixedWrite(spec.name, spec.color, chunk));
    child.stderr?.on('data', (chunk: Buffer) => prefixedWrite(spec.name, spec.color, chunk));
    child.on('exit', (code, signal) => {
      const reason = `${spec.name} exited (code=${code}, signal=${signal ?? 'none'})`;
      shutdown(reason, code ?? 1);
    });
    child.on('error', (err) => {
      process.stderr.write(`[launcher] failed to spawn ${spec.name}: ${err.message}\n`);
      shutdown(`${spec.name} failed to spawn`, 1);
    });
  }

  process.stdout.write(
    [
      '',
      '[launcher] sprite gallery starting…',
      `  sidecar  → ${SESSION_PORTS.sidecarBaseUrl}/api/health`,
      `  lab page → ${SESSION_PORTS.labBaseUrl}/lab.html?lab=sprite-gallery`,
      '  press Ctrl-C to stop both',
      '',
    ].join('\n'),
  );
}

runLauncher();
