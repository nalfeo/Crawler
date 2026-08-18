/**
 * CLI shim for `runQueueCommit`, invoked by the canvas sprite-editor extension
 * (a `.mjs` module that cannot import TypeScript) as a `tsx` subprocess after it
 * writes a manifest/catalog/PNG edit. It durably persists the edited asset onto
 * the remote `assets/queue` branch so anchor/metadata edits survive across
 * sessions/worktrees/processes.
 *
 * Usage:
 *   node <tsx-cli> queue-commit-cli.ts \
 *     --repo-root <path> \
 *     --asset generated/foo-var-1.png --manifest-key foo-var-1 \
 *     [--asset ... --manifest-key ...] \
 *     --message "chore(assets): queue foo-var-1"
 *
 * Prints a JSON result object to stdout on success. Exit codes are meaningful so
 * the caller can distinguish a benign skip from a real failure:
 *   0  committed or no-op (success)
 *   10 usage error
 *   20 ci-refused (skipped — the caller should treat this as non-fatal)
 *   30 invalid asset path
 *   1  any other failure (git error, retries exhausted)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckinAsset } from './checkin.js';
import { QueueCommitError, runQueueCommit, type SpriteAnnotationUpdate } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';

interface ParsedArgs {
  readonly repoRoot: string;
  readonly assets: readonly CheckinAsset[];
  readonly annotations: readonly SpriteAnnotationUpdate[];
  readonly message: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let repoRoot: string | undefined;
  let message: string | undefined;
  const assets: CheckinAsset[] = [];
  const annotations: SpriteAnnotationUpdate[] = [];

  const takeValue = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--repo-root') {
      repoRoot = takeValue(i, arg);
      i++;
    } else if (arg === '--message' || arg === '-m') {
      message = takeValue(i, arg);
      i++;
    } else if (arg === '--asset') {
      const assetPath = takeValue(i, arg);
      i++;
      assets.push({ assetPath, manifestKey: null, briefId: null, variantIndex: null });
    } else if (arg === '--manifest-key') {
      const key = takeValue(i, arg);
      i++;
      const last = assets[assets.length - 1];
      if (!last) throw new Error('--manifest-key must follow an --asset');
      assets[assets.length - 1] = { ...last, manifestKey: key };
    } else if (arg === '--annotation-json') {
      const encoded = takeValue(i, arg);
      i++;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch (error) {
        throw new Error(
          `--annotation-json must be base64url-encoded JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('--annotation-json must decode to an annotation object');
      }
      const candidate = value as Partial<SpriteAnnotationUpdate>;
      annotations.push({
        key: candidate.key as string,
        favorite: candidate.favorite as boolean,
        disliked: candidate.disliked as boolean,
        comment: candidate.comment as string,
      });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (repoRoot === undefined) throw new Error('Missing required --repo-root');
  if (message === undefined) throw new Error('Missing required --message');
  if (assets.length === 0 && annotations.length === 0) {
    throw new Error('At least one --asset or --annotation-json is required');
  }
  const orphan = assets.find((a) => a.manifestKey === null);
  if (orphan) {
    throw new Error(
      `--asset ${orphan.assetPath} is missing its paired --manifest-key. Every --asset ` +
        `must be immediately followed by its --manifest-key so the authoritative ` +
        `manifest/catalog entry is queued alongside the PNG; without it copyArtSurface ` +
        `queues an orphan image with no manifest/catalog entry.`,
    );
  }
  return { repoRoot, assets, annotations, message };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 10;
  }

  try {
    const result = await runQueueCommit(
      parsed.repoRoot,
      parsed.assets,
      createDefaultQueueCommitDeps(parsed.repoRoot),
      { message: parsed.message, annotations: parsed.annotations },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof QueueCommitError) {
      process.stderr.write(`queue-commit failed (${err.kind}): ${err.message}\n`);
      if (err.kind === 'ci-refused') return 20;
      if (err.kind === 'invalid-asset-path' || err.kind === 'invalid-annotation') return 30;
      return 1;
    }
    process.stderr.write(
      `queue-commit failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
