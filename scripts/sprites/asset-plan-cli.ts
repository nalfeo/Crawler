#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import {
  STATUS_ORDER,
  buildAssetPlanReport,
  collectCommittedBriefs,
  loadApprovedSprites,
  loadAssetPlan,
  type AssetPlanReport,
} from './asset-plan.js';

interface AssetPlanCliArgs {
  readonly planPath: string;
  readonly manifestPath: string;
  readonly format: 'table' | 'json';
  readonly failOnPlaceholder: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): AssetPlanCliArgs {
  let planPath: string | undefined;
  let manifestPath = path.join('public', 'assets', 'generated', 'manifest.json');
  let format: AssetPlanCliArgs['format'] = 'table';
  let failOnPlaceholder = false;

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
    } else if (arg === '--format') {
      const value = argv[i + 1];
      if (value !== 'table' && value !== 'json') {
        throw new Error(`--format must be "table" or "json", got "${value ?? ''}"`);
      }
      format = value;
      i += 1;
    } else if (arg === '--fail-on-placeholder') {
      failOnPlaceholder = true;
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
    throw new Error('Missing plan path. Use --plan <path> or provide it as the first positional arg.');
  }
  return {
    planPath,
    manifestPath,
    format,
    failOnPlaceholder,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:asset-plan — track art assets vs placeholders for a floor/theme plan',
      '',
      'Usage:',
      '  npm run sprites:asset-plan -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      '  npm run sprites:asset-plan -- plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      '',
      'Options:',
      '  --plan <path>             Art plan YAML file.',
      '  --manifest <path>         Override generated manifest path.',
      '                            Default: public/assets/generated/manifest.json',
      '  --format <table|json>     Output mode. Default: table',
      '  --fail-on-placeholder     Exit non-zero if unresolved placeholders remain.',
      '  --help, -h                Show this help.',
      '',
    ].join('\n'),
  );
}

function renderTable(report: AssetPlanReport): string {
  const headers = ['asset', 'type', 'status', 'brief', 'approved', 'integration', 'placeholder'];
  const rows = report.assets.map((asset) => [
    asset.id,
    asset.type,
    asset.status,
    asset.briefId,
    asset.approvedAssetExists ? 'yes' : asset.approved ? 'manifest-only' : 'no',
    asset.integration ? `${asset.integration.kind}:${asset.integration.id}` : 'n/a',
    asset.placeholderInUse ? 'yes' : 'no',
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const toLine = (values: readonly string[]): string =>
    values.map((value, index) => value.padEnd(widths[index]!)).join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');

  const lines = [
    `${report.title} (${report.planId})`,
    report.summary,
    '',
    toLine(headers),
    separator,
    ...rows.map(toLine),
    '',
    'status totals:',
    ...STATUS_ORDER.map((status) => `  - ${status}: ${report.counts[status]}`),
    `unresolved placeholders: ${report.unresolvedPlaceholders}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  let args: AssetPlanCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  const repoRoot = process.cwd();
  const absolutePlanPath = path.resolve(repoRoot, args.planPath);
  const absoluteManifestPath = path.resolve(repoRoot, args.manifestPath);
  const plan = loadAssetPlan(absolutePlanPath);
  const briefIndex = collectCommittedBriefs(repoRoot);
  const approvedSprites = loadApprovedSprites(repoRoot, absoluteManifestPath);
  const report = buildAssetPlanReport(plan, { briefIndex, approvedSprites });

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(report));
  }

  if (args.failOnPlaceholder && report.unresolvedPlaceholders > 0) {
    process.stderr.write(
      `asset-plan check failed: ${report.unresolvedPlaceholders} unresolved placeholder(s).\n`,
    );
    return 1;
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
