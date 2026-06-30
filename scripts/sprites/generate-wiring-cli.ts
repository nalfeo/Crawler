#!/usr/bin/env node
/**
 * CLI for generate-wiring: After new art is checked in, generate code patches
 * to wire up the new generated assets and retire placeholders.
 *
 * This runs the placeholder audit on new assets and generates wiring patches
 * that can be reviewed or applied to the codebase.
 *
 * Usage:
 *   npm run sprites:generate-wiring -- --since main
 */

import path from 'node:path';
import process from 'node:process';
import { generateWiringPlan } from './generate-wiring.js';
import { runPlaceholderAudit } from './placeholder-audit-cli.js';
import type { PlaceholderAuditCliArgs } from './placeholder-audit-cli.js';

interface GenerateWiringArgs {
  readonly since: string | undefined;
  readonly manifestPath: string;
  readonly outputFormat: 'summary' | 'patches' | 'json';
}

function parseArgs(argv: ReadonlyArray<string>): GenerateWiringArgs {
  let since: string | undefined;
  let manifestPath = path.join('public', 'assets', 'generated', 'manifest.json');
  let outputFormat: GenerateWiringArgs['outputFormat'] = 'summary';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') {
      const value = argv[i + 1];
      if (!value) throw new Error('--since requires a git ref');
      since = value;
      i += 1;
    } else if (arg === '--manifest') {
      const value = argv[i + 1];
      if (!value) throw new Error('--manifest requires a file path');
      manifestPath = value;
      i += 1;
    } else if (arg === '--output') {
      const value = argv[i + 1];
      if (value !== 'summary' && value !== 'patches' && value !== 'json') {
        throw new Error(`--output must be "summary", "patches", or "json", got "${value ?? ''}"`);
      }
      outputFormat = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
  }

  return { since, manifestPath, outputFormat };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:generate-wiring — generate code patches to wire up new generated art',
      '',
      'Usage:',
      '  npm run sprites:generate-wiring',
      '  npm run sprites:generate-wiring -- --since main',
      '  npm run sprites:generate-wiring -- --since main --output patches',
      '',
      'Options:',
      '  --since <git-ref>         Scope to real assets added since <ref>.',
      '                            Default: all replaceable placeholders.',
      '  --manifest <path>         Override generated manifest path.',
      '  --output <format>         Output format: summary (default), patches, or json.',
      '  --help, -h                Show this help.',
      '',
    ].join('\n'),
  );
}

async function main(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  let args: GenerateWiringArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  try {
    const auditArgs: PlaceholderAuditCliArgs = {
      manifestPath: args.manifestPath,
      since: args.since,
      format: 'json',
      showAll: false,
      failOnReplaceable: false,
    };
    const report = runPlaceholderAudit(cwd, auditArgs);
    const plan = generateWiringPlan(report);

    if (args.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else if (args.outputFormat === 'patches') {
      for (const patch of plan.patches) {
        process.stdout.write(`\n${'='.repeat(80)}\n`);
        process.stdout.write(`File: ${patch.filePath}\n`);
        process.stdout.write(`Description: ${patch.description}\n`);
        process.stdout.write(`${'='.repeat(80)}\n`);
        process.stdout.write('OLD:\n');
        process.stdout.write(patch.oldText);
        process.stdout.write('\n\nNEW:\n');
        process.stdout.write(patch.newText);
        process.stdout.write('\n');
      }
    } else {
      process.stdout.write(plan.summary);
      if (plan.patches.length > 0) {
        process.stdout.write(`\nTo view detailed patches, use: --output patches\n`);
      }
    }

    if (plan.replaceableCount === 0) {
      process.stdout.write('\nNo replaceable placeholders found.\n');
    }

    return 0;
  } catch (err) {
    process.stderr.write(
      `generate-wiring failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // For ESM, use import.meta.url
    const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    return path.resolve(entry) === path.resolve(thisFile);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main(process.argv.slice(2), process.cwd()).then((code) => {
    process.exit(code);
  });
}
