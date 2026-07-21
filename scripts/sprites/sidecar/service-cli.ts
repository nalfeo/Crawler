#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { ensureSidecarService, stopSidecarService } from './service-manager.js';

function parseRepoRoot(args: readonly string[]): string {
  const index = args.indexOf('--repo-root');
  const raw = index >= 0 ? args[index + 1] : undefined;
  return path.resolve(raw ?? process.cwd());
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'ensure';
  const repoRoot = parseRepoRoot(process.argv.slice(3));
  if (command === 'ensure') {
    const result = await ensureSidecarService(repoRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  }
  if (command === 'stop') {
    const stopped = await stopSidecarService(repoRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, stopped })}\n`);
    return 0;
  }
  process.stderr.write(`Unknown sprite sidecar service command: ${command}\n`);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
