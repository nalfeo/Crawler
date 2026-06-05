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
import { generateOne } from './generate-one.js';
import { createImageProvider, createTextProvider } from './provider/factory.js';
import { ProviderError } from './provider/types.js';

interface CliArgs {
  readonly briefs: ReadonlyArray<string>;
  readonly all: boolean;
  readonly pick: number | undefined;
}

interface BriefRunOutcome {
  readonly briefPath: string;
  readonly success: boolean;
  readonly message?: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const briefs: string[] = [];
  let all = false;
  let pick: number | undefined;
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
  if (!all && briefs.length === 0) {
    throw new Error('No brief specified. Use --brief <path> or --all.');
  }
  if (pick !== undefined && (all || briefs.length !== 1)) {
    throw new Error('--pick requires exactly one --brief');
  }
  return { briefs, all, pick };
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
      '  --brief <path>   Path to a YAML brief. Repeatable.',
      '  --all            Run every brief under briefs/**/*.yaml.',
      '  --pick <n>       Mark variant n as the chosen output (writes selection.json).',
      '  --help, -h       Show this help.',
      '',
      'Provider configuration is read from environment:',
      '  AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY (required)',
      '  AZURE_OPENAI_IMAGE_DEPLOYMENT, AZURE_OPENAI_API_VERSION (optional)',
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
  candidates: ReadonlyArray<{ index: number; score: number; outOf: number; passed: boolean }>,
  chosen: {
    readonly index: number;
    readonly score: number;
    readonly outOf: number;
    readonly anchor: { readonly x: number; readonly y: number; readonly source: string } | null;
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
): void {
  process.stdout.write(`\n=== ${briefPath} ===\n`);
  process.stdout.write(`run dir : ${runDir}\n`);
  process.stdout.write(`attempts: ${attempts}    duration: ${(durationMs / 1000).toFixed(1)}s\n`);
  const passed = candidates.filter((c) => c.passed).length;
  process.stdout.write(`variants: ${candidates.length}    passed: ${passed}\n`);
  const seedN = variations.seed.length;
  const propN = variations.proposed.length;
  const finalN = variations.final.length;
  const reason = variations.skippedReason ? ` [${variations.skippedReason}]` : '';
  process.stdout.write(
    `variations: ${seedN} seed + ${propN} expanded = ${finalN} final (min=${variations.minVariations})${reason}\n`,
  );
  if (chosen) {
    const anchorStr = chosen.anchor
      ? `anchor=(${chosen.anchor.x},${chosen.anchor.y}) [${chosen.anchor.source}]`
      : 'anchor=<none>';
    process.stdout.write(
      `chosen  : variant ${chosen.index} (${formatScore(chosen.score, chosen.outOf)}), ${anchorStr}\n`,
    );
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${pad('rank', 6)}${pad('idx', 6)}${pad('passed', 8)}score\n`);
  candidates.forEach((c, rank) => {
    const tag = c.passed ? 'PASS' : 'fail';
    process.stdout.write(
      `  ${pad(String(rank), 6)}${pad(String(c.index), 6)}${pad(tag, 8)}${formatScore(c.score, c.outOf)}\n`,
    );
  });
  if (diversity) {
    const fmt = (n: number) => n.toFixed(3);
    process.stdout.write(
      `\n  diversity: mean=${fmt(diversity.meanHamming)} min=${fmt(diversity.minHamming)} max=${fmt(diversity.maxHamming)} (${diversity.pairCount} pairs, ${diversity.bitLength}-bit pHash)\n`,
    );
  }
}

async function runOne(briefPath: string, pick: number | undefined): Promise<BriefRunOutcome> {
  const provider = createImageProvider();
  // Text provider is opt-in: returns null when no chat deployment is
  // configured. The orchestrator handles the null gracefully — runs
  // still produce sprites, just without LLM-expanded variations.
  const textProvider = createTextProvider();
  const start = Date.now();
  try {
    const result = await generateOne({
      briefPath,
      provider,
      textProvider,
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
    );
    const ranked = result.summary.candidates;
    const anyPassed = ranked.some((c) => c.passed);
    if (!anyPassed) {
      return {
        briefPath,
        success: false,
        message: 'No variant passed all sensors. Inspect the sheet under the run dir and rerun.',
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
      if (!picked.passed) {
        return {
          briefPath,
          success: false,
          message: `--pick ${pick}: that variant did not pass all sensors.`,
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
        readonly source: 'derived' | 'brief';
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
  const briefs = await resolveBriefs(args);
  process.stdout.write(`sprites:run — ${briefs.length} brief${briefs.length === 1 ? '' : 's'}\n`);
  const outcomes: BriefRunOutcome[] = [];
  for (const briefPath of briefs) {
    outcomes.push(await runOne(briefPath, args.pick));
  }
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
