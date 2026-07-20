/**
 * `npm run sprites:gallery` launcher.
 *
 * Ensures the repo-scoped managed sidecar service is ready, then runs the Vite
 * lab in the foreground. The sidecar intentionally outlives this launcher so
 * canvases and later gallery opens can reuse the same worker and ingester.
 *
 * Intentionally avoids `concurrently` / `npm-run-all` — they obscure
 * child PIDs and signal forwarding gets flaky on Windows. Vanilla
 * `child_process.spawn` is good enough for two children.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionServerPorts } from '../../shared/session-server-ports.js';
import { ensureSidecarService } from './service-manager.js';

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

async function runLauncher(): Promise<void> {
  let sidecar;
  try {
    sidecar = await ensureSidecarService(REPO_ROOT);
  } catch (error) {
    process.stderr.write(
      `\n[launcher] sprite sidecar service failed: ${
        error instanceof Error ? error.message : String(error)
      }\n\n`,
    );
    process.exitCode = 1;
    return;
  }
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
      `  sidecar  → ${SESSION_PORTS.sidecarBaseUrl}/api/health (${sidecar.state}, pid=${sidecar.pid ?? 'unknown'})`,
      `  lab page → ${SESSION_PORTS.labBaseUrl}/lab.html?lab=sprite-gallery`,
      '  press Ctrl-C to stop the lab (the shared sidecar remains available)',
      '  stop service with: npm run sprites:sidecar:stop',
      '',
    ].join('\n'),
  );
}

void runLauncher();
