#!/usr/bin/env node
/**
 * sprites:run CLI — the human entry point to the generation pipeline.
 *
 * Usage:
 *   npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml
 *   npm run sprites:run -- --all
 *   npm run sprites:run -- --brief <path> --pick 2
 *
 * Responsibilities:
 *   - Resolve which brief(s) to run from --brief / --all.
 *   - Build the Azure (or future MAI) provider via the env-driven factory.
 *   - For each brief, invoke generateOne; print a per-variant table; if
 *     --pick is set, write `selection.json` next to the run artifacts and
 *     exit zero only when the picked variant passed all sensors.
 *   - Exit non-zero when any brief produces no passing candidate, or when
 *     a fatal provider/file error bubbles up. The CLI prints the error
 *     `kind` for ProviderError so failures are easy to triage.
 *
 * All formatting is plain ASCII so the output renders identically across
 * Windows Terminal, VS Code, and CI logs.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getSessionServerPorts } from '../shared/session-server-ports.js';
import { JudgeBudget } from './cost-tracker.js';
import { runFull } from './run-full.js';
import { JudgeCache } from './judge-cache.js';
import {
  DEFAULT_AZURE_DEPLOYMENT,
  createImageProvider,
  createTextProvider,
  createVisionProvider,
} from './provider/factory.js';
import { ProviderError } from './provider/types.js';
import { ensureSidecarService } from './sidecar/service-manager.js';

// The baseline `DEFAULT_AZURE_DEPLOYMENT` (provider/factory.ts) is listed first
// so the default/only-tested deployment stays selectable and benchmarkable via
// `--model`; without it the flag would be strictly more restrictive than the
// `AZURE_OPENAI_IMAGE_DEPLOYMENT` env var it overrides.
export const SUPPORTED_IMAGE_MODELS = [
  DEFAULT_AZURE_DEPLOYMENT,
  'gpt-image-2',
  'mai-image-2.5-flash',
  'gpt-image-1-mini',
  'mai-image-2.5',
] as const;
type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];

interface CliArgs {
  readonly briefs: ReadonlyArray<string>;
  readonly all: boolean;
  readonly pick: number | undefined;
  readonly judgeBudgetUsd: number | undefined;
  readonly resetBudget: boolean;
  readonly noJudgeCache: boolean;
  readonly pruneJudgeCacheHours: number | undefined;
  readonly cacheMaxEntries: number | undefined;
  readonly model: SupportedImageModel | undefined;
}

interface BriefRunOutcome {
  readonly briefPath: string;
  readonly success: boolean;
  readonly message?: string;
}

const SESSION_PORTS = getSessionServerPorts({ cwd: process.cwd(), env: process.env });
async function ensureSidecarRunning(): Promise<void> {
  try {
    const result = await ensureSidecarService(process.cwd());
    process.stdout.write(
      `sidecar : ${result.state} (${SESSION_PORTS.sidecarBaseUrl}/api/health, pid=${result.pid ?? 'unknown'})\n`,
    );
  } catch (err) {
    process.stderr.write(
      `sidecar : failed to auto-start (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const briefs: string[] = [];
  let all = false;
  let pick: number | undefined;
  let judgeBudgetUsd: number | undefined;
  let resetBudget = false;
  let noJudgeCache = false;
  let pruneJudgeCacheHours: number | undefined;
  let cacheMaxEntries: number | undefined;
  let model: SupportedImageModel | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--brief') {
      const value = argv[++i];
      if (!value) throw new Error('--brief requires a path');
      briefs.push(value);
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--pick') {
      const value = argv[++i];
      if (!value) throw new Error('--pick requires a variant index');
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`--pick must be a non-negative integer, got ${value}`);
      pick = n;
    } else if (arg === '--judge-budget-usd') {
      const value = argv[++i];
      if (!value) throw new Error('--judge-budget-usd requires a number');
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--judge-budget-usd must be a non-negative number, got ${value}`);
      judgeBudgetUsd = n;
    } else if (arg === '--reset-budget') {
      resetBudget = true;
    } else if (arg === '--no-judge-cache') {
      noJudgeCache = true;
    } else if (arg === '--prune-judge-cache') {
      const value = argv[++i];
      if (!value) throw new Error('--prune-judge-cache requires an hour count');
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--prune-judge-cache must be a non-negative number, got ${value}`);
      pruneJudgeCacheHours = n;
    } else if (arg === '--cache-max-entries') {
      const value = argv[++i];
      if (!value) throw new Error('--cache-max-entries requires a count');
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`--cache-max-entries must be a positive integer, got ${value}`);
      cacheMaxEntries = n;
    } else if (arg === '--model') {
      const value = argv[++i];
      if (!value) throw new Error('--model requires a model name');
      if (!(SUPPORTED_IMAGE_MODELS as ReadonlyArray<string>).includes(value)) {
        throw new Error(
          `--model '${value}' is not supported. Choose one of: ${SUPPORTED_IMAGE_MODELS.join(', ')}.`,
        );
      }
      model = value as SupportedImageModel;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (arg) {
      // Positional brief path — convenience shorthand.
      briefs.push(arg);
    }
  }
  if (all && briefs.length > 0) {
    throw new Error('--all and --brief are mutually exclusive');
  }
  if (!all && briefs.length === 0 && pruneJudgeCacheHours === undefined) {
    throw new Error('No brief specified. Use --brief <path> or --all.');
  }
  if (pick !== undefined && (all || briefs.length !== 1)) {
    throw new Error('--pick requires exactly one --brief');
  }
  return {
    briefs,
    all,
    pick,
    judgeBudgetUsd,
    resetBudget,
    noJudgeCache,
    pruneJudgeCacheHours,
    cacheMaxEntries,
    model,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:run — generate sprites from briefs',
      '',
      'Usage:',
      '  npm run sprites:run -- --brief <path>',
      '  npm run sprites:run -- --all',
      '  npm run sprites:run -- --brief <path> --pick <variantIndex>',
      '',
      'Options:',
      '  --brief <path>             Path to a YAML brief. Repeatable.',
      '  --all                      Run every brief under briefs/**/*.yaml.',
      '  --pick <n>                 Mark variant n as the chosen output (writes selection.json).',
      '  --model <name>             Image model to use. Overrides AZURE_OPENAI_IMAGE_DEPLOYMENT.',
      `                             Supported: ${SUPPORTED_IMAGE_MODELS.join(', ')}.`,
      '  --judge-budget-usd <n>     Cross-run USD ceiling on VLM judge spend (default: unlimited).',
      '                             Also reads SPRITES_JUDGE_BUDGET_USD when unset.',
      '  --reset-budget             Clear the persisted cost-state.json before running.',
      '  --no-judge-cache           Disable the vision-call cache for this run.',
      '  --cache-max-entries <n>    Max cached judge scorecards (default: 1000).',
      '  --prune-judge-cache <h>    Delete cache entries older than <h> hours, then continue.',
      '                             May be used standalone (no --brief/--all) as a housekeeping pass.',
      '  --help, -h                 Show this help.',
      '',
      'Provider configuration is read from environment:',
      '  AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY (required)',
      '  AZURE_OPENAI_IMAGE_DEPLOYMENT, AZURE_OPENAI_API_VERSION (optional; --model takes precedence)',
      '  SPRITES_PROVIDER=azure-openai (default; future: mai-image)',
      '',
    ].join('\n'),
  );
}

async function resolveBriefs(args: CliArgs): Promise<string[]> {
  if (!args.all) return args.briefs.map((p) => path.resolve(p));
  const fsp = await import('node:fs/promises');
  const globFn = (fsp as unknown as { glob?: (p: string) => AsyncIterable<string> }).glob;
  if (typeof globFn !== 'function') {
    throw new Error('--all requires Node 22+ (fs/promises.glob)');
  }
  const matches: string[] = [];
  for await (const file of globFn('briefs/**/*.yaml')) {
    matches.push(path.resolve(file));
  }
  matches.sort();
  if (matches.length === 0) throw new Error('--all matched no briefs/**/*.yaml files');
  return matches;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatScore(score: number, outOf: number): string {
  const pct = outOf > 0 ? Math.round((score / outOf) * 100) : 0;
  return `${score}/${outOf} (${pct}%)`;
}

function printSummary(
  briefPath: string,
  runDir: string,
  attempts: number,
  candidates: ReadonlyArray<{
    index: number;
    score: number;
    outOf: number;
    passed: boolean;
    combinedPassed: boolean;
    judgeScorecard: {
      readonly passed: boolean;
      readonly minScore: number;
      readonly designLanguage?: { readonly score: number };
      readonly referenceStyleMatch?: { readonly score: number };
      readonly styleMatch: { readonly score: number };
      readonly briefMatch: { readonly score: number };
      readonly readability: { readonly score: number };
      readonly themeAdherence?: { readonly score: number };
      readonly rejectedBy: ReadonlyArray<string>;
    } | null;
    judgeSkipReason: 'judge-disabled' | 'sensor-failed' | 'over-cap' | 'over-budget' | null;
  }>,
  chosen: {
    readonly index: number;
    readonly score: number;
    readonly outOf: number;
    readonly anchor: { readonly x: number; readonly y: number; readonly source: string } | null;
    readonly judgeScorecard: {
      readonly passed: boolean;
      readonly minScore: number;
    } | null;
  } | null,
  durationMs: number,
  diversity: {
    meanHamming: number;
    minHamming: number;
    maxHamming: number;
    pairCount: number;
    bitLength: number;
  } | null,
  variations: {
    seed: ReadonlyArray<string>;
    proposed: ReadonlyArray<string>;
    final: ReadonlyArray<string>;
    minVariations: number;
    skippedReason: string | null;
  },
  judgeEnabled: boolean,
): void {
  process.stdout.write(`\n=== ${briefPath} ===\n`);
  process.stdout.write(`run dir : ${runDir}\n`);
  process.stdout.write(`attempts: ${attempts}    duration: ${(durationMs / 1000).toFixed(1)}s\n`);
  const sensorPassed = candidates.filter((c) => c.passed).length;
  const combinedPassed = candidates.filter((c) => c.combinedPassed).length;
  const passLine = judgeEnabled
    ? `variants: ${candidates.length}    sensor-pass: ${sensorPassed}    full-pipeline-pass: ${combinedPassed}`
    : `variants: ${candidates.length}    passed: ${sensorPassed}`;
  process.stdout.write(`${passLine}\n`);
  const seedN = variations.seed.length;
  const propN = variations.proposed.length;
  const finalN = variations.final.length;
  const reason = variations.skippedReason ? ` [${variations.skippedReason}]` : '';
  process.stdout.write(
    `variations: ${seedN} seed + ${propN} expanded = ${finalN} final (min=${variations.minVariations})${reason}\n`,
  );
  if (judgeEnabled) {
    process.stdout.write(
      `judge   : enabled (design_language / reference_style_match / brief_match / readability [+ theme_adherence when addendum present], < 3 rejects)\n`,
    );
  }
  if (chosen) {
    const anchorStr = chosen.anchor
      ? `anchor=(${chosen.anchor.x},${chosen.anchor.y}) [${chosen.anchor.source}]`
      : 'anchor=<none>';
    const judgeStr = chosen.judgeScorecard
      ? `, judge-min=${chosen.judgeScorecard.minScore}/5 ${chosen.judgeScorecard.passed ? 'PASS' : 'fail'}`
      : '';
    process.stdout.write(
      `chosen  : variant ${chosen.index} (${formatScore(chosen.score, chosen.outOf)}${judgeStr}), ${anchorStr}\n`,
    );
  }
  process.stdout.write('\n');
  const headerJudge = judgeEnabled ? pad('judge', 18) : '';
  process.stdout.write(
    `  ${pad('rank', 6)}${pad('idx', 6)}${pad('passed', 8)}${pad('score', 14)}${headerJudge}\n`,
  );
  candidates.forEach((c, rank) => {
    const tag = c.combinedPassed ? 'PASS' : 'fail';
    let judgeCol = '';
    if (judgeEnabled) {
      if (c.judgeScorecard) {
        const j = c.judgeScorecard;
        const verdict = j.passed ? 'PASS' : `FAIL[${j.rejectedBy.join(',')}]`;
        const dl = (j.designLanguage ?? j.styleMatch).score;
        const rsm = (j.referenceStyleMatch ?? j.styleMatch).score;
        const bm = j.briefMatch.score;
        const r = j.readability.score;
        const ta = j.themeAdherence !== undefined ? `/${j.themeAdherence.score}` : '';
        judgeCol = `${dl}/${rsm}/${bm}/${r}${ta} ${verdict}`;
      } else {
        judgeCol =
          c.judgeSkipReason === 'sensor-failed'
            ? '— sensor-failed'
            : c.judgeSkipReason === 'over-cap'
              ? '— over-cap'
              : c.judgeSkipReason === 'over-budget'
                ? '— over-budget'
                : '—';
      }
    }
    process.stdout.write(
      `  ${pad(String(rank), 6)}${pad(String(c.index), 6)}${pad(tag, 8)}${pad(formatScore(c.score, c.outOf), 14)}${judgeCol}\n`,
    );
  });
  if (diversity) {
    const fmt = (n: number) => n.toFixed(3);
    process.stdout.write(
      `\n  diversity: mean=${fmt(diversity.meanHamming)} min=${fmt(diversity.minHamming)} max=${fmt(diversity.maxHamming)} (${diversity.pairCount} pairs, ${diversity.bitLength}-bit pHash)\n`,
    );
  }
}

async function runOne(
  briefPath: string,
  pick: number | undefined,
  judgeBudget: JudgeBudget | null,
  judgeCache: JudgeCache | null,
): Promise<BriefRunOutcome> {
  const start = Date.now();
  try {
    const provider = createImageProvider();
    const textProvider = createTextProvider();
    const visionProvider = createVisionProvider();
    const result = await runFull({
      briefPath,
      provider,
      textProvider,
      visionProvider,
      judgeBudget,
      judgeCache,
      repoRoot: process.cwd(),
    });
    const duration = Date.now() - start;
    printSummary(
      briefPath,
      result.runDir,
      result.attempts,
      result.summary.candidates,
      result.summary.chosen,
      duration,
      result.summary.diversity,
      result.summary.variations,
      result.brief.judge.enabled,
    );
    const ranked = result.summary.candidates;
    const anyPassed = ranked.some((c) => c.combinedPassed);
    if (!anyPassed) {
      const gate = result.brief.judge.enabled ? 'all sensors + the VLM judge' : 'all sensors';
      return {
        briefPath,
        success: false,
        message: `No variant passed ${gate}. Inspect the sheet under the run dir and rerun.`,
      };
    }
    if (pick !== undefined) {
      // pick is a *variant index*, not a rank. Match against entries.index.
      const picked = ranked.find((c) => c.index === pick);
      if (!picked) {
        return {
          briefPath,
          success: false,
          message: `--pick ${pick}: variant index not found (only ${ranked.length} variants).`,
        };
      }
      if (!picked.combinedPassed) {
        const gate = result.brief.judge.enabled ? 'all sensors and the VLM judge' : 'all sensors';
        return {
          briefPath,
          success: false,
          message: `--pick ${pick}: that variant did not pass ${gate}.`,
        };
      }
      const selectionPath = path.join(result.runDir, 'selection.json');
      // Resolve the anchor surfaced in selection.json:
      //   - In derive mode (brief opted into `sensors.anchor.derive`), only
      //     a per-variant derivedAnchor is valid — `brief.anchor` is
      //     informational and must NOT be surfaced. If the picked variant
      //     has no derivedAnchor, anchor is null so downstream tools see the
      //     failure rather than a wrong static value.
      //   - In legacy mode, the static `brief.anchor` applies to every
      //     variant, so it's surfaced regardless of which variant was picked.
      //   - When the picked variant matches the auto-chosen top, the already
      //     resolved `chosen.anchor` is preferred so the two artifacts agree.
      const deriveMode = result.brief.sensors.anchor?.derive === true;
      let pickedAnchor: {
        readonly x: number;
        readonly y: number;
        readonly source: 'manual' | 'derived' | 'brief';
      } | null;
      if (result.summary.chosen && result.summary.chosen.index === picked.index) {
        pickedAnchor = result.summary.chosen.anchor;
      } else if (picked.derivedAnchor) {
        pickedAnchor = {
          x: picked.derivedAnchor.x,
          y: picked.derivedAnchor.y,
          source: 'derived' as const,
        };
      } else if (deriveMode) {
        pickedAnchor = null;
      } else {
        pickedAnchor = {
          x: result.brief.anchor.x,
          y: result.brief.anchor.y,
          source: 'brief' as const,
        };
      }
      writeFileSync(
        selectionPath,
        `${JSON.stringify(
          {
            brief: result.summary.brief,
            runId: result.summary.runId,
            pickedIndex: picked.index,
            score: picked.score,
            outOf: picked.outOf,
            processedPath: picked.processedPath,
            scorecardPath: picked.scorecardPath,
            anchor: pickedAnchor,
          },
          null,
          2,
        )}\n`,
      );
      process.stdout.write(`\nselected variant ${picked.index} -> ${selectionPath}\n`);
    }
    return { briefPath, success: true };
  } catch (err) {
    if (err instanceof ProviderError) {
      return { briefPath, success: false, message: `provider error [${err.kind}]: ${err.message}` };
    }
    return {
      briefPath,
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  // Construct cross-run budget and cache once, before any brief runs.
  // Both are scoped to `<cwd>/generated/` to match the spec and to
  // keep the .gitignore rule (`generated/`) covering them by default.
  const generatedDir = path.join(process.cwd(), 'generated');
  const envBudget = process.env.SPRITES_JUDGE_BUDGET_USD
    ? Number(process.env.SPRITES_JUDGE_BUDGET_USD)
    : undefined;
  const budgetUsd =
    args.judgeBudgetUsd ??
    (envBudget !== undefined && Number.isFinite(envBudget) && envBudget >= 0
      ? envBudget
      : Number.POSITIVE_INFINITY);
  const judgeBudget = new JudgeBudget({
    budgetUsd,
    modelDeployment: process.env.AZURE_OPENAI_VISION_DEPLOYMENT ?? 'unknown',
    stateFile: path.join(generatedDir, '.cost-state.json'),
    reset: args.resetBudget,
  });
  const judgeCache = new JudgeCache({
    cacheDir: path.join(generatedDir, '.judge-cache'),
    enabled: !args.noJudgeCache,
    ...(args.cacheMaxEntries !== undefined ? { maxEntries: args.cacheMaxEntries } : {}),
  });
  if (args.pruneJudgeCacheHours !== undefined) {
    const deleted = judgeCache.prune(args.pruneJudgeCacheHours);
    process.stdout.write(
      `judge-cache: pruned ${deleted} entr${deleted === 1 ? 'y' : 'ies'} older than ${args.pruneJudgeCacheHours}h\n`,
    );
  }

  if (args.briefs.length === 0 && !args.all) {
    // Standalone housekeeping pass: nothing else to do.
    return 0;
  }

  const briefs = await resolveBriefs(args);
  process.stdout.write(`sprites:run — ${briefs.length} brief${briefs.length === 1 ? '' : 's'}\n`);
  if (args.model) {
    process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT = args.model;
    process.stdout.write(`  model   : ${args.model} (--model override)\n`);
  }
  if (Number.isFinite(budgetUsd)) {
    process.stdout.write(`  judge-budget: $${budgetUsd.toFixed(4)} cap, ${judgeBudget.format()}\n`);
  }
  if (!judgeCache.enabled) {
    process.stdout.write(`  judge-cache: disabled (--no-judge-cache)\n`);
  }
  const outcomes: BriefRunOutcome[] = [];
  for (const briefPath of briefs) {
    outcomes.push(await runOne(briefPath, args.pick, judgeBudget, judgeCache));
  }
  // Final budget + cache summary for batch visibility.
  process.stdout.write(`\n${judgeBudget.format()}\n`);
  const cs = judgeCache.stats;
  process.stdout.write(`judge-cache: ${cs.hits} hit, ${cs.misses} miss, ${cs.bypassed} bypassed\n`);
  await ensureSidecarRunning();
  const failed = outcomes.filter((o) => !o.success);
  if (failed.length > 0) {
    process.stderr.write('\nFailures:\n');
    for (const f of failed) {
      process.stderr.write(`  - ${f.briefPath}: ${f.message ?? '(no message)'}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `\nAll ${outcomes.length} brief${outcomes.length === 1 ? '' : 's'} succeeded.\n`,
  );
  return 0;
}

// CLI entry: only run when this is the script being executed, not on import.
// Vitest setups sometimes import for collection; gate on argv[1] to be safe.
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
