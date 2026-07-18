/**
 * CLI for the asset-pr consolidation (the deterministic backend of the
 * `.github/skills/asset-pr` skill).
 *
 * Usage:
 *   npm run sprites:asset-pr [-- --base main --remote origin]
 *
 * Lists every open `asset-checkin` issue, unions their pushed art branches into
 * one `assets/batch-<stamp>` branch, pushes it, and opens ONE PR that closes the
 * source issues. Prints the PR URL. Exits 0 (with a notice) when the queue is
 * empty.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runAssetPrConsolidation,
  type AssetPrRunnerDeps,
  type AssetPrOptions,
} from './asset-pr.js';
import type { Exec, ExecResult } from './checkin.js';

const realExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options?.cwd, maxBuffer: 32 * 1024 * 1024 },
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

function parseArgs(argv: ReadonlyArray<string>): AssetPrOptions {
  const options: { baseBranch?: string; remote?: string; slug?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--base') options.baseBranch = argv[++i];
    else if (arg.startsWith('--base=')) options.baseBranch = arg.slice('--base='.length);
    else if (arg === '--remote') options.remote = argv[++i];
    else if (arg.startsWith('--remote=')) options.remote = arg.slice('--remote='.length);
    else if (arg === '--slug') options.slug = argv[++i];
    else if (arg.startsWith('--slug=')) options.slug = arg.slice('--slug='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function makeDeps(): AssetPrRunnerDeps {
  return {
    exec: realExec,
    makeTempDir: () => Promise.resolve(mkdtempSync(path.join(tmpdir(), 'asset-pr-'))),
    removeDir: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
    readJson: <T>(absPath: string) =>
      Promise.resolve(JSON.parse(readFileSync(absPath, 'utf8')) as T),
    writeJson: (absPath, value) => {
      writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`);
      return Promise.resolve();
    },
    joinPath: (...segments) => path.join(...segments),
  };
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  let options: AssetPrOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  try {
    const result = await runAssetPrConsolidation(cwd, makeDeps(), options);
    if (result === null) {
      process.stdout.write(
        'No open asset-checkin issues or active asset PR — nothing to consolidate.\n',
      );
      return 0;
    }
    process.stdout.write(
      `Opened consolidation PR for ${result.plan.assets.length} asset(s) ` +
        `from ${result.plan.issueNumbers.length} issue(s).\n` +
        `  branch: ${result.plan.batchBranch}\n` +
        `  PR:     ${result.prUrl}\n` +
        `\nNext steps:\n` +
        `  1. Verify the PR is art-only and merge it.\n` +
        `  2. After merge, generate wiring for placeholders:\n` +
        `     npm run sprites:generate-wiring -- --since main\n` +
        `  3. Review and apply the wiring patches if needed.\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`asset-pr failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main(process.argv.slice(2), process.cwd()).then((code) => {
    process.exit(code);
  });
}
