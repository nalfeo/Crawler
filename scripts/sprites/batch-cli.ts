#!/usr/bin/env node
/**
 * sprites:batch CLI — unattended fleet runs for the sprite pipeline (Phase 3 build 6).
 *
 * Walks a directory of briefs (and/or an explicit list), runs each one
 * through `generateOne`, and writes a single batch summary describing
 * what got produced, what got skipped, and how much it all cost.
 *
 * Typical usage:
 *   npm run sprites:batch -- --briefs-dir briefs/weapons --judge-budget-usd 2.0
 *   npm run sprites:batch -- --brief a.yaml --brief b.yaml --judge-budget-usd 0.5
 *   npm run sprites:batch -- --briefs-dir briefs/weapons --dry-run
 *
 * Critically, the judge budget here is REQUIRED (either via flag,
 * `SPRITES_JUDGE_BUDGET_USD`, or an explicit `--no-budget` opt-out).
 * The whole reason this CLI exists is to drive judged briefs at scale
 * with a hard ceiling on spend; an Infinity default would defeat the
 * point.
 *
 * Provider construction reuses `provider/factory.ts` exactly as the
 * single-brief CLI does — no new env knobs introduced here. The batch
 * is a thin orchestrator over `generateOne`.
 */

import path from 'node:path';
import process from 'node:process';
import { JudgeBudget } from './cost-tracker.js';
import { JudgeCache } from './judge-cache.js';
import {
  runBatch,
  projectDryRunCost,
  type BatchBriefResult,
  type DryRunBriefInfo,
} from './batch.js';
import {
  createImageProvider,
  createTextProvider,
  createVisionProvider,
} from './provider/factory.js';
import { ProviderError } from './provider/types.js';
import { loadBrief } from './load-brief.js';
import { variantCount as computeVariantCount } from './brief-schema.js';

interface BatchCliArgs {
  readonly briefs: ReadonlyArray<string>;
  readonly briefsDir: string | null;
  readonly judgeBudgetUsd: number | undefined;
  readonly noBudget: boolean;
  readonly resetBudget: boolean;
  readonly noJudgeCache: boolean;
  readonly cacheMaxEntries: number | undefined;
  readonly pruneJudgeCacheHours: number | undefined;
  readonly concurrency: number;
  readonly dryRun: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): BatchCliArgs {
  const briefs: string[] = [];
  let briefsDir: string | null = null;
  let judgeBudgetUsd: number | undefined;
  let noBudget = false;
  let resetBudget = false;
  let noJudgeCache = false;
  let cacheMaxEntries: number | undefined;
  let pruneJudgeCacheHours: number | undefined;
  let concurrency = 1;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--brief') {
      const v = argv[++i];
      if (!v) throw new Error('--brief requires a path');
      briefs.push(v);
    } else if (arg === '--briefs-dir') {
      const v = argv[++i];
      if (!v) throw new Error('--briefs-dir requires a path');
      briefsDir = v;
    } else if (arg === '--judge-budget-usd') {
      const v = argv[++i];
      if (!v) throw new Error('--judge-budget-usd requires a number');
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--judge-budget-usd must be a non-negative number, got ${v}`);
      judgeBudgetUsd = n;
    } else if (arg === '--no-budget') {
      noBudget = true;
    } else if (arg === '--reset-budget') {
      resetBudget = true;
    } else if (arg === '--no-judge-cache') {
      noJudgeCache = true;
    } else if (arg === '--cache-max-entries') {
      const v = argv[++i];
      if (!v) throw new Error('--cache-max-entries requires a count');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--cache-max-entries must be a positive integer, got ${v}`);
      cacheMaxEntries = n;
    } else if (arg === '--prune-judge-cache') {
      const v = argv[++i];
      if (!v) throw new Error('--prune-judge-cache requires an hour count');
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--prune-judge-cache must be a non-negative number, got ${v}`);
      pruneJudgeCacheHours = n;
    } else if (arg === '--concurrency') {
      const v = argv[++i];
      if (!v) throw new Error('--concurrency requires an integer');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--concurrency must be a positive integer, got ${v}`);
      concurrency = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (arg) {
      briefs.push(arg);
    }
  }
  return {
    briefs,
    briefsDir,
    judgeBudgetUsd,
    noBudget,
    resetBudget,
    noJudgeCache,
    cacheMaxEntries,
    pruneJudgeCacheHours,
    concurrency,
    dryRun,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:batch — unattended fleet runs over a directory of briefs',
      '',
      'Usage:',
      '  npm run sprites:batch -- --briefs-dir briefs/weapons --judge-budget-usd 2.0',
      '  npm run sprites:batch -- --brief a.yaml --brief b.yaml --judge-budget-usd 0.5',
      '  npm run sprites:batch -- --briefs-dir briefs/ --dry-run',
      '',
      'Brief selection:',
      '  --brief <path>             Add an explicit brief. Repeatable.',
      '  --briefs-dir <path>        Glob **/*.yaml from this directory.',
      '                             Combinable with --brief.',
      '',
      'Cost gates (one of --judge-budget-usd, SPRITES_JUDGE_BUDGET_USD, or --no-budget is required):',
      '  --judge-budget-usd <n>     Hard USD cap on judge spend for this batch.',
      '  --no-budget                Opt out of the ceiling (dry runs / tests only).',
      '  --reset-budget             Wipe persisted cost-state.json before starting.',
      '  --no-judge-cache           Disable the vision-call cache.',
      '  --cache-max-entries <n>    LRU cap (default 1000).',
      '  --prune-judge-cache <h>    Drop cache entries older than <h> hours.',
      '',
      'Execution:',
      '  --concurrency <n>          Parallel briefs. Currently must be 1 (Azure',
      '                             rate-limit + budget accounting reasons).',
      '  --dry-run                  List briefs + project cost; no Azure calls.',
      '',
      '  --help, -h                 Show this help.',
      '',
    ].join('\n'),
  );
}

async function resolveBriefs(args: BatchCliArgs): Promise<string[]> {
  const explicit = args.briefs.map((p) => path.resolve(p));
  const fromDir: string[] = [];
  if (args.briefsDir) {
    const fsp = await import('node:fs/promises');
    const globFn = (fsp as unknown as { glob?: (p: string) => AsyncIterable<string> }).glob;
    if (typeof globFn !== 'function') {
      throw new Error('--briefs-dir requires Node 22+ (fs/promises.glob)');
    }
    const root = path.resolve(args.briefsDir);
    for await (const file of globFn(path.join(root, '**', '*.yaml'))) {
      fromDir.push(path.resolve(file));
    }
  }
  const deduped = Array.from(new Set([...explicit, ...fromDir])).sort();
  if (deduped.length === 0) {
    throw new Error(
      'No briefs to run. Use --brief <path> (repeatable) and/or --briefs-dir <path>.',
    );
  }
  return deduped;
}

function resolveBudget(args: BatchCliArgs): {
  readonly budget: JudgeBudget | null;
  readonly capUsd: number;
} {
  if (args.noBudget) {
    return { budget: null, capUsd: Number.POSITIVE_INFINITY };
  }
  const envRaw = process.env.SPRITES_JUDGE_BUDGET_USD;
  const envBudget =
    envRaw !== undefined && envRaw !== '' && Number.isFinite(Number(envRaw)) && Number(envRaw) >= 0
      ? Number(envRaw)
      : undefined;
  const cap = args.judgeBudgetUsd ?? envBudget;
  if (cap === undefined) {
    throw new Error(
      'sprites:batch requires a budget. Pass --judge-budget-usd <n>, set ' +
        'SPRITES_JUDGE_BUDGET_USD, or opt out with --no-budget (dry runs only).',
    );
  }
  const generatedDir = path.join(process.cwd(), 'generated');
  const budget = new JudgeBudget({
    budgetUsd: cap,
    modelDeployment: process.env.AZURE_OPENAI_VISION_DEPLOYMENT ?? 'unknown',
    stateFile: path.join(generatedDir, '.cost-state.json'),
    reset: args.resetBudget,
  });
  return { budget, capUsd: cap };
}

function formatLine(result: BatchBriefResult, index: number, total: number): string {
  const head = `[${String(index + 1).padStart(String(total).length)}/${total}] ${result.briefId}`;
  if (result.status === 'skipped-over-budget') {
    return `${head} → skipped-over-budget (${(result.elapsedMs / 1000).toFixed(1)}s)\n`;
  }
  if (result.status === 'failed') {
    return `${head} → FAILED: ${result.error?.message ?? '(no message)'} (${(result.elapsedMs / 1000).toFixed(1)}s)\n`;
  }
  const judged = result.summary?.candidates.filter((c) => c.judgeScorecard !== null).length ?? 0;
  const skipped =
    result.summary?.candidates.filter(
      (c) => c.judgeSkipReason === 'over-budget' || c.judgeSkipReason === 'over-cap',
    ).length ?? 0;
  const usd = result.summary?.judgeBudget?.spentUsd ?? 0;
  return `${head} → succeeded (${judged} judged, ${skipped} skipped, $${usd.toFixed(4)}, ${(result.elapsedMs / 1000).toFixed(1)}s)\n`;
}

async function main(): Promise<number> {
  let args: BatchCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  let briefs: string[];
  try {
    briefs = await resolveBriefs(args);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Create the judge cache early — needed by both the dry-run projection
  // (for per-brief cache-hit estimation) and the real run.
  const generatedDir = path.join(process.cwd(), 'generated');
  const judgeCache = new JudgeCache({
    cacheDir: path.join(generatedDir, '.judge-cache'),
    enabled: !args.noJudgeCache,
    ...(args.cacheMaxEntries !== undefined ? { maxEntries: args.cacheMaxEntries } : {}),
  });

  if (args.dryRun) {
    // Resolve deployment name from the same env var the real run uses, so
    // the dry-run pricing matches what JudgeBudget would compute.
    const modelDeployment = process.env.AZURE_OPENAI_VISION_DEPLOYMENT ?? 'gpt-4o';

    // Load each brief YAML to get per-brief variant counts. On error, fall
    // back to the default 4 so a bad brief doesn't abort the projection.
    const cacheHitsByBriefId = judgeCache.countEntriesByBriefId();
    const briefInfos: DryRunBriefInfo[] = briefs.map((briefPath) => {
      let vc = 4; // fallback variant count if brief loading fails
      let briefName = path.basename(briefPath).replace(/\.ya?ml$/i, '');
      try {
        const { brief } = loadBrief(briefPath, { projectRoot: process.cwd() });
        vc = computeVariantCount(brief);
        briefName = brief.name;
      } catch {
        // Brief failed to load — use defaults for projection.
      }
      // Cap cachedVariants at the actual variant count to guard against
      // stale meta entries from an old brief with more variants.
      const cachedVariants = Math.min(vc, cacheHitsByBriefId.get(briefName) ?? 0);
      return { variantCount: vc, cachedVariants };
    });

    const projection = projectDryRunCost({
      briefCount: briefs.length,
      modelDeployment,
      briefInfos,
    });

    process.stdout.write(
      `sprites:batch — DRY RUN, ${briefs.length} brief${briefs.length === 1 ? '' : 's'}\n`,
    );
    for (let i = 0; i < briefs.length; i++) {
      process.stdout.write(`  [${i + 1}/${briefs.length}] ${briefs[i]}\n`);
    }

    let cacheNote: string;
    if (!args.noJudgeCache && projection.cacheHitCount > 0) {
      cacheNote = `, ${projection.cacheHitCount} variant(s) estimated as cache hits ($0)`;
    } else if (!args.noJudgeCache) {
      cacheNote = ` (no prior cache entries found)`;
    } else {
      cacheNote = ` (cache disabled)`;
    }
    process.stdout.write(
      `\nprojected cost: $${projection.projectedUsd.toFixed(4)} ` +
        `(${projection.variantCallsProjected} variant call(s) × ` +
        `${projection.inputTokensPerCall}+${projection.outputTokensPerCall} tokens, ` +
        `${modelDeployment}-rates × ${projection.briefCount} briefs${cacheNote})\n`,
    );
    process.stdout.write(`(no Azure calls issued)\n`);
    return 0;
  }

  let budget: JudgeBudget | null;
  let capUsd: number;
  try {
    const resolved = resolveBudget(args);
    budget = resolved.budget;
    capUsd = resolved.capUsd;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (args.pruneJudgeCacheHours !== undefined) {
    const deleted = judgeCache.prune(args.pruneJudgeCacheHours);
    process.stdout.write(
      `judge-cache: pruned ${deleted} entr${deleted === 1 ? 'y' : 'ies'} older than ${args.pruneJudgeCacheHours}h\n`,
    );
  }

  let provider;
  let textProvider;
  let visionProvider;
  try {
    provider = createImageProvider();
    textProvider = createTextProvider();
    visionProvider = createVisionProvider();
  } catch (err) {
    if (err instanceof ProviderError) {
      process.stderr.write(`provider error [${err.kind}]: ${err.message}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }

  process.stdout.write(`sprites:batch — ${briefs.length} brief${briefs.length === 1 ? '' : 's'}\n`);
  if (Number.isFinite(capUsd)) {
    process.stdout.write(`  judge-budget: $${capUsd.toFixed(4)} cap\n`);
  } else {
    process.stdout.write(`  judge-budget: <no cap> (--no-budget)\n`);
  }
  if (!judgeCache.enabled) {
    process.stdout.write(`  judge-cache: disabled (--no-judge-cache)\n`);
  }

  const summary = await runBatch({
    briefPaths: briefs,
    repoRoot: process.cwd(),
    outputRoot: generatedDir,
    judgeBudget: budget,
    judgeCache,
    provider,
    textProvider,
    visionProvider,
    concurrency: args.concurrency,
    onBriefComplete: (result, index, total) => {
      process.stderr.write(formatLine(result, index, total));
    },
  });

  // Final block on stdout (one-line summaries went to stderr while
  // running). The batch summary path is the gallery's input contract.
  const t = summary.totals;
  process.stdout.write('\n=== batch summary ===\n');
  process.stdout.write(`batch-id : ${summary.batchId}\n`);
  process.stdout.write(`summary  : generated/runs/_batch/${summary.batchId}/batch-summary.json\n`);
  process.stdout.write(
    `briefs   : ${t.briefsAttempted} attempted — ` +
      `${t.briefsSucceeded} ok, ${t.briefsFailed} failed, ${t.briefsSkippedOverBudget} skipped-over-budget\n`,
  );
  process.stdout.write(
    `variants : ${t.variantsJudged} judged, ${t.variantsSkipped} skipped (over-cap or over-budget)\n`,
  );
  if (summary.judgeBudget) {
    const b = summary.judgeBudget;
    const remStr = Number.isFinite(b.remainingUsd) ? `$${b.remainingUsd.toFixed(4)}` : '<no cap>';
    process.stdout.write(
      `budget   : spent $${b.spentUsd.toFixed(4)}, remaining ${remStr}, ` +
        `${b.callsThisRun} calls, ${b.callsSkipped} skipped\n`,
    );
  }
  process.stdout.write(
    `cache    : ${summary.judgeCache.hits} hit, ${summary.judgeCache.misses} miss, ${summary.judgeCache.bypassed} bypassed\n`,
  );

  // Non-zero exit only when at least one brief outright FAILED. Skipped
  // briefs are by design (budget exhausted) so they're not an error.
  return t.briefsFailed > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
