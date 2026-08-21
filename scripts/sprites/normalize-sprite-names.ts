/**
 * Repo-wide generated-sprite name normalization (supersedes ADR 0051's
 * item-only migration).
 *
 * Rewrites every generated asset on disk so its manifest key, `briefId`,
 * `spriteName` and PNG filename are the **bare concept** plus a `-var-<N>`
 * suffix, retiring generation-time `-vN` lineage tags. Where a concept was
 * fragmented across several lineages, all approved variants are merged into one
 * bucket and colliding indices are renumbered deterministically.
 *
 * Why on disk and not just at the resolver: `loadGeneratedManifest` groups
 * variants by `briefId`, so a fragmented concept yields two buckets and
 * `pickGeneratedVariant` can only ever draw from one — approved art that can
 * never render. Fixing the names at rest, plus the approve-time guard, is what
 * makes the fragmentation unrepresentable rather than repaired once.
 *
 * All entry fields other than the four identity fields — `sourceRun`,
 * `contentHash`, anchors, scores, timestamps, `type`, `opaqueBounds` — are
 * preserved verbatim. Placeholder entries whose concept has real bare-keyed art
 * are retired, matching the ADR 0051 contract.
 *
 * Idempotent: a second run is a no-op. `--check` exits non-zero iff a migration
 * is still pending, so the same code powers the CI guard.
 *
 * Usage:
 *   tsx scripts/sprites/normalize-sprite-names.ts [--dry-run|--apply|--check]
 *                                                 [--generated-dir <path>]
 *   npm run sprites:normalize-names -- --dry-run
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatJsonFiles } from './catalog-io.js';
import { deleteShard, readAllShards, writeShard } from './generated-shards.js';
import {
  buildTaxonomyPlan,
  hasLineageTag,
  isPlaceholder,
  type SpriteRename,
  type TaxonomyPlan,
} from './sprite-name-taxonomy.js';

export type Mode = 'dry-run' | 'apply' | 'check';

export interface NormalizeOptions {
  readonly generatedDir: string;
  readonly mode: Mode;
}

export interface NormalizeResult {
  readonly plan: TaxonomyPlan;
  /** Manifest keys of placeholder entries retired by this run. */
  readonly retiredPlaceholders: readonly string[];
  /**
   * Entries whose `briefId` still carries a generation-lineage tag, found by an
   * INDEPENDENT sweep rather than by the rename planner.
   *
   * The planner only emits a rename for a key it can parse as `<concept>-var-N`,
   * so a lone non-variant entry (`player-walk-v2`, or an icon-batch entry whose
   * briefId is the batch id) produces no rename and would otherwise sail through
   * `--check` while violating the very invariant the guard exists to enforce.
   */
  readonly lineageViolations: readonly string[];
  /** True when the tree is already canonical (nothing to do). */
  readonly clean: boolean;
}

/**
 * Independent invariant sweep: every entry's `briefId` must be a bare concept.
 *
 * Deliberately does NOT go through the rename planner — this is the check that
 * catches what the planner structurally cannot see.
 */
export function findLineageViolations(entries: Record<string, { briefId?: string }>): string[] {
  const violations: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const briefId = entry?.briefId;
    if (typeof briefId === 'string' && hasLineageTag(briefId)) {
      violations.push(`${key} (briefId: ${briefId})`);
    }
  }
  return violations.sort();
}

/** Resolve the absolute PNG path for an entry `assetPath` (`generated/x.png`). */
function assetAbsPath(generatedDir: string, assetPath: string): string {
  return path.join(generatedDir, path.basename(assetPath));
}

/**
 * Placeholders to retire: a placeholder entry is redundant once its concept has
 * at least one real bare-keyed variant. Retiring it is what stops the resolver
 * from ever preferring placeholder art over the real thing.
 */
export function planPlaceholderRetirements(
  entries: Readonly<Record<string, { briefId: string; sourceRun?: string; assetPath?: string }>>,
  plan: TaxonomyPlan,
): string[] {
  const conceptsWithRealArt = new Set<string>();
  for (const rename of plan.renames) {
    conceptsWithRealArt.add(rename.toBriefId);
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (!isPlaceholder(entry) && !key.endsWith('-placeholder')) {
      conceptsWithRealArt.add(entry.briefId);
    }
  }
  const retired: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!isPlaceholder(entry)) continue;
    const concept = entry.briefId.replace(/-placeholder$/, '');
    if (conceptsWithRealArt.has(concept)) {
      retired.push(key);
    }
  }
  return retired.sort((a, b) => a.localeCompare(b));
}

/**
 * Apply the rename set in TWO PHASES via temporary keys.
 *
 * A single-pass rename is unsafe here because merging lineages creates rename
 * *cycles and chains*: `rat-v1-var-9` targets `rat-var-9`, which is itself
 * still occupied by an entry that has not moved to `rat-var-0` yet. Renaming
 * sequentially would clobber the occupant and silently destroy approved art
 * (observed: `rat` lost a variant, 5 concepts affected). Staging every entry
 * under a unique temporary key first makes the operation order-independent.
 */
function applyRenames(
  generatedDir: string,
  renames: readonly SpriteRename[],
  entries: Record<string, Record<string, unknown>>,
  written: string[],
): void {
  interface Staged {
    readonly rename: SpriteRename;
    readonly tempKey: string;
    readonly entry: Record<string, unknown>;
  }
  const staged: Staged[] = [];

  // Phase 1 — move every renamed entry (shard + PNG) aside to a unique temp key.
  for (const rename of renames) {
    const entry = entries[rename.fromKey];
    if (entry === undefined) continue;
    const tempKey = `__migrating__/${rename.toKey}`;
    const oldAssetPath = typeof entry.assetPath === 'string' ? entry.assetPath : '';
    const fromPng = assetAbsPath(generatedDir, oldAssetPath);
    const tempPng = path.join(generatedDir, `__migrating__${rename.toKey}.png`);
    if (oldAssetPath !== '' && existsSync(fromPng)) {
      renameSync(fromPng, tempPng);
    }
    writeShard(generatedDir, tempKey, entry as never);
    deleteShard(generatedDir, rename.fromKey);
    delete entries[rename.fromKey];
    staged.push({ rename, tempKey, entry });
  }

  // Phase 2 — land each staged entry on its final key with rewritten identity.
  for (const { rename, tempKey, entry } of staged) {
    const newAssetPath = `generated/${rename.toKey}.png`;
    const migrated: Record<string, unknown> = {
      ...entry,
      briefId: rename.toBriefId,
      spriteName: rename.toKey,
      assetPath: newAssetPath,
      variantIndex: rename.toVariantIndex,
    };
    const tempPng = path.join(generatedDir, `__migrating__${rename.toKey}.png`);
    const toPng = assetAbsPath(generatedDir, newAssetPath);
    if (existsSync(tempPng)) {
      if (existsSync(toPng)) rmSync(toPng);
      renameSync(tempPng, toPng);
    }
    written.push(writeShard(generatedDir, rename.toKey, migrated as never));
    deleteShard(generatedDir, tempKey);
    entries[rename.toKey] = migrated;
  }
}

/** Run the migration (or just plan it, depending on `mode`). */
export async function normalizeSpriteNames(options: NormalizeOptions): Promise<NormalizeResult> {
  const entries = readAllShards(options.generatedDir) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const plan = buildTaxonomyPlan(entries as never);
  const retiredPlaceholders = planPlaceholderRetirements(entries as never, plan);
  const lineageViolations = findLineageViolations(entries as never);
  const clean =
    plan.renames.length === 0 && retiredPlaceholders.length === 0 && lineageViolations.length === 0;

  if (options.mode !== 'apply') {
    return { plan, retiredPlaceholders, lineageViolations, clean };
  }

  if (plan.conflicts.length > 0) {
    throw new Error(
      `Refusing to apply: ${plan.conflicts.length} unresolved taxonomy conflict(s).\n` +
        plan.conflicts.map((c) => `  ${c.concept}: ${c.reason} (${c.keys.join(', ')})`).join('\n'),
    );
  }

  const written: string[] = [];

  // Renames first so placeholder retirement sees the post-merge concept set.
  applyRenames(options.generatedDir, plan.renames, entries, written);

  for (const key of retiredPlaceholders) {
    const entry = entries[key];
    const assetPath = typeof entry?.assetPath === 'string' ? entry.assetPath : '';
    const png = assetAbsPath(options.generatedDir, assetPath);
    if (assetPath !== '' && existsSync(png)) {
      rmSync(png);
    }
    deleteShard(options.generatedDir, key);
    delete entries[key];
  }

  if (written.length > 0) {
    await formatJsonFiles(written);
  }

  return { plan, retiredPlaceholders, lineageViolations, clean };
}

function parseMode(argv: readonly string[]): Mode {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--check')) return 'check';
  return 'dry-run';
}

function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const mode = parseMode(argv);
  const generatedDir = parseFlagValue(argv, '--generated-dir') ?? 'public/assets/generated';

  const result = await normalizeSpriteNames({ generatedDir, mode });
  const { plan, retiredPlaceholders, lineageViolations } = result;

  console.log(`mode: ${mode}`);
  console.log(`renames: ${plan.renames.length}`);
  console.log(`  renumbered: ${plan.renames.filter((r) => r.renumbered).length}`);
  console.log(`merged concepts: ${plan.mergedConcepts.length}`);
  console.log(`retired placeholders: ${retiredPlaceholders.length}`);
  console.log(`lineage violations: ${lineageViolations.length}`);
  console.log(`conflicts: ${plan.conflicts.length}`);

  for (const violation of lineageViolations) {
    console.error(`  LINEAGE TAG ${violation}`);
  }

  for (const conflict of plan.conflicts) {
    console.error(
      `  CONFLICT ${conflict.concept}: ${conflict.reason} (${conflict.keys.join(', ')})`,
    );
  }

  if (mode === 'dry-run') {
    for (const rename of plan.renames) {
      console.log(
        `  ${rename.fromKey} -> ${rename.toKey}${rename.renumbered ? ' (renumbered)' : ''}`,
      );
    }
  }

  if (plan.conflicts.length > 0) return 1;

  if (mode === 'check' && !result.clean) {
    console.error(
      'Generated sprite names are not canonical. Run `npm run sprites:normalize-names -- --apply`.',
    );
    return 1;
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
