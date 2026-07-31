#!/usr/bin/env node
/**
 * icon-batch-cli.ts — single-shot run + approve + queue-commit for icon batches.
 *
 * This CLI is the CI entry point for icon generation. It combines:
 *   1. `sprites:run` — generates the batch sheet
 *   2. `sprites:approve --icon-batch` — approves every cell into the manifest
 *   3. `queue-commit` — pushes the approved assets to assets/queue (always,
 *      regardless of CI environment, so the CI workflow can chain it)
 *
 * Usage:
 *   npm run sprites:icon-batch -- run --brief briefs/icons/achievements/achv-icons-batch-01.yaml
 *   npm run sprites:icon-batch -- run-all
 *   npm run sprites:icon-batch -- status
 *
 * In CI this script is called once per batch brief. The workflow collects all
 * queue-commits and the existing sprite-queue-reconciler creates the PR.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { approveIconBatch, type IconBatchEntry } from './approve.js';
import { runQueueCommit } from './queue-commit.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';
import { runFull } from './run-full.js';
import {
  createImageProvider,
  createTextProvider,
  createVisionProvider,
} from './provider/factory.js';
import { ProviderError } from './provider/types.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const ICONS_BRIEF_DIR = path.join(REPO_ROOT, 'briefs', 'icons');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');

type Action = 'run' | 'run-all' | 'status';

interface ParsedArgs {
  readonly action: Action;
  /** Brief path(s) for 'run' action. */
  readonly briefPaths: ReadonlyArray<string>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const [rawAction, ...rest] = argv;
  if (!rawAction) {
    throw new Error(
      'Usage: npm run sprites:icon-batch -- <action> [options]\n' +
        'Actions:\n' +
        '  run --brief <path>   Generate + approve one batch brief\n' +
        '  run-all              Generate + approve all brief YAMLs under briefs/icons/\n' +
        '  status               Print per-batch approved icon counts\n',
    );
  }
  if (!['run', 'run-all', 'status'].includes(rawAction)) {
    throw new Error(`Unknown action: ${rawAction}. Expected: run | run-all | status`);
  }
  const action = rawAction as Action;
  const briefPaths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--brief') {
      const next = rest[++i];
      if (!next) throw new Error('--brief requires a path');
      briefPaths.push(path.isAbsolute(next) ? next : path.join(REPO_ROOT, next));
    }
  }
  if (action === 'run' && briefPaths.length === 0) {
    throw new Error("'run' requires at least one --brief <path>");
  }
  return { action, briefPaths };
}

/** Recursively collect all *.yaml files under a directory. */
function collectBriefs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectBriefs(full));
    } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
      results.push(full);
    }
  }
  return results.sort();
}

/** Read iconBatch entries from a YAML brief file. */
async function readIconBatch(briefPath: string): Promise<IconBatchEntry[]> {
  const { parse } = await import('yaml');
  const raw = parse(readFileSync(briefPath, 'utf8')) as Record<string, unknown>;
  const batch = raw['iconBatch'];
  if (!Array.isArray(batch) || batch.length === 0) {
    throw new Error(`Brief at ${briefPath} has no iconBatch array`);
  }
  return batch as IconBatchEntry[];
}

/** Run one brief through generate → approve → queue-commit. */
async function runBrief(briefPath: string): Promise<void> {
  const briefId = path.basename(briefPath, '.yaml');
  process.stdout.write(`\n── icon-batch: ${briefId} ─────────────────────────\n`);

  // 1. Generate.
  const provider = createImageProvider();
  const textProvider = createTextProvider();
  const visionProvider = createVisionProvider();
  let runDir: string;
  try {
    const result = await runFull({
      briefPath,
      provider,
      textProvider,
      visionProvider,
      repoRoot: REPO_ROOT,
    });
    runDir = result.runDir;
    process.stdout.write(`run dir : ${runDir}\n`);
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new Error(`Provider error for ${briefId}: [${err.kind}] ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }

  // 2. Approve.
  const iconBatch = await readIconBatch(briefPath);
  const manifestPath = path.join(GENERATED_DIR, 'manifest.json');
  const publicAssetsDir = path.join(REPO_ROOT, 'public', 'assets');

  const entries = approveIconBatch({
    runDir,
    iconBatch,
    manifestPath,
    publicAssetsDir,
    repoRoot: REPO_ROOT,
  });

  if (entries.length === 0) {
    process.stdout.write(
      `icon-batch: ${briefId}: no icons approved (all cells missing or duplicate)\n`,
    );
    return;
  }

  process.stdout.write(`icon-batch: ${briefId}: approved ${entries.length} icon(s):\n`);
  for (const e of entries) {
    process.stdout.write(`  ${e.spriteName} → ${e.assetPath}\n`);
  }

  // 3. Queue-commit (always, even in CI — this script is the CI entry point).
  try {
    const result = await runQueueCommit(
      REPO_ROOT,
      entries.map((e) => ({
        assetPath: e.assetPath,
        manifestKey: e.spriteName,
        briefId: e.briefId,
        variantIndex: e.variantIndex,
      })),
      createDefaultQueueCommitDeps(REPO_ROOT),
      { message: `chore(assets): approve icon batch ${briefId} (${entries.length} icons)` },
    );
    process.stdout.write(
      result.status === 'committed'
        ? `icon-batch: queued: ${result.branch} @ ${result.commit?.slice(0, 12)}\n`
        : `icon-batch: queued: no-op (${result.branch} already up to date)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `icon-batch: ⚠ queue-commit failed — approvals are LOCAL-ONLY. ` +
        `Retry with: npm run sprites:approve -- ${runDir} --icon-batch\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    // Non-fatal: the approved files are on disk; queue-commit can be retried.
  }
}

/** Print a status table for all known icon briefs. */
async function printStatus(): Promise<void> {
  const briefs = collectBriefs(ICONS_BRIEF_DIR);
  if (briefs.length === 0) {
    process.stdout.write(
      'No icon briefs found under briefs/icons/ — run `sprites:gen-achievement-icon-briefs` first.\n',
    );
    return;
  }

  const shardsDir = path.join(GENERATED_DIR, 'entries');
  const approvedIds = new Set<string>();
  if (existsSync(shardsDir)) {
    for (const f of readdirSync(shardsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const shard = JSON.parse(readFileSync(path.join(shardsDir, f), 'utf8')) as {
          spriteName?: string;
        };
        if (shard.spriteName) approvedIds.add(shard.spriteName);
      } catch {
        // ignore unreadable shards
      }
    }
  }

  process.stdout.write('\nIcon Batch Status\n');
  process.stdout.write('─────────────────────────────────────────────────────\n');
  process.stdout.write(`${'BRIEF'.padEnd(38)}${'TOTAL'.padStart(6)}${'APPROVED'.padStart(10)}\n`);
  process.stdout.write('─────────────────────────────────────────────────────\n');

  let totalIcons = 0;
  let totalApproved = 0;

  for (const briefPath of briefs) {
    const briefId = path.basename(briefPath, '.yaml');
    let batch: IconBatchEntry[];
    try {
      batch = await readIconBatch(briefPath);
    } catch {
      process.stdout.write(`  ${briefId.padEnd(36)}  (unreadable)\n`);
      continue;
    }
    const approved = batch.filter((e) => approvedIds.has(e.id)).length;
    totalIcons += batch.length;
    totalApproved += approved;
    const statusMark = approved === batch.length ? '✓' : approved > 0 ? '~' : '·';
    process.stdout.write(
      `${statusMark} ${briefId.padEnd(36)}${String(batch.length).padStart(6)}${String(approved).padStart(10)}\n`,
    );
  }

  process.stdout.write('─────────────────────────────────────────────────────\n');
  process.stdout.write(
    `  ${'TOTAL'.padEnd(36)}${String(totalIcons).padStart(6)}${String(totalApproved).padStart(10)}\n\n`,
  );
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    switch (parsed.action) {
      case 'run': {
        for (const brief of parsed.briefPaths) {
          await runBrief(brief);
        }
        break;
      }
      case 'run-all': {
        const briefs = collectBriefs(ICONS_BRIEF_DIR);
        if (briefs.length === 0) {
          process.stderr.write(
            'No icon briefs found under briefs/icons/ — run generate-briefs first.\n',
          );
          process.exit(1);
        }
        process.stdout.write(`icon-batch run-all: ${briefs.length} brief(s)\n`);
        for (const brief of briefs) {
          await runBrief(brief);
        }
        break;
      }
      case 'status': {
        await printStatus();
        break;
      }
    }
  } catch (err) {
    process.stderr.write(
      `icon-batch: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

await main();
