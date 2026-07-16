#!/usr/bin/env node
/**
 * TEMPORARY (Floor 2 cactusfolk-boss regen retries — remove after use).
 *
 * Downloads every artifact for the NEW run(s) of a given briefId out of the
 * configured RunStore (Azure Blob in CI) into a local directory, so they can
 * be uploaded as a GitHub Actions artifact and pulled down for review. Reads
 * ONLY — never mutates the store, never approves/checks in anything.
 *
 * Usage:
 *   tsx scripts/sprites/ci-export-run.ts \
 *     --brief-id cactusfolk-boss \
 *     --exclude-run 2026-07-16T21-45-48-ab22fc16 \
 *     --out-dir ci-artifact-export
 *
 * `--exclude-run` may be repeated to exclude multiple known-prior run IDs.
 * Every run under `<brief-id>/` NOT in the exclude set is exported. Prints a
 * per-run summary (combinedPassed / score / judge breakdown per candidate) to
 * stdout for quick triage without opening the downloaded files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRunStore } from './store/index.js';

interface CliArgs {
  readonly briefId: string;
  readonly excludeRuns: ReadonlySet<string>;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    args.forEach((a, i) => {
      if (a === flag && args[i + 1]) out.push(args[i + 1]!);
    });
    return out;
  };

  const briefId = get('--brief-id');
  if (!briefId) {
    process.stderr.write('Error: --brief-id <id> is required.\n');
    process.exit(1);
  }
  const outDir = get('--out-dir') ?? 'ci-artifact-export';
  const excludeRuns = new Set(getAll('--exclude-run'));
  return { briefId, excludeRuns, outDir };
}

interface RunSummaryEntryLike {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  readonly passed: boolean;
  readonly combinedPassed: boolean;
  readonly judgeScorecard: unknown;
  readonly judgeSkipReason: string | null;
}

interface RunSummaryLike {
  readonly brief: string;
  readonly runId: string;
  readonly entries: readonly RunSummaryEntryLike[];
}

async function main(): Promise<void> {
  const { briefId, excludeRuns, outDir } = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const store = createRunStore({ repoRoot, env: process.env });

  const prefix = `${briefId}/`;
  const keys = await store.list(prefix);
  if (keys.length === 0) {
    process.stderr.write(`No keys found under prefix '${prefix}' in the ${store.backend} store.\n`);
    process.exit(1);
  }

  const runIds = new Set<string>();
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const runId = rest.split('/')[0];
    if (runId) runIds.add(runId);
  }

  const newRunIds = [...runIds].filter((id) => !excludeRuns.has(id)).sort();
  if (newRunIds.length === 0) {
    process.stderr.write(
      `No NEW runs found under '${prefix}' — only excluded run(s): ${[...runIds].join(', ')}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Discovered run(s) under '${prefix}': ${[...runIds].join(', ')}\n`);
  process.stdout.write(
    `Exporting NEW run(s) (excluding ${[...excludeRuns].join(', ') || '(none)'}): ${newRunIds.join(', ')}\n`,
  );

  const exportedRunDirs: string[] = [];

  for (const runId of newRunIds) {
    const runPrefix = `${briefId}/${runId}/`;
    const runKeys = keys.filter((k) => k.startsWith(runPrefix));
    const runOutDir = path.resolve(repoRoot, outDir, briefId, runId);
    mkdirSync(runOutDir, { recursive: true });

    for (const key of runKeys) {
      const rel = key.slice(`${briefId}/${runId}/`.length);
      const destAbs = path.resolve(runOutDir, rel);
      mkdirSync(path.dirname(destAbs), { recursive: true });
      const bytes = await store.get(key);
      writeFileSync(destAbs, bytes);
    }
    exportedRunDirs.push(runOutDir);
    process.stdout.write(`  wrote ${runKeys.length} files -> ${runOutDir}\n`);

    // Print a compact evaluation summary straight to CI logs so results are
    // visible even if the artifact download step is skipped.
    try {
      const summaryBytes = await store.get(`${runPrefix}summary.json`);
      const summary = JSON.parse(summaryBytes.toString('utf8')) as RunSummaryLike;
      process.stdout.write(`\n=== ${summary.brief} / ${summary.runId} — candidate summary ===\n`);
      for (const entry of summary.entries) {
        process.stdout.write(
          `  [${entry.index}] sensors=${entry.passed ? 'PASS' : 'FAIL'} ` +
            `score=${entry.score}/${entry.outOf} judge=${
              entry.judgeScorecard
                ? JSON.stringify(entry.judgeScorecard)
                : `skipped (${entry.judgeSkipReason ?? 'n/a'})`
            } combinedPassed=${entry.combinedPassed}\n`,
        );
      }
      const passingCount = summary.entries.filter((e) => e.combinedPassed).length;
      process.stdout.write(
        `  => ${passingCount}/${summary.entries.length} candidate(s) combinedPassed.\n\n`,
      );
    } catch (err) {
      process.stderr.write(`  (could not read/parse summary.json for ${runId}: ${String(err)})\n`);
    }
  }

  process.stdout.write(`Export complete. Local export root: ${path.resolve(repoRoot, outDir)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `ci-export-run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
