#!/usr/bin/env node
/**
 * sprites:backfill-manifest-types — fill the `type` field on every generated
 * manifest entry so the reference selector can favour same-type examples.
 *
 * Wraps the pure {@link backfillManifestTypes} with filesystem IO: it builds
 * the resolution sources from `src/shared/data/sprite-catalog.json`, on-disk
 * brief YAML, and the checked-in `manifest-type-overrides.json`, resolves every
 * entry, and rewrites the manifest in canonical key order.
 *
 * Coverage preflight: EVERY real (non-placeholder) entry MUST resolve to a
 * `SpriteType`. If any real entry is unresolved the command prints them and
 * exits non-zero WITHOUT writing — add the missing concept to the override map
 * and re-run. Placeholders may be left `type: null` (they are never selected as
 * references). `--check` additionally fails on any drift (a would-be rewrite),
 * so CI can guard against manifests that need re-backfilling.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import {
  GENERATED_MANIFEST_VERSION,
  parseGeneratedManifest,
} from '../../src/shared/generated-assets.js';
import { isSpriteType, type SpriteType } from '../../src/shared/sprite-types.js';
import { normalizeConcept } from './placeholder-audit.js';
import {
  backfillManifestTypes,
  type BackfillManifestResult,
  type TypeResolutionSources,
} from './backfill-manifest-types.js';

const DEFAULT_MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');
const CATALOG_PATH = path.join('src', 'shared', 'data', 'sprite-catalog.json');
const OVERRIDES_PATH = path.join('scripts', 'sprites', 'manifest-type-overrides.json');
const BRIEFS_DIR = 'briefs';

interface BackfillCliArgs {
  readonly manifestPath: string;
  /** Verify-only: do not write; fail on unresolved real entries OR any drift. */
  readonly check: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): BackfillCliArgs {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (!value) throw new Error('--manifest requires a file path');
      manifestPath = value;
      i += 1;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
  }
  return { manifestPath, check };
}

function printHelp(): void {
  process.stdout.write(
    [
      'sprites:backfill-manifest-types — resolve + write the manifest `type` field',
      '',
      'Usage:',
      '  npm run sprites:backfill-manifest-types',
      '  npm run sprites:backfill-manifest-types -- --check',
      '',
      'Options:',
      '  --manifest <path>   Override generated manifest path.',
      `                      Default: ${DEFAULT_MANIFEST_PATH}`,
      '  --check             Verify only: never write. Exits non-zero if any real',
      '                      entry is unresolved OR the manifest would change.',
      '  --help, -h          Show this help.',
      '',
    ].join('\n'),
  );
}

/**
 * Build catalog-backed lookups: exact sprite-name -> first-tag type, and
 * concept -> set of types seen (used only when unambiguous).
 */
function buildCatalogSources(repoRoot: string): {
  readonly catalogTypeBySpriteName: Record<string, SpriteType>;
  readonly catalogTypesByConcept: Record<string, SpriteType[]>;
} {
  const catalogTypeBySpriteName: Record<string, SpriteType> = {};
  const conceptTypes = new Map<string, Set<SpriteType>>();
  const absolute = path.resolve(repoRoot, CATALOG_PATH);
  if (!existsSync(absolute)) {
    return { catalogTypeBySpriteName, catalogTypesByConcept: {} };
  }
  const raw = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  const entries = Array.isArray(raw) ? raw : [];
  for (const record of entries) {
    if (!record || typeof record !== 'object') continue;
    const entry = record as { spriteId?: unknown; tags?: unknown };
    if (typeof entry.spriteId !== 'string' || !Array.isArray(entry.tags)) continue;
    const firstTag = entry.tags[0];
    if (typeof firstTag !== 'string' || !isSpriteType(firstTag)) continue;
    catalogTypeBySpriteName[entry.spriteId] = firstTag;
    const concept = normalizeConcept(entry.spriteId);
    const set = conceptTypes.get(concept) ?? new Set<SpriteType>();
    set.add(firstTag);
    conceptTypes.set(concept, set);
  }
  const catalogTypesByConcept: Record<string, SpriteType[]> = {};
  for (const [concept, set] of conceptTypes) {
    catalogTypesByConcept[concept] = Array.from(set).sort();
  }
  return { catalogTypeBySpriteName, catalogTypesByConcept };
}

/** Recursively collect `*.yaml` brief paths under `briefs/`. */
function collectBriefPaths(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...collectBriefPaths(full));
    } else if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Build brief-YAML lookups keyed by both exact brief `name` and its normalized
 * concept. Only the top-level `type:` + `name:` are read (no palette/defaults
 * resolution needed). Malformed briefs are skipped.
 */
function buildBriefSources(repoRoot: string): Record<string, SpriteType> {
  const byKey: Record<string, SpriteType> = {};
  const briefsRoot = path.resolve(repoRoot, BRIEFS_DIR);
  for (const briefPath of collectBriefPaths(briefsRoot)) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(briefPath, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const brief = parsed as { type?: unknown; name?: unknown };
    if (typeof brief.type !== 'string' || !isSpriteType(brief.type)) continue;
    if (typeof brief.name !== 'string' || brief.name.trim() === '') continue;
    byKey[brief.name] = brief.type;
    const concept = normalizeConcept(brief.name);
    byKey[concept] ??= brief.type;
  }
  return byKey;
}

/** Read + validate the checked-in override map (`overrides` object). */
function buildOverrideSources(repoRoot: string): Record<string, SpriteType> {
  const absolute = path.resolve(repoRoot, OVERRIDES_PATH);
  if (!existsSync(absolute)) return {};
  const raw = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  const container = (raw && typeof raw === 'object' ? raw : {}) as { overrides?: unknown };
  const overrides = container.overrides;
  if (!overrides || typeof overrides !== 'object') return {};
  const out: Record<string, SpriteType> = {};
  for (const [concept, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value !== 'string' || !isSpriteType(value)) {
      throw new Error(
        `manifest-type-overrides.json: override "${concept}" has invalid type "${String(value)}"`,
      );
    }
    out[concept] = value;
  }
  return out;
}

export function buildResolutionSources(repoRoot: string): TypeResolutionSources {
  const catalog = buildCatalogSources(repoRoot);
  return {
    catalogTypeBySpriteName: catalog.catalogTypeBySpriteName,
    catalogTypesByConcept: catalog.catalogTypesByConcept,
    briefTypeByKey: buildBriefSources(repoRoot),
    overridesByConcept: buildOverrideSources(repoRoot),
  };
}

function summarize(result: BackfillManifestResult): string {
  const s = result.bySource;
  return (
    `resolved by: existing=${s.existing} catalog-sprite=${s['catalog-sprite']} ` +
    `catalog-concept=${s['catalog-concept']} brief-yaml=${s['brief-yaml']} ` +
    `override=${s.override} heuristic=${s.heuristic} unresolved=${s.unresolved}`
  );
}

interface BackfillRunResult {
  readonly code: number;
  readonly result: BackfillManifestResult;
  readonly nextContent: string;
  readonly currentContent: string;
  readonly wouldChange: boolean;
}

export function runBackfill(repoRoot: string, args: BackfillCliArgs): BackfillRunResult {
  const absolute = path.resolve(repoRoot, args.manifestPath);
  const currentContent = readFileSync(absolute, 'utf8');
  const manifest = parseGeneratedManifest(JSON.parse(currentContent));
  const sources = buildResolutionSources(repoRoot);
  const result = backfillManifestTypes(manifest.entries, sources);
  const nextContent = `${JSON.stringify(
    { version: GENERATED_MANIFEST_VERSION, entries: result.entries },
    null,
    2,
  )}\n`;
  const wouldChange = nextContent !== currentContent;

  process.stdout.write(`${summarize(result)}\n`);

  if (result.unresolvedReal.length > 0) {
    process.stderr.write(
      `\nUNRESOLVED real entries (${result.unresolvedReal.length}) — add each concept to ` +
        `${OVERRIDES_PATH} and re-run:\n` +
        result.unresolvedReal.map((key) => `  - ${key}`).join('\n') +
        '\n',
    );
    return { code: 1, result, nextContent, currentContent, wouldChange };
  }

  if (result.unresolvedPlaceholder.length > 0) {
    process.stdout.write(
      `note: ${result.unresolvedPlaceholder.length} placeholder entr(y|ies) left type:null ` +
        '(never used as references).\n',
    );
  }

  if (args.check) {
    if (wouldChange) {
      process.stderr.write(
        `\nmanifest is stale — run \`npm run sprites:backfill-manifest-types\` and commit.\n`,
      );
      return { code: 1, result, nextContent, currentContent, wouldChange };
    }
    process.stdout.write('manifest types are up to date.\n');
    return { code: 0, result, nextContent, currentContent, wouldChange };
  }

  if (wouldChange) {
    writeFileSync(absolute, nextContent);
    process.stdout.write(
      `wrote ${args.manifestPath} (${result.changedCount} entr(y|ies) updated).\n`,
    );
  } else {
    process.stdout.write('no changes — manifest already up to date.\n');
  }
  return { code: 0, result, nextContent, currentContent, wouldChange };
}

async function main(): Promise<number> {
  let args: BackfillCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }
  try {
    return runBackfill(process.cwd(), args).code;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
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
