/**
 * Item-art disk-name normalization (ADR 0051).
 *
 * Renames an item's *real* generated art on disk so its manifest key, `briefId`,
 * `spriteName`, PNG filename, and `generated:` catalog id all equal the **bare
 * item id** (`iron-ore-var-0`, briefId `iron-ore`) instead of carrying a
 * generation-time `-vN` lineage tag (`iron-ore-v1-var-0`, briefId `iron-ore-v1`).
 * It also retires the now-redundant `<item>-placeholder` manifest entry + PNG.
 *
 * This is a *data* migration that complements the runtime `resolveItemSprite`
 * helper: the resolver already resolves items to real art whether the key is
 * `-vN` or bare, so the game is correct before AND after this runs. The migration
 * just makes the on-disk names clean so future art (and human readers) don't have
 * to reason about lineage tags for items.
 *
 * Contract per concept `c`:
 *   - Real keep-lineage entries `c-v<k>-var-<m>`  ->  `c-var-<m>`
 *     (key + spriteName + assetPath rewritten; briefId `c-v<k>` -> `c`; all other
 *      fields — sourceRun, contentHash, anchors, scores, type, pipeline paths — preserved).
 *   - `c-placeholder`  ->  retired (manifest entry + PNG removed).
 *   - Non-keep real lineages (only for multi-lineage concepts, e.g. baseball-bat
 *     v3 when keeping v1)  ->  retired.
 *   - The matching `generated:<oldKey>` catalog entry is repointed to the new key,
 *     or removed when the key is retired.
 *
 * Idempotent: a second run is a no-op. `--check` exits non-zero iff a migration
 * is still pending (used as a guard / in CI).
 *
 * Usage:
 *   tsx scripts/sprites/normalize-item-art-names.ts [--dry-run|--apply|--check]
 *                                                   [--include-baseball-bat]
 *                                                   [--manifest <path>] [--catalog <path>]
 *                                                   [--assets-dir <path>]
 *   npm run sprites:normalize-item-art -- --dry-run
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatJsonFiles } from './catalog-io.js';
import { composeManifestFromShards, writeShard, deleteShard } from './generated-shards.js';

// ---------------------------------------------------------------------------
// Allowlist — the ONLY concepts this migration is permitted to touch.
// ---------------------------------------------------------------------------

/**
 * A concept to normalize. `keepVersion` is required only for multi-lineage
 * concepts (more than one real `-vN`); the kept lineage is de-versioned and any
 * other real lineage is retired. Single-lineage concepts omit it and the script
 * asserts exactly one real lineage exists.
 */
export interface ItemArtConcept {
  readonly concept: string;
  readonly keepVersion?: number;
}

/** 14 single-real-lineage Floor-1 item concepts (materials / weapons / misc / key). */
export const ITEM_ART_CONCEPTS: readonly ItemArtConcept[] = [
  { concept: 'bone-shard' },
  { concept: 'camera-lens' },
  { concept: 'classified-dossier' },
  { concept: 'copper-ore' },
  { concept: 'crystal-fiber' },
  { concept: 'directors-cue-card' },
  { concept: 'dragon-scale' },
  { concept: 'flame-dagger' },
  { concept: 'glistening-rat-tail' },
  { concept: 'iron-ore' },
  { concept: 'merchants-stained-charm' },
  { concept: 'old-sock' },
  { concept: 'pebble' },
  { concept: 'rusted-scrap' },
];

/**
 * The baseball bat is multi-lineage (v1 hand-pinned real anchor + v3 with a null
 * anchor). Its in-world swing is hardcoded in PhaserBridge and there are bat-keyed
 * test fixtures, so migrating it is an atomic, coordinated follow-up — opt-in only.
 */
export const BASEBALL_BAT_CONCEPT: ItemArtConcept = { concept: 'baseball-bat', keepVersion: 1 };

// ---------------------------------------------------------------------------
// Manifest / catalog shapes (loose — preserve unknown fields verbatim).
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  briefId: string;
  spriteName: string;
  assetPath: string;
  sourceRun: string;
  [key: string]: unknown;
}

export interface GeneratedManifest {
  version: number;
  entries: Record<string, ManifestEntry>;
  [key: string]: unknown;
}

/**
 * A catalog record as it sits on disk (plain JSON). We deliberately do NOT route
 * catalog records through the zod `parseSpriteCatalog` schema for *writing*: zod
 * rebuilds each object with keys in schema order, which differs from the committed
 * file's on-disk key order and would produce wholesale serialization churn. Working
 * on the raw parsed objects — and editing only the fields we migrate — preserves
 * every untouched record byte-for-byte (modulo Prettier reformatting, which the CLI
 * re-applies). Only the fields the migration rewrites are named; the index signature
 * carries everything else through verbatim.
 */
export interface CatalogRecordRaw {
  id: string;
  kind?: string;
  label?: string;
  description?: string;
  spriteId?: string;
  assetPath?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Migration plan (pure, testable).
// ---------------------------------------------------------------------------

export interface RenameOp {
  readonly kind: 'rename';
  readonly concept: string;
  readonly oldKey: string;
  readonly newKey: string;
  readonly oldBriefId: string;
  readonly newBriefId: string;
  readonly oldAssetPath: string;
  readonly newAssetPath: string;
}

export interface RetireOp {
  readonly kind: 'retire';
  readonly concept: string;
  readonly key: string;
  readonly assetPath: string;
  readonly reason: 'placeholder' | 'non-keep-lineage';
  /**
   * Set only on a collision-origin retire (an idempotent re-run where the bare
   * target key already exists and we could NOT prove byte-identity via
   * `contentHash`). Names the surviving bare PNG so the apply step byte-verifies
   * `old === target` before deleting the old versioned PNG. Undefined for genuine
   * multi-lineage / placeholder retires (which intentionally drop different art).
   */
  readonly verifyAgainstPath?: string;
}

export interface MigrationPlan {
  readonly renames: readonly RenameOp[];
  readonly retires: readonly RetireOp[];
  readonly errors: readonly string[];
  /** True when there is nothing left to do (fully migrated / no matching art). */
  readonly clean: boolean;
}

const LINEAGE_RE = /-v(\d+)-var-(\d+)$/;

function isPlaceholderEntry(entry: ManifestEntry): boolean {
  return entry.sourceRun === 'placeholder' || entry.assetPath.endsWith('-placeholder.png');
}

/**
 * Build the migration plan for a single concept against the current manifest.
 * Pure: reads the manifest, returns ops + errors, mutates nothing.
 */
export function planConcept(
  manifest: GeneratedManifest,
  { concept, keepVersion }: ItemArtConcept,
): { renames: RenameOp[]; retires: RetireOp[]; errors: string[] } {
  const renames: RenameOp[] = [];
  const retires: RetireOp[] = [];
  const errors: string[] = [];

  const entries = Object.entries(manifest.entries);
  const lineageMatch = (key: string): { version: number; variant: number } | null => {
    if (!key.startsWith(`${concept}-v`)) return null;
    const m = LINEAGE_RE.exec(key.slice(concept.length));
    return m ? { version: Number(m[1]), variant: Number(m[2]) } : null;
  };

  // Group real (non-placeholder) versioned entries by lineage version.
  const realLineages = new Map<
    number,
    Array<{ key: string; variant: number; entry: ManifestEntry }>
  >();
  const placeholders: Array<{ key: string; entry: ManifestEntry }> = [];
  for (const [key, entry] of entries) {
    if (isPlaceholderEntry(entry)) {
      if (key === `${concept}-placeholder`) placeholders.push({ key, entry });
      continue;
    }
    const lin = lineageMatch(key);
    if (!lin) continue;
    const bucket = realLineages.get(lin.version) ?? [];
    bucket.push({ key, variant: lin.variant, entry });
    realLineages.set(lin.version, bucket);
  }

  const versions = [...realLineages.keys()].sort((a, b) => a - b);

  // Decide which lineage to keep (de-version) and which to retire.
  let keep: number | undefined;
  if (versions.length === 0) {
    keep = undefined; // nothing real to rename (may still be already-migrated / placeholder-only)
  } else if (keepVersion !== undefined) {
    if (!realLineages.has(keepVersion)) {
      errors.push(
        `concept "${concept}": keepVersion v${keepVersion} not found (present: ${versions
          .map((v) => `v${v}`)
          .join(', ')})`,
      );
      return { renames, retires, errors };
    }
    keep = keepVersion;
  } else if (versions.length === 1) {
    keep = versions[0];
  } else {
    errors.push(
      `concept "${concept}": ${versions.length} real lineages (${versions
        .map((v) => `v${v}`)
        .join(', ')}); refusing to guess. Specify keepVersion (multi-lineage concepts are opt-in).`,
    );
    return { renames, retires, errors };
  }

  // Rename the kept lineage's variants to bare keys; retire the rest.
  for (const version of versions) {
    const bucket = realLineages.get(version) ?? [];
    if (version === keep) {
      for (const { key, variant, entry: oldEntry } of bucket) {
        const newKey = `${concept}-var-${variant}`;
        if (newKey === key) continue; // defensive; shouldn't happen for a `-vN-var` key
        const collision = manifest.entries[newKey];
        if (collision) {
          // Idempotent re-run: a bare target key already exists. We only treat the
          // old versioned key as a stale duplicate to retire when we can prove the
          // target is the SAME art — a matching briefId with divergent bytes MUST
          // fail rather than silently discard the original (both-exist-different-
          // bytes -> fail).
          if (collision.briefId !== concept) {
            errors.push(
              `concept "${concept}": target key "${newKey}" already exists with a different briefId ` +
                `("${collision.briefId}"); manual resolution required.`,
            );
            continue;
          }
          const oldHash =
            typeof oldEntry.contentHash === 'string' ? oldEntry.contentHash : undefined;
          const newHash =
            typeof collision.contentHash === 'string' ? collision.contentHash : undefined;
          if (oldHash && newHash && oldHash !== newHash) {
            errors.push(
              `concept "${concept}": target key "${newKey}" already exists with a different contentHash ` +
                `(old "${oldHash}" vs target "${newHash}"); manual resolution required.`,
            );
            continue;
          }
          retires.push({
            kind: 'retire',
            concept,
            key,
            assetPath: oldEntry.assetPath,
            reason: 'non-keep-lineage',
            // When contentHash could not prove byte-identity (missing on either
            // side), defer to an on-disk byte comparison in the apply step before
            // deleting the old PNG.
            verifyAgainstPath: oldHash && newHash ? undefined : `generated/${newKey}.png`,
          });
          continue;
        }
        renames.push({
          kind: 'rename',
          concept,
          oldKey: key,
          newKey,
          oldBriefId: oldEntry.briefId,
          newBriefId: concept,
          oldAssetPath: oldEntry.assetPath,
          newAssetPath: `generated/${newKey}.png`,
        });
      }
    } else {
      for (const { key, entry } of bucket) {
        retires.push({
          kind: 'retire',
          concept,
          key,
          assetPath: entry.assetPath,
          reason: 'non-keep-lineage',
        });
      }
    }
  }

  // Retire the placeholder(s) for this concept.
  for (const { key, entry } of placeholders) {
    retires.push({
      kind: 'retire',
      concept,
      key,
      assetPath: entry.assetPath,
      reason: 'placeholder',
    });
  }

  return { renames, retires, errors };
}

/** Build the full plan across all allowlisted concepts. */
export function planMigration(
  manifest: GeneratedManifest,
  concepts: readonly ItemArtConcept[],
): MigrationPlan {
  const renames: RenameOp[] = [];
  const retires: RetireOp[] = [];
  const errors: string[] = [];
  for (const c of concepts) {
    const r = planConcept(manifest, c);
    renames.push(...r.renames);
    retires.push(...r.retires);
    errors.push(...r.errors);
  }
  return { renames, retires, errors, clean: renames.length === 0 && retires.length === 0 };
}

// ---------------------------------------------------------------------------
// Apply the plan to in-memory data (pure) — returns new manifest + catalog.
// ---------------------------------------------------------------------------

/**
 * Apply a plan to the manifest + catalog data structures, returning fresh copies.
 *
 * The collections are returned in canonical sorted order:
 *   - Manifest: entry keys sorted lexicographically (required by `check:sort-assets`).
 *   - Catalog: sheets first (kind="sheet"), then by id within each kind group.
 *
 * Renamed entries may shift alphabetical position — this is intentional and
 * necessary to keep the file sortable for future conflict-free merges.
 *
 * (Pre-2026-07-23: the function preserved insertion order to minimise diff
 *  churn. The `check:sort-assets` CI gate now enforces canonical order, so
 *  sort-after-apply is the correct default.)
 */
export function applyPlanToData(
  manifest: GeneratedManifest,
  catalog: readonly CatalogRecordRaw[],
  plan: MigrationPlan,
): { manifest: GeneratedManifest; catalog: CatalogRecordRaw[] } {
  const renameByOld = new Map(plan.renames.map((r) => [r.oldKey, r]));
  const retireKeys = new Set(plan.retires.map((r) => r.key));

  // --- manifest: preserve insertion order, rename in place, drop retired ---
  const nextEntries: Record<string, ManifestEntry> = {};
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (retireKeys.has(key)) continue;
    const rename = renameByOld.get(key);
    if (rename) {
      nextEntries[rename.newKey] = {
        ...entry,
        briefId: rename.newBriefId,
        spriteName: rename.newKey,
        assetPath: rename.newAssetPath,
      };
    } else {
      nextEntries[key] = entry;
    }
  }
  // Sort manifest entries lexicographically (canonical order enforced by check:sort-assets).
  const sortedEntries: Record<string, ManifestEntry> = Object.fromEntries(
    Object.entries(nextEntries).sort(([a], [b]) => a.localeCompare(b)),
  );
  const nextManifest: GeneratedManifest = { ...manifest, entries: sortedEntries };

  // --- catalog: repoint renamed generated entries in place, drop retired ---
  const catalogRenameById = new Map<string, RenameOp>(
    plan.renames.map((r) => [`generated:${r.oldKey}`, r] as const),
  );
  const catalogRetireIds = new Set(plan.retires.map((r) => `generated:${r.key}`));
  const nextCatalog: CatalogRecordRaw[] = [];
  for (const record of catalog) {
    if (catalogRetireIds.has(record.id)) continue;
    const rename = catalogRenameById.get(record.id);
    if (rename && record.kind === 'sprite') {
      // Spread the raw record first so `id`/`label`/`description`/`spriteId`/
      // `assetPath` are updated in their existing key positions and all other
      // fields pass through verbatim in their original order.
      nextCatalog.push({
        ...record,
        id: `generated:${rename.newKey}`,
        label: rename.newKey,
        description: `Generated sprite from brief: ${rename.concept}.`,
        spriteId: rename.newKey,
        assetPath: rename.newAssetPath,
      });
    } else {
      nextCatalog.push(record);
    }
  }

  // Sort catalog: sheets first (kind="sheet"), then by id — canonical order
  // enforced by check:sort-assets.
  nextCatalog.sort((a, b) => {
    const aGroup = a.kind === 'sheet' ? 0 : 1;
    const bGroup = b.kind === 'sheet' ? 0 : 1;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });

  return { manifest: nextManifest, catalog: nextCatalog };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Mode = 'dry-run' | 'apply' | 'check';

interface CliArgs {
  mode: Mode;
  includeBaseballBat: boolean;
  manifestPath: string;
  catalogPath: string;
  assetsDir: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let mode: Mode = 'dry-run';
  let includeBaseballBat = false;
  let manifestPath = path.join('public', 'assets', 'generated', 'manifest.json');
  let catalogPath = path.join('src', 'shared', 'data', 'sprite-catalog.json');
  let assetsDir = path.join('public', 'assets');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') mode = 'apply';
    else if (arg === '--check') mode = 'check';
    else if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--include-baseball-bat') includeBaseballBat = true;
    else if (arg === '--manifest') manifestPath = argv[(i += 1)] ?? manifestPath;
    else if (arg === '--catalog') catalogPath = argv[(i += 1)] ?? catalogPath;
    else if (arg === '--assets-dir') assetsDir = argv[(i += 1)] ?? assetsDir;
  }
  return { mode, includeBaseballBat, manifestPath, catalogPath, assetsDir };
}

function describePlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  for (const r of plan.renames) {
    lines.push(
      `  rename  ${r.oldKey}  ->  ${r.newKey}   (briefId ${r.oldBriefId} -> ${r.newBriefId})`,
    );
  }
  for (const r of plan.retires) {
    lines.push(`  retire  ${r.key}   (${r.reason})`);
  }
  if (plan.errors.length) {
    lines.push('  ERRORS:');
    for (const e of plan.errors) lines.push(`    - ${e}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const concepts = args.includeBaseballBat
    ? [...ITEM_ART_CONCEPTS, BASEBALL_BAT_CONCEPT]
    : ITEM_ART_CONCEPTS;

  const manifestPath = path.resolve(args.manifestPath);
  const generatedDir = path.dirname(manifestPath);
  const assetsDir = path.resolve(args.assetsDir);

  // Source of truth is the per-asset shard set (`entries/<key>.json`); the
  // aggregate `manifest.json` is a build artifact and is not read here.
  const manifest = composeManifestFromShards(generatedDir);

  const plan = planMigration(manifest, concepts);

  process.stdout.write(
    `Item-art normalization — ${plan.renames.length} rename(s), ${plan.retires.length} retire(s), ` +
      `${plan.errors.length} error(s).\n`,
  );
  if (plan.renames.length || plan.retires.length || plan.errors.length) {
    process.stdout.write(`${describePlan(plan)}\n`);
  }

  if (plan.errors.length) {
    throw new Error(`Refusing to proceed: ${plan.errors.length} planning error(s). See above.`);
  }

  if (args.mode === 'check') {
    if (!plan.clean) {
      throw new Error('Item art is not normalized (migration pending). Run with --apply.');
    }
    process.stdout.write('Item art is normalized (nothing pending).\n');
    return;
  }

  if (args.mode === 'dry-run') {
    process.stdout.write(
      plan.clean ? 'Nothing to do.\n' : 'Dry run — no files written. Re-run with --apply.\n',
    );
    return;
  }

  // --- apply ---
  if (plan.clean) {
    process.stdout.write('Nothing to do.\n');
    return;
  }

  // 1. Move/delete PNGs on disk FIRST (idempotent-safe), then write data.
  for (const r of plan.renames) {
    const oldPng = path.join(assetsDir, r.oldAssetPath);
    const newPng = path.join(assetsDir, r.newAssetPath);
    if (existsSync(oldPng)) {
      if (existsSync(newPng)) {
        // Both present (interrupted prior run): only drop the old PNG when it is
        // byte-identical to the already-written target; divergent bytes MUST fail
        // rather than silently discard the original art.
        if (!filesByteEqual(oldPng, newPng)) {
          throw new Error(
            `Refusing to delete "${oldPng}": target "${newPng}" exists but differs in bytes; ` +
              `manual resolution required.`,
          );
        }
        rmSync(oldPng);
      } else {
        renameSync(oldPng, newPng);
      }
    } else if (!existsSync(newPng)) {
      throw new Error(`Missing PNG for rename: neither ${oldPng} nor ${newPng} exists.`);
    }
  }
  for (const r of plan.retires) {
    const png = path.join(assetsDir, r.assetPath);
    if (!existsSync(png)) continue;
    if (r.verifyAgainstPath) {
      // Collision-origin retire we could not prove identical via contentHash:
      // byte-verify against the surviving bare PNG before deleting the old one.
      const keepPng = path.join(assetsDir, r.verifyAgainstPath);
      if (!existsSync(keepPng)) {
        // The surviving art is missing — deleting `png` would drop the last copy
        // and leave the item with no art. Fail loudly instead of silently
        // discarding it (do NOT fall through to `rmSync`).
        throw new Error(
          `Refusing to retire "${png}": expected surviving art "${keepPng}" is missing; ` +
            `manual resolution required.`,
        );
      }
      if (!filesByteEqual(png, keepPng)) {
        // Both exist but differ in bytes — never discard divergent original art.
        throw new Error(
          `Refusing to retire "${png}": surviving art "${keepPng}" differs in bytes; ` +
            `manual resolution required.`,
        );
      }
    }
    rmSync(png);
  }

  // 2. Rewrite the per-asset shards. Renames write the new `entries/<newKey>.json`
  //    and delete the old shard; retires delete the shard. The `generated:`
  //    catalog rows are NOT committed — they derive from the manifest at
  //    read-time (src/shared/generated-catalog.ts) — so no catalog file is
  //    written: the derived id/label/description/assetPath follow the new key
  //    automatically.
  const writtenShardPaths: string[] = [];
  for (const r of plan.renames) {
    const entry = manifest.entries[r.oldKey];
    if (!entry) {
      throw new Error(`Rename planned for "${r.oldKey}" but its shard is missing.`);
    }
    const nextEntry = {
      ...entry,
      briefId: r.newBriefId,
      spriteName: r.newKey,
      assetPath: r.newAssetPath,
    };
    writtenShardPaths.push(writeShard(generatedDir, r.newKey, nextEntry));
    if (r.newKey !== r.oldKey) {
      deleteShard(generatedDir, r.oldKey);
    }
  }
  for (const r of plan.retires) {
    deleteShard(generatedDir, r.key);
  }

  // 3. Re-apply Prettier to the shards we just wrote. Committed shards are
  //    Prettier-formatted; a raw `JSON.stringify(…, 2)` differs from Prettier's
  //    style and would otherwise fail `format:check`. formatJsonFiles
  //    (catalog-io.ts) is the shared formatting helper so all write paths stay
  //    in sync.
  if (writtenShardPaths.length) {
    await formatJsonFiles(writtenShardPaths);
  }

  process.stdout.write(
    `Applied: renamed ${plan.renames.length}, retired ${plan.retires.length}. ` +
      `Wrote + formatted shards.\n`,
  );
}

/**
 * True when both files exist and contain byte-identical content. Used by the
 * apply step to refuse deleting an original PNG when the surviving target
 * differs (both-exist-different-bytes -> fail).
 */
export function filesByteEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
