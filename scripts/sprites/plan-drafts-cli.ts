#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import type { Brief } from './brief-schema.js';
import type { AssetPlanStatus } from './asset-plan.js';
import { briefDirectoryForType, isSpriteType } from './brief-paths.js';
import {
  DEFAULT_PLAN_DRAFT_STATUSES,
  materializePlanDrafts,
  parseStatusValue,
} from './plan-drafts.js';

type SpriteType = Brief['type'];

interface PlanDraftCliArgs {
  readonly planPath: string;
  readonly manifestPath: string;
  readonly outputRoot: string;
  readonly statuses: ReadonlyArray<AssetPlanStatus>;
  readonly types: ReadonlyArray<SpriteType>;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): PlanDraftCliArgs {
  let planPath: string | undefined;
  let manifestPath = path.join('public', 'assets', 'generated', 'manifest.json');
  let outputRoot = path.join('briefs', 'draft');
  const statuses: AssetPlanStatus[] = [];
  const types: SpriteType[] = [];
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan') {
      const value = argv[i + 1];
      if (!value) throw new Error('--plan requires a file path');
      planPath = value;
      i += 1;
    } else if (arg === '--manifest') {
      const value = argv[i + 1];
      if (!value) throw new Error('--manifest requires a file path');
      manifestPath = value;
      i += 1;
    } else if (arg === '--output-root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--output-root requires a directory');
      outputRoot = value;
      i += 1;
    } else if (arg === '--status') {
      const value = argv[i + 1];
      if (!value) throw new Error('--status requires a value');
      statuses.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => parseStatusValue(entry)),
      );
      i += 1;
    } else if (arg === '--type') {
      const value = argv[i + 1];
      if (!value) throw new Error('--type requires a value');
      for (const entry of value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)) {
        if (!isSpriteType(entry)) {
          throw new Error(`--type '${entry}' is not a valid sprite type`);
        }
        types.push(entry);
      }
      i += 1;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!planPath) {
      planPath = arg;
    } else {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
  }

  if (!planPath) {
    throw new Error(
      'Missing plan path. Use --plan <path> or provide it as the first positional arg.',
    );
  }

  return {
    planPath,
    manifestPath,
    outputRoot,
    statuses:
      statuses.length > 0 ? Array.from(new Set(statuses)) : [...DEFAULT_PLAN_DRAFT_STATUSES],
    types: Array.from(new Set(types)),
    force,
    dryRun,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:plan-drafts — materialize runnable draft briefs from an art plan',
      '',
      'Usage:',
      '  npm run sprites:plan-drafts -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      '  npm run sprites:plan-drafts -- plans/floor-art/rat-themed-dungeon-floor.art.yaml --type enemy,item',
      '',
      'Options:',
      '  --plan <path>             Art plan YAML file.',
      '  --manifest <path>         Override generated manifest path.',
      '                            Default: public/assets/generated/manifest.json',
      '  --output-root <dir>       Draft brief output root. Default: briefs/draft',
      `  --status <value>          Repeatable or comma-separated. Default: ${DEFAULT_PLAN_DRAFT_STATUSES.join(', ')}`,
      '  --type <value>            Repeatable or comma-separated sprite types to emit.',
      '  --force                   Overwrite an existing draft brief.',
      '  --dry-run                 Report what would be written without touching disk.',
      '  --help, -h                Show this help.',
      '',
      'Draft folders by type:',
      `  weapon -> ${briefDirectoryForType('weapon')}`,
      `  enemy -> ${briefDirectoryForType('enemy')}`,
      `  item -> ${briefDirectoryForType('item')}`,
      `  tile -> ${briefDirectoryForType('tile')}`,
      `  vfx -> ${briefDirectoryForType('vfx')}`,
      `  character -> ${briefDirectoryForType('character')}`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  let args: PlanDraftCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  const result = materializePlanDrafts({
    repoRoot: process.cwd(),
    planPath: args.planPath,
    manifestPath: args.manifestPath,
    outputRoot: args.outputRoot,
    statuses: args.statuses,
    types: args.types,
    force: args.force,
    dryRun: args.dryRun,
  });

  process.stdout.write(
    `sprites:plan-drafts — ${result.planId}\n` +
      `  targeted: ${result.targeted.length}\n` +
      `  written : ${result.written.length}${args.dryRun ? ' (dry-run)' : ''}\n` +
      `  skipped : ${result.skipped.length}\n`,
  );

  for (const record of result.written) {
    process.stdout.write(
      `  ${args.dryRun ? 'would-write' : 'wrote'} ${path.relative(process.cwd(), record.draftPath)} ` +
        `[${record.type} · ${record.status}]\n`,
    );
  }
  for (const record of result.skipped) {
    process.stdout.write(
      `  skipped ${path.relative(process.cwd(), record.draftPath)} (${record.reason})\n`,
    );
  }
  return 0;
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
