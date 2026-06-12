#!/usr/bin/env node
/**
 * sprites:reprocess CLI — fast postprocess iteration from existing raw slices.
 *
 * Reuses `generated/runs/<brief>/<runId>/raw/*.png` from a prior run and
 * rebuilds processed PNGs + scorecards + summary without calling the image model.
 *
 * Supports A/B by emitting two new runs from the same source raw set.
 */

import path from 'node:path';
import process from 'node:process';
import { loadBrief } from './load-brief.js';
import { type ReprocessProfile, reprocessRuns } from './reprocess.js';

interface MutableSpeckleTuning {
  minChannel?: number;
  maxOpaqueNeighbors?: number;
  dropEdgeOrphans?: boolean;
}

interface MutableModuleSelection {
  speckleMode?: 'edge-drop' | 'preserve-orphans' | 'disabled';
}

interface CliArgs {
  readonly sourceRun: string;
  readonly brief: string | undefined;
  readonly profileA: ReprocessProfile;
  readonly profileB: ReprocessProfile | null;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let sourceRun: string | undefined;
  let brief: string | undefined;
  let aName = 'A';
  let bName: string | undefined;
  const aTuning: MutableSpeckleTuning = {};
  const bTuning: MutableSpeckleTuning = {};
  const aModules: MutableModuleSelection = {};
  const bModules: MutableModuleSelection = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} requires a value`);
      return v;
    };
    const nextInt = () => {
      const v = Number(next());
      if (!Number.isInteger(v) || v < 0) throw new Error(`${arg} must be a non-negative integer`);
      return v;
    };
    if (arg === '--source-run') sourceRun = next();
    else if (arg === '--brief') brief = next();
    else if (arg === '--a-name') aName = next();
    else if (arg === '--b-name') bName = next();
    else if (arg === '--a-min-channel') aTuning.minChannel = nextInt();
    else if (arg === '--a-max-opaque-neighbors') aTuning.maxOpaqueNeighbors = nextInt();
    else if (arg === '--a-drop-edge-orphans') aTuning.dropEdgeOrphans = true;
    else if (arg === '--a-keep-edge-orphans') aTuning.dropEdgeOrphans = false;
    else if (arg === '--a-speckle-mode') {
      const mode = next();
      if (!['edge-drop', 'preserve-orphans', 'disabled'].includes(mode)) {
        throw new Error(`--a-speckle-mode must be one of: edge-drop, preserve-orphans, disabled`);
      }
      aModules.speckleMode = mode as MutableModuleSelection['speckleMode'];
    } else if (arg === '--b-min-channel') bTuning.minChannel = nextInt();
    else if (arg === '--b-max-opaque-neighbors') bTuning.maxOpaqueNeighbors = nextInt();
    else if (arg === '--b-drop-edge-orphans') bTuning.dropEdgeOrphans = true;
    else if (arg === '--b-keep-edge-orphans') bTuning.dropEdgeOrphans = false;
    else if (arg === '--b-speckle-mode') {
      const mode = next();
      if (!['edge-drop', 'preserve-orphans', 'disabled'].includes(mode)) {
        throw new Error(`--b-speckle-mode must be one of: edge-drop, preserve-orphans, disabled`);
      }
      bModules.speckleMode = mode as MutableModuleSelection['speckleMode'];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!sourceRun) throw new Error('--source-run is required');
  return {
    sourceRun,
    brief,
    profileA: { name: aName, tuning: { ...aTuning }, modules: { ...aModules } },
    profileB: bName ? { name: bName, tuning: { ...bTuning }, modules: { ...bModules } } : null,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:reprocess — rebuild processed sprites from an existing run raw set',
      '',
      'Usage:',
      '  npm run sprites:reprocess -- --source-run generated/runs/<brief>/<runId>',
      '  npm run sprites:reprocess -- --source-run <runId> --brief <brief-id>',
      '  npm run sprites:reprocess -- --source-run <runDir> --a-name baseline --b-name candidate \\',
      '    --a-drop-edge-orphans --b-keep-edge-orphans',
      '',
      'Options:',
      '  --source-run <path|runId>       Source run dir or runId.',
      '  --brief <brief-id|brief.yaml>   Required only when --source-run is a runId.',
      '  --a-name <label>                Label for profile A run (default: A).',
      '  --b-name <label>                Emit profile B run for A/B comparison.',
      '  --a-min-channel <n>             Near-white threshold for profile A.',
      '  --a-max-opaque-neighbors <n>    Speckle neighborhood cap for profile A.',
      '  --a-drop-edge-orphans           Clear edge-adjacent near-white orphan pixels (A).',
      '  --a-keep-edge-orphans           Keep edge-adjacent near-white orphan pixels (A).',
      '  --a-speckle-mode <mode>         edge-drop | preserve-orphans | disabled',
      '  --b-min-channel <n>             Same knobs for profile B.',
      '  --b-max-opaque-neighbors <n>',
      '  --b-drop-edge-orphans',
      '  --b-keep-edge-orphans',
      '  --b-speckle-mode <mode>',
      '',
      'Notes:',
      '  - This command does NOT call the image model.',
      '  - It copies raw/*.png from the source run and rebuilds processed outputs + summary.',
    ].join('\n'),
  );
}

function looksLikePath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    /^[A-Za-z]:\\/.test(value)
  );
}

function resolveSourceRunDir(args: CliArgs, repoRoot: string): string {
  if (looksLikePath(args.sourceRun)) {
    return path.resolve(args.sourceRun);
  }
  if (!args.brief) {
    throw new Error('When --source-run is a runId, --brief <brief-id|brief.yaml> is required');
  }
  const briefId = args.brief.endsWith('.yaml')
    ? loadBrief(args.brief, { projectRoot: repoRoot }).brief.name
    : args.brief;
  return path.join(repoRoot, 'generated', 'runs', briefId, args.sourceRun);
}

function resolveBriefPath(args: CliArgs): string | undefined {
  if (!args.brief) return undefined;
  if (args.brief.endsWith('.yaml')) return path.resolve(args.brief);
  return undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const sourceRunDir = resolveSourceRunDir(args, repoRoot);
  const briefPath = resolveBriefPath(args);
  const out = reprocessRuns({
    repoRoot,
    sourceRunDir,
    briefPath,
    profileA: args.profileA,
    profileB: args.profileB,
  });

  process.stdout.write(`source-run : ${out.sourceRunDir}\n`);
  process.stdout.write(`brief      : ${out.briefPath}\n`);
  for (const run of out.runs) {
    process.stdout.write(`[${run.profile}] runId      : ${run.runId}\n`);
    process.stdout.write(`[${run.profile}] runDir     : ${run.runDir}\n`);
    process.stdout.write(`[${run.profile}] summary    : ${run.summaryPath}\n`);
  }
  if (out.runs.length > 1) {
    process.stdout.write(
      `\nA/B ready. Open the sprite gallery lab and compare runs:\n  ${out.runs[0]!.runId}\n  ${out.runs[1]!.runId}\n`,
    );
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`sprites:reprocess failed: ${message}\n`);
  process.exit(1);
}
