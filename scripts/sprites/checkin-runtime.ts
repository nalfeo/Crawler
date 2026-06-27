/**
 * Real (production) wiring for `runAssetCheckin` — the exec runner + fs hooks.
 * Shared by the `sprites:checkin` CLI and the sidecar's POST /api/checkin route
 * so both drive the exact same side-effect implementation.
 *
 * This module is intentionally separate from `checkin.ts` (which stays IO-free
 * for unit testing) and from `checkin-cli.ts` (which has an `invokedAsScript`
 * side effect on import).
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CheckinManifest, CheckinRunnerDeps, Exec, ExecResult } from './checkin.js';

const realExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options?.cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });

function copyArtSurface(srcRepoRoot: string, destRepoRoot: string): Promise<void> {
  const generatedSrc = path.join(srcRepoRoot, 'public', 'assets', 'generated');
  const generatedDest = path.join(destRepoRoot, 'public', 'assets', 'generated');
  if (existsSync(generatedSrc)) {
    cpSync(generatedSrc, generatedDest, { recursive: true });
  }
  const catalogSrc = path.join(srcRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  const catalogDest = path.join(destRepoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  if (existsSync(catalogSrc)) {
    cpSync(catalogSrc, catalogDest);
  }
  return Promise.resolve();
}

function makeReadManifest(repoRoot: string): () => Promise<CheckinManifest> {
  return () => {
    const manifestPath = path.join(repoRoot, 'public', 'assets', 'generated', 'manifest.json');
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      return Promise.resolve(JSON.parse(raw) as CheckinManifest);
    } catch {
      return Promise.resolve({});
    }
  };
}

/** Build the production `CheckinRunnerDeps` for a given repo root. */
export function createDefaultCheckinDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckinRunnerDeps {
  return {
    exec: realExec,
    copyArtSurface,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-checkin-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    readManifest: makeReadManifest(repoRoot),
    env,
  };
}
