#!/usr/bin/env node
/**
 * TEMPORARY (Floor 2 cactusfolk-boss regen retries — remove after use).
 *
 * A `brief-path` queue job only runs the Generate stage (`generateOne`): it
 * writes the raw `sheet-00.png` + a sheet-only `summary.json` with
 * `candidates: []` and does NOT slice/score/judge (see `worker.ts`). This
 * script drives the two explicit re-run stages (ADR 0023, `rerun.ts`) over
 * that freshly-generated sheet — PostProcess (slice + deterministic sensors)
 * then Judge (VLM) — exactly the same per-variant pipeline a fresh
 * `generateOne` + `runFull` would have used for an `issue-request` job, just
 * invoked explicitly instead of inline. It never approves or checks in
 * anything, and it downloads every resulting artifact locally for review.
 *
 * Requires `SPRITES_ALLOW_CI_PIPELINE=true` in the environment (ADR 0043) —
 * same bypass already used by the "Drain worker" step — because `judge.ts`
 * otherwise refuses to run a live vision call under `CI`.
 *
 * Usage:
 *   tsx scripts/sprites/ci-reprocess-run.ts \
 *     --brief-id cactusfolk-boss-v1 \
 *     --exclude-run 2026-07-16T21-45-48-ab22fc16 \
 *     --out-dir ci-artifact-export
 *
 * `--exclude-run` may be repeated to skip known-prior run IDs. Every run
 * found under `<brief-id>/` NOT in the exclude set is reprocessed + exported.
 * Pass `--run-id <id>` instead to target one exact run (skips discovery).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadStyleGuide } from './build-prompt.js';
import { materializeBriefFromStore } from './brief-durability.js';
import { loadBrief } from './load-brief.js';
import { loadRecordedReferencePngs } from './load-reference-pngs.js';
import { createVisionProvider } from './provider/factory.js';
import { loadRunSummary, rejudgeRun, repostprocessRun } from './rerun.js';
import type { RunSummary } from './run-artifacts.js';
import { createRunStore } from './store/index.js';

interface CliArgs {
  readonly briefId: string;
  readonly runId?: string;
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
  const runId = get('--run-id');
  const excludeRuns = new Set(getAll('--exclude-run'));
  const outDir = get('--out-dir') ?? 'ci-artifact-export';
  return { briefId, runId, excludeRuns, outDir };
}

async function discoverRunIds(
  store: ReturnType<typeof createRunStore>,
  briefId: string,
  excludeRuns: ReadonlySet<string>,
): Promise<string[]> {
  const prefix = `${briefId}/`;
  const keys = await store.list(prefix);
  if (keys.length === 0) {
    throw new Error(`No keys found under prefix '${prefix}' in the ${store.backend} store.`);
  }
  const runIds = new Set<string>();
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const runId = rest.split('/')[0];
    if (runId) runIds.add(runId);
  }
  const newRunIds = [...runIds].filter((id) => !excludeRuns.has(id)).sort();
  if (newRunIds.length === 0) {
    throw new Error(
      `No NEW runs found under '${prefix}' — only excluded run(s): ${[...runIds].join(', ')}`,
    );
  }
  return newRunIds;
}

function printSummary(summary: RunSummary): void {
  process.stdout.write(`\n=== ${summary.brief} / ${summary.runId} — candidate summary ===\n`);
  for (const entry of [...summary.candidates].sort((a, b) => a.index - b.index)) {
    process.stdout.write(
      `  [${entry.index}] sensors=${entry.passed ? 'PASS' : 'FAIL'} ` +
        `score=${entry.score}/${entry.outOf} judge=${
          entry.judgeScorecard
            ? JSON.stringify(entry.judgeScorecard)
            : `skipped (${entry.judgeSkipReason ?? 'n/a'})`
        } combinedPassed=${entry.combinedPassed}\n`,
    );
  }
  const passingCount = summary.candidates.filter((e) => e.combinedPassed).length;
  process.stdout.write(
    `  => ${passingCount}/${summary.candidates.length} candidate(s) combinedPassed.\n\n`,
  );
}

async function exportRun(
  store: ReturnType<typeof createRunStore>,
  briefId: string,
  runId: string,
  repoRoot: string,
  outDir: string,
): Promise<string> {
  const runPrefix = `${briefId}/${runId}/`;
  const keys = await store.list(runPrefix);
  const runOutDir = path.resolve(repoRoot, outDir, briefId, runId);
  mkdirSync(runOutDir, { recursive: true });
  for (const key of keys) {
    const rel = key.slice(runPrefix.length);
    const destAbs = path.resolve(runOutDir, rel);
    mkdirSync(path.dirname(destAbs), { recursive: true });
    const bytes = await store.get(key);
    writeFileSync(destAbs, bytes);
  }
  process.stdout.write(`wrote ${keys.length} files -> ${runOutDir}\n`);
  return runOutDir;
}

async function main(): Promise<void> {
  const { briefId, runId, excludeRuns, outDir } = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const store = createRunStore({ repoRoot, env: process.env });

  const runIds = runId ? [runId] : await discoverRunIds(store, briefId, excludeRuns);
  process.stdout.write(`Reprocessing run(s) for ${briefId}: ${runIds.join(', ')}\n`);
  for (const oneRunId of runIds) {
    await reprocessAndExport(store, repoRoot, briefId, oneRunId, outDir);
  }
}

async function reprocessAndExport(
  store: ReturnType<typeof createRunStore>,
  repoRoot: string,
  briefId: string,
  runId: string,
  outDir: string,
): Promise<void> {
  process.stdout.write(`Loading run summary for ${briefId}/${runId}...\n`);
  const summary = await loadRunSummary(store, briefId, runId);

  if (summary.candidates.length > 0) {
    process.stdout.write(
      `Run already has ${summary.candidates.length} processed candidate(s) — skipping ` +
        `PostProcess/Judge, exporting as-is.\n`,
    );
    printSummary(summary);
    await exportRun(store, briefId, runId, repoRoot, outDir);
    return;
  }

  const briefPath = summary.briefPath;
  if (!briefPath) {
    throw new Error(`run ${briefId}/${runId} has no briefPath recorded in its summary.json`);
  }
  const absBriefPath = path.resolve(repoRoot, briefPath);
  const materialized = await materializeBriefFromStore(store, repoRoot, absBriefPath);
  if (!materialized) {
    throw new Error(
      `brief "${briefPath}" is absent from both disk and the store — cannot reprocess.`,
    );
  }
  const loaded = loadBrief(absBriefPath, { projectRoot: repoRoot });

  process.stdout.write('Running PostProcess (re-slice + deterministic sensors)...\n');
  const repost = await repostprocessRun({
    store,
    briefId,
    runId,
    summary,
    brief: loaded.brief,
    palette: loaded.palette,
  });
  process.stdout.write(
    `PostProcess complete: ${repost.summary.candidates.length} candidate(s) sliced/scored.\n`,
  );

  const visionProvider = createVisionProvider({ env: process.env });
  if (!visionProvider) {
    process.stdout.write(
      'No vision provider configured (AZURE_OPENAI_VISION_DEPLOYMENT / ' +
        'SPRITES_VISION_PROVIDER) — skipping Judge, exporting sensors-only results.\n',
    );
    printSummary(repost.summary);
    await exportRun(store, briefId, runId, repoRoot, outDir);
    return;
  }

  const styleGuide = loadStyleGuide(repoRoot);
  const references = loadRecordedReferencePngs({ summary: repost.summary, repoRoot });

  process.stdout.write('Running Judge (VLM) over sensor-passing candidates...\n');
  const rejudged = await rejudgeRun({
    store,
    briefId,
    runId,
    summary: repost.summary,
    brief: loaded.brief,
    referencePngs: references,
    styleGuide,
    visionProvider,
    env: process.env,
  });

  printSummary(rejudged.summary);
  await exportRun(store, briefId, runId, repoRoot, outDir);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `ci-reprocess-run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
