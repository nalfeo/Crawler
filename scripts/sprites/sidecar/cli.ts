#!/usr/bin/env node
/**
 * sprites:gallery sidecar entry point.
 *
 * Binds the Fastify server from `./server.ts` to **127.0.0.1:3010** only —
 * never 0.0.0.0 — per the spec's secrets-stay-local rule (§F8). Runs in the
 * foreground; Ctrl-C (SIGINT) or SIGTERM gracefully closes the server and
 * releases the port. An orphaned port-3010 process from a prior run would
 * otherwise force operators to hunt PIDs.
 *
 * No CLI flags today: the sidecar's location is implicit (`process.cwd()`),
 * the port is fixed, and the routes are static. Add flags here if/when
 * those need to vary.
 */

import path from 'node:path';
import process from 'node:process';
import { buildServer } from './server.js';

const HOST = '127.0.0.1';
const PORT = 3010;
const VERSION = '0.1.0-readonly';

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const runsDir = path.join(repoRoot, 'generated', 'runs');
  const app = buildServer({ repoRoot, runsDir, version: VERSION, logger: true });

  // SIGINT / SIGTERM both trigger a clean Fastify close so the port is
  // released even when the parent (e.g. the gallery launcher) is killed.
  // Without this an orphan binding survives in `netstat` for ~30s on
  // Windows and immediately on Linux but keeps the FD open.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`sprites:gallery sidecar: received ${signal}, closing\n`);
    await app.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const url = await app.listen({ host: HOST, port: PORT });
    process.stdout.write(`sprites:gallery sidecar listening on ${url}\n`);
    process.stdout.write(`  repoRoot: ${repoRoot}\n`);
    process.stdout.write(`  runsDir : ${runsDir}\n`);
    process.stdout.write(`  routes  : /api/health, /api/runs, /api/runs/:brief/:run, /api/runs/:brief/:run/processed/:file\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`sprites:gallery sidecar: failed to bind ${HOST}:${PORT}\n`);
    process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
      process.stderr.write(
        `  Hint: another sidecar may already be running. Stop it (Ctrl-C in the other terminal) and retry.\n`,
      );
    }
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
      // On code 0 we leave the process alive so Fastify can keep serving.
    },
    (err: unknown) => {
      process.stderr.write(
        `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
