#!/usr/bin/env node
/**
 * sprites:synth CLI — turns a subject name into N reviewable
 * minimal-brief YAML candidates the human then picks from.
 *
 * Usage:
 *   npm run sprites:synth -- <name>
 *   npm run sprites:synth -- <name> --type weapon
 *   npm run sprites:synth -- <name> --type weapon --candidates 3
 *   npm run sprites:synth -- <name> --allow-partial
 *
 * The CLI is intentionally tiny: argv parsing, env wiring, and a
 * human-readable summary table. All the real work lives in
 * `synthesize-brief.ts` so unit tests can exercise the orchestrator
 * without going through stdin/argv.
 */

import path from 'node:path';
import process from 'node:process';

import { briefDirectoryForType } from './brief-paths.js';
import { createSynthProvider } from './provider/factory.js';
import { SIZE_VARIANTS, type SizeVariant } from './size-variants.js';
import {
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  SPRITE_TYPES,
  SynthesizeBriefError,
  synthesizeBrief,
  type SpriteType,
} from './synthesize-brief.js';

interface SynthCliArgs {
  readonly name: string;
  readonly type: SpriteType | undefined;
  readonly candidates: number;
  readonly allowPartial: boolean;
  readonly size: SizeVariant;
  readonly floor: number;
}

export function parseArgs(argv: ReadonlyArray<string>): SynthCliArgs {
  let name: string | undefined;
  let type: SpriteType | undefined;
  let candidates = 3;
  let allowPartial = false;
  let size: SizeVariant = 'default';
  let floor = 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--type') {
      const v = argv[++i];
      if (!v) throw new Error('--type requires a value');
      if (!(SPRITE_TYPES as ReadonlyArray<string>).includes(v)) {
        throw new Error(`--type '${v}' is not one of ${SPRITE_TYPES.join('|')}`);
      }
      type = v as SpriteType;
    } else if (arg === '--size') {
      const v = argv[++i];
      if (!v) throw new Error('--size requires a value');
      if (!(SIZE_VARIANTS as ReadonlyArray<string>).includes(v)) {
        throw new Error(`--size '${v}' is not one of ${SIZE_VARIANTS.join('|')}`);
      }
      size = v as SizeVariant;
    } else if (arg === '--candidates') {
      const v = argv[++i];
      if (!v) throw new Error('--candidates requires a value');
      const n = Number(v);
      if (!Number.isInteger(n) || n < MIN_CANDIDATES || n > MAX_CANDIDATES) {
        throw new Error(
          `--candidates must be an integer in [${MIN_CANDIDATES}, ${MAX_CANDIDATES}], got '${v}'`,
        );
      }
      candidates = n;
    } else if (arg === '--floor') {
      const v = argv[++i];
      if (!v) throw new Error('--floor requires a value');
      floor = Number(v);
      if (!Number.isInteger(floor) || floor < 1 || floor > 20) {
        throw new Error(`--floor must be an integer in [1, 20], got '${v}'`);
      }
    } else if (arg === '--allow-partial') {
      allowPartial = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (arg) {
      if (name !== undefined) {
        throw new Error(`Unexpected positional argument '${arg}' (name already set to '${name}').`);
      }
      name = arg;
    }
  }
  if (!name) {
    throw new Error(
      'Missing subject name. Usage: sprites:synth <name> [--type ...] [--candidates N]',
    );
  }
  return { name, type, candidates, allowPartial, size, floor };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:synth — synthesise brief candidates from a subject name',
      '',
      'Usage:',
      '  npm run sprites:synth -- <name>',
      '  npm run sprites:synth -- <name> --type weapon',
      '  npm run sprites:synth -- <name> --type weapon --candidates 3',
      '  npm run sprites:synth -- <name> --type enemy --size wide',
      '',
      'Options:',
      `  <name>             Subject name (kebab-cased automatically).`,
      `  --type <type>      One of ${SPRITE_TYPES.join('|')}. Required unless the model is >=0.9 confident.`,
      `  --size <variant>   One of ${SIZE_VARIANTS.join('|')}. Scales the per-type size (wide=2x w, tall=2x h, large=2x both). Default default.`,
      `  --candidates <N>   Number of candidates to generate (${MIN_CANDIDATES}-${MAX_CANDIDATES}). Default 3.`,
      '  --floor <N>        Dungeon floor intensity (1-20). Default 1.',
      '  --allow-partial    Write the candidates that pass validation instead of aborting when any fail.',
      '  --help, -h         Show this help.',
      '',
      'The synthesizer is LOCAL-ONLY. It refuses to run with env.CI set.',
      'Provider configuration (Azure OpenAI chat):',
      '  AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_CHAT_DEPLOYMENT (all required)',
      '  AZURE_OPENAI_API_VERSION (optional)',
      '',
    ].join('\n'),
  );
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function main(): Promise<number> {
  let args: SynthCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  let provider;
  try {
    provider = createSynthProvider();
  } catch (err) {
    process.stderr.write(
      `failed to construct synth provider: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  try {
    const result = await synthesizeBrief({
      name: args.name,
      ...(args.type ? { type: args.type } : {}),
      candidates: args.candidates,
      partial: args.allowPartial,
      sizeVariant: args.size,
      floor: args.floor,
      provider,
      repoRoot: process.cwd(),
    });

    process.stdout.write(
      `\nSynthesised ${result.written.length} candidate(s) for '${result.name}' (${result.type}).\n`,
    );
    process.stdout.write(`Output dir : ${result.outDir}\n`);
    process.stdout.write(`Sidecar    : ${result.sidecarPath}\n`);
    process.stdout.write(`Provider   : ${result.providerLabel}\n`);
    process.stdout.write(`Prompt hash: ${result.promptHash.slice(0, 12)}…\n\n`);

    process.stdout.write(`  ${pad('id', 24)}description\n`);
    for (const c of result.written) {
      process.stdout.write(`  ${pad(c.id, 24)}${truncate(c.description, 80)}\n`);
    }
    if (result.rejected.length > 0) {
      process.stdout.write('\nRejected candidates:\n');
      for (const r of result.rejected) {
        process.stdout.write(`  - candidate ${r.index}: ${r.reason}\n`);
      }
    }
    process.stdout.write('\nNext steps:\n');
    process.stdout.write(
      `  1. Inspect each <name>-v<N>.yaml under ${path.relative(process.cwd(), result.outDir)}.\n`,
    );
    process.stdout.write(
      `  2. Pick the best candidate and move it to briefs/draft/${briefDirectoryForType(result.type)}/${result.name}.yaml.\n`,
    );
    process.stdout.write(
      `  3. Run \`npm run sprites:run -- --brief briefs/draft/${briefDirectoryForType(result.type)}/${result.name}.yaml\` to validate.\n`,
    );
    process.stdout.write(
      `  4. Once a variant passes sensors, promote to briefs/${briefDirectoryForType(result.type)}/${result.name}.yaml.\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SynthesizeBriefError) {
      process.stderr.write(`\nsynthesizeBrief failed: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(
      `\nsynthesizeBrief failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
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
