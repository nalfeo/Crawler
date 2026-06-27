/**
 * CLI for checking in locally-approved generated art.
 *
 * Usage:
 *   npm run sprites:checkin [-- --base main --remote origin]
 *
 * It cuts a dedicated `assets/<slug>` branch off `origin/<base>` in a throwaway
 * worktree, copies the live art surface (public/assets/generated/** +
 * src/shared/data/sprite-catalog.json) into it, commits, pushes (NO PR), and
 * files an `asset-checkin` tracking issue. The asset-pr skill later turns open
 * asset-checkin issues into one game PR.
 *
 * Constitutional §3: refuses under CI (the guard lives in `runAssetCheckin`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckinError, runAssetCheckin } from './checkin.js';
import { createDefaultCheckinDeps } from './checkin-runtime.js';

interface ParsedArgs {
  readonly baseBranch: string;
  readonly remote: string;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let baseBranch = 'main';
  let remote = 'origin';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--base' || arg === '-b') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--base requires a branch name');
      baseBranch = next;
    } else if (arg.startsWith('--base=')) {
      baseBranch = arg.slice('--base='.length);
    } else if (arg === '--remote' || arg === '-r') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--remote requires a remote name');
      remote = next;
    } else if (arg.startsWith('--remote=')) {
      remote = arg.slice('--remote='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { baseBranch, remote };
}

export async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  try {
    const result = await runAssetCheckin(cwd, createDefaultCheckinDeps(cwd), {
      baseBranch: parsed.baseBranch,
      remote: parsed.remote,
    });
    process.stdout.write(
      `Checked in ${result.plan.assets.length} asset(s).\n` +
        `  branch: ${result.branch} (pushed to ${parsed.remote}, no PR)\n` +
        `  issue:  ${result.issueUrl}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof CheckinError) {
      process.stderr.write(`check-in failed (${err.kind}): ${err.message}\n`);
      return err.kind === 'nothing-to-checkin' ? 2 : err.kind === 'ci-refused' ? 3 : 1;
    }
    process.stderr.write(`check-in failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
