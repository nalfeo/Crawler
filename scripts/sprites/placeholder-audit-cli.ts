#!/usr/bin/env node
/**
 * sprites:placeholder-audit — after new art lands, find placeholders that a
 * real generated asset could now replace.
 *
 * Wraps the pure `buildPlaceholderAudit` with file + git IO: it loads the
 * generated manifest, the engine sprite registry, and the mob defs, optionally
 * scopes to assets added since a git ref (`--since`), and prints a report.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseGeneratedManifest } from '../../src/shared/generated-assets.js';
import { SPRITES } from '../../src/engine/sprites/index.js';
import { MOB_DEFS } from '../../src/shared/mobDefs.js';
import {
  buildPlaceholderAudit,
  type PlaceholderAuditReport,
  type PlaceholderRef,
  type RealAssetRef,
} from './placeholder-audit.js';

interface PlaceholderAuditCliArgs {
  readonly manifestPath: string;
  readonly since: string | undefined;
  readonly format: 'table' | 'json';
  readonly showAll: boolean;
  readonly failOnReplaceable: boolean;
}

const DEFAULT_MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');
const GENERATED_ASSET_DIR = 'public/assets/generated';
const PUBLIC_ASSET_PREFIX = 'public/assets/';

export function parseArgs(argv: ReadonlyArray<string>): PlaceholderAuditCliArgs {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let since: string | undefined;
  let format: PlaceholderAuditCliArgs['format'] = 'table';
  let showAll = false;
  let failOnReplaceable = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (!value) throw new Error('--manifest requires a file path');
      manifestPath = value;
      i += 1;
    } else if (arg === '--since') {
      const value = argv[i + 1];
      if (!value) throw new Error('--since requires a git ref');
      since = value;
      i += 1;
    } else if (arg === '--format') {
      const value = argv[i + 1];
      if (value !== 'table' && value !== 'json') {
        throw new Error(`--format must be "table" or "json", got "${value ?? ''}"`);
      }
      format = value;
      i += 1;
    } else if (arg === '--all') {
      showAll = true;
    } else if (arg === '--fail-on-replaceable') {
      failOnReplaceable = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
  }

  return { manifestPath, since, format, showAll, failOnReplaceable };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:placeholder-audit — find placeholders a real asset can now replace',
      '',
      'Usage:',
      '  npm run sprites:placeholder-audit',
      '  npm run sprites:placeholder-audit -- --since main',
      '  npm run sprites:placeholder-audit -- --since HEAD~1 --format json',
      '',
      'Options:',
      '  --since <git-ref>         Scope to real assets added since <ref> (e.g. main,',
      '                            HEAD~1). Flags those assets as "new" and narrows',
      '                            the replaceable/new-content sections to them.',
      '  --manifest <path>         Override generated manifest path.',
      `                            Default: ${DEFAULT_MANIFEST_PATH}`,
      '  --format <table|json>     Output mode. Default: table.',
      '  --all                     In table mode, also list every still-on-placeholder',
      '                            concept (otherwise just a count).',
      '  --fail-on-replaceable     Exit non-zero if any replaceable placeholder is found',
      '                            (when --since is set, only newly-replaceable ones).',
      '  --help, -h                Show this help.',
      '',
    ].join('\n'),
  );
}

/**
 * Resolve the set of `public/assets/`-relative asset paths added/modified since
 * a git ref, so real manifest assets touching them can be flagged "new".
 */
function collectNewAssetPaths(repoRoot: string, since: string): Set<string> {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=AMR', since, '--', GENERATED_ASSET_DIR],
      { cwd: repoRoot, encoding: 'utf8' },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git diff failed for --since "${since}": ${message}`, { cause: err });
  }
  const out = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim().replace(/\\/g, '/');
    if (!line) continue;
    out.add(line.startsWith(PUBLIC_ASSET_PREFIX) ? line.slice(PUBLIC_ASSET_PREFIX.length) : line);
  }
  return out;
}

function describePlaceholders(refs: readonly PlaceholderRef[]): string {
  if (refs.length === 0) return '(none)';
  return refs.map((ref) => `${ref.kind}:${ref.id}`).join(', ');
}

function describeRealAssets(refs: readonly RealAssetRef[]): string {
  if (refs.length === 0) return '(none)';
  return refs.map((ref) => (ref.isNew ? `${ref.spriteName}*` : ref.spriteName)).join(', ');
}

function renderTable(report: PlaceholderAuditReport, args: PlaceholderAuditCliArgs): string {
  const lines: string[] = [];
  const scope = report.scopedToNew ? ` (scoped to assets added since ${args.since})` : '';
  lines.push(`Placeholder-replacement audit${scope}`);
  lines.push('='.repeat(`Placeholder-replacement audit${scope}`.length));
  lines.push('');

  lines.push('Replaceable now — a current placeholder has real art available:');
  if (report.replaceable.length === 0) {
    lines.push('  (none)');
  } else {
    for (const audit of report.replaceable) {
      lines.push(`  ${audit.concept}`);
      lines.push(`    placeholder: ${describePlaceholders(audit.placeholders)}`);
      lines.push(`    real:        ${describeRealAssets(audit.realAssets)}`);
    }
  }
  lines.push('');

  const realHeading = report.scopedToNew
    ? 'New real assets (no matching placeholder — new content):'
    : 'Real assets without a matching placeholder (new content):';
  lines.push(realHeading);
  if (report.newContent.length === 0) {
    lines.push('  (none)');
  } else {
    for (const audit of report.newContent) {
      lines.push(`  ${audit.concept.padEnd(28)} ${describeRealAssets(audit.realAssets)}`);
    }
  }
  lines.push('');

  lines.push('Related name suggestions (heuristic — verify before wiring):');
  if (report.relatedSuggestions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const suggestion of report.relatedSuggestions) {
      lines.push(
        `  ${suggestion.placeholderConcept} ~> ${suggestion.realConcept}` +
          `  [placeholder: ${describePlaceholders(suggestion.placeholders)}]` +
          `  [real: ${describeRealAssets(suggestion.realAssets)}]`,
      );
    }
  }
  lines.push('');

  if (args.showAll) {
    lines.push('Still on placeholder (no real art yet):');
    if (report.placeholderOnly.length === 0) {
      lines.push('  (none)');
    } else {
      for (const audit of report.placeholderOnly) {
        lines.push(`  ${audit.concept.padEnd(28)} ${describePlaceholders(audit.placeholders)}`);
      }
    }
  } else {
    lines.push(
      `Still on placeholder (no real art yet): ${report.placeholderOnly.length} concept(s).` +
        ' Use --all (or --format json) for the full list.',
    );
  }
  lines.push('');

  const { counts } = report;
  lines.push(
    'Totals: ' +
      `concepts=${counts.concepts} replaceable=${counts.replaceable} ` +
      `new-real-assets=${counts.newRealAssets} placeholder-only=${counts.placeholderOnly} ` +
      `related=${counts.relatedSuggestions}`,
  );
  if (report.scopedToNew) {
    lines.push(`(* marks an asset added since ${args.since}.)`);
  }
  return `${lines.join('\n')}\n`;
}

interface PlaceholderAuditOptions {
  readonly spriteRegistry?: readonly { readonly id: string; readonly note?: string }[];
  readonly mobDefs?: readonly { readonly id: string; readonly spriteId: string }[];
}

export function runPlaceholderAudit(
  repoRoot: string,
  args: PlaceholderAuditCliArgs,
  options: PlaceholderAuditOptions = {},
): PlaceholderAuditReport {
  const absoluteManifestPath = path.resolve(repoRoot, args.manifestPath);
  const manifestEntries = existsSync(absoluteManifestPath)
    ? parseGeneratedManifest(JSON.parse(readFileSync(absoluteManifestPath, 'utf8'))).entries
    : {};
  const newAssetPaths =
    args.since === undefined ? undefined : collectNewAssetPaths(repoRoot, args.since);
  const spriteRegistry =
    options.spriteRegistry ?? SPRITES.map((sprite) => ({ id: sprite.id, note: sprite.note }));
  const mobDefs =
    options.mobDefs ??
    Array.from(MOB_DEFS.values(), (mob) => ({ id: mob.id, spriteId: mob.spriteId }));
  return buildPlaceholderAudit({ manifestEntries, spriteRegistry, mobDefs, newAssetPaths });
}

function isReplaceableFailure(report: PlaceholderAuditReport): boolean {
  return report.scopedToNew ? report.counts.newReplaceable > 0 : report.counts.replaceable > 0;
}

async function main(): Promise<number> {
  let args: PlaceholderAuditCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  let report: PlaceholderAuditReport;
  try {
    report = runPlaceholderAudit(process.cwd(), args);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(report, args));
  }

  if (args.failOnReplaceable && isReplaceableFailure(report)) {
    process.stderr.write(
      `placeholder-audit: ${report.counts.replaceable} replaceable placeholder(s) found.\n`,
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
