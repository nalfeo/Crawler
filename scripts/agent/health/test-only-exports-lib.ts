/**
 * test-only-exports-lib.ts — pure logic for detecting `src/` exports whose
 * only consumers live under `tests/**`.
 *
 * ## Why this guard exists
 *
 * The Floor 2 equipment feature shipped with `listInventoryEntries`
 * (`src/shared/inventory.ts`) as its canonical accessor — unit-tested AND
 * property-tested — yet never called from any production code. The knip dead-
 * code detector missed it because `knip.json` includes `tests/**` in its
 * `project` scope, so test-only usage counts as "used" and suppresses the
 * finding.
 *
 * This guard closes that blind spot: it reports any export from `src/**` that
 * is imported by at least one `tests/**` file but by zero `src/**` files
 * (other than the file that defines it).
 *
 * ## Algorithm
 *
 * 1. Collect all named export identifiers from `src/**` via TypeScript AST.
 * 2. Collect all named import identifiers from `src/**` and `tests/**` via AST.
 * 3. Flag exports where `src/` import count == 0 but `tests/` import count > 0.
 *
 * ## Known limitations
 *
 * - Name-based: if two different `src/` files export the same name, a `src/`
 *   import of that name from file B prevents file A's export from being flagged.
 *   In practice this is extremely rare for well-named top-level exports. The
 *   guard emits a warning when it detects duplicate export names so the author
 *   can investigate.
 * - Re-exports are not tracked as src consumers. If a symbol is only surfaced
 *   through a barrel and tests import it through that barrel, the original
 *   export will still be reported unless some non-test `src/` file imports it.
 *   This is deliberate: a re-export is API exposure, not evidence of runtime
 *   production use.
 * - Namespace imports (`import * as X from '...'`) are not counted as
 *   named-import evidence. This is a false-negative risk for rare patterns.
 * - Dynamic imports are not tracked.
 * - Default exports are intentionally excluded (they are hard to track by name).
 * - `import type` statements are counted the same as value imports. This may
 *   produce false negatives (a value-dead export that is only type-imported in
 *   src/ is not flagged). The primary target is dead runtime exports, so this
 *   is an acceptable approximation.
 * - Re-exports from barrel files (e.g. `export { foo } from './foo'`) in `src/`
 *   count as a `src/` import of `foo`, so a barrel-only consumer does NOT cause
 *   the original export to be flagged. This is conservative (may produce false
 *   negatives for barrel-mediated test-only usage), but avoids false positives.
 *
 * File I/O and repo-specific path scoping (for example excluding `src/labs/**`
 * from production evidence) live in the thin `test-only-exports.ts` wrapper so
 * this module can be unit-tested with synthetic file contents.
 */

import ts from 'typescript';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A named export discovered in a `src/` file. */
export interface ExportDef {
  /** The exported identifier name. */
  readonly name: string;
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
}

/** Path-scoped allowlist entry for intentional test-scaffold exports. */
export interface TestScaffoldAllowlistEntry {
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
  /** Exported identifier name. */
  readonly name: string;
}

/** An export flagged as test-only. */
export interface TestOnlyExport {
  /** The exported identifier name. */
  readonly name: string;
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
  /** `tests/**` files that import this name. */
  readonly testConsumers: readonly string[];
}

/** A `{ path, content }` record for a source file. */
export interface SourceFile {
  /** Repo-relative POSIX path, e.g. `src/shared/inventory.ts`. */
  readonly path: string;
  readonly content: string;
}

function isProductionConsumerPath(path: string): boolean {
  return (path.startsWith('src/') && !path.startsWith('src/labs/')) || path.startsWith('scripts/');
}

function isExplicitTestScaffoldingExport(name: string): boolean {
  return name.startsWith('_');
}

/**
 * Export names intentionally exposed for unit testing but without a standalone
 * production caller outside their defining file. This is keyed by both file and
 * symbol to avoid cross-file false negatives when names collide.
 */
const TEST_SCAFFOLD_ALLOWLIST_ENTRIES = [
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_REWARD_BUNDLE_RARITIES',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_REWARD_BUNDLE_AFFINITY_PROB',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_assertGeneratedRewardInstanceLegal',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_alignmentFromRoll',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rollAffinityAlignment',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_resolvePlayerBuildAffinity',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rarityEligibleBaseIds',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_computeFloor2RewardPoolTierEligibility',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_Floor2RewardPoolAuthoringError',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_validateFloor2RewardPoolTierEligibility',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rollTierRarity',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_GeneratedEquipmentGeneratorError',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_GenerateEquipmentInstanceRequest',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_getGeneratedEquipmentBaseV1',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: 'generatedEquipmentBaseHasNonArmorStatBonus',
  },
  {
    file: 'src/game/systems/achievementSystem.ts',
    name: 'unlockAchievement',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_LOOT_TIERS',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'ACHIEVEMENT_SCOPES',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'parseAchievementCatalog',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'createAchievementCatalog',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'createAchievementCatalogRegistry',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_CATALOG',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENTS',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_COUNT',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_RUN_GLOBAL_ACHIEVEMENT_COUNT',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'getAchievementCatalogForFloor',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'getCurrentRunGlobalAchievements',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'buildAchievementArtBacklog',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR1_ACHIEVEMENT_COUNT',
  },
  {
    file: 'src/shared/data/floor2-equipment-wave-b.ts',
    name: 'FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS',
  },
  {
    file: 'src/shared/data/floor2-reward-pool.ts',
    name: 'FLOOR2_ARMOR_SLOT_IDS',
  },
  {
    file: 'src/shared/data/floor2-reward-pool.ts',
    name: 'FLOOR2_REWARD_POOL_NON_WEAPON_IDS',
  },
  {
    file: 'src/shared/generated-equipment-types.ts',
    name: 'EQUIPMENT_REWARD_TIERS',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'search',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'filterByTag',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'getActiveTags',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'reorderTab',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'hideTab',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'showTab',
  },
  {
    file: 'src/shared/items.ts',
    name: '_customTag',
  },
  {
    file: 'src/shared/weaponDefs.ts',
    name: 'WEAPON_DEFS',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'computeNormalizedWeaponAnchor',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'resolveWeaponAnchorWorldPos',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'buildGeneratedSpriteRegistry',
  },
  // PhaserBridge: numeric tint-mode constant re-exported so integration tests
  // can assert flash-overlay tintMode values without embedding magic numbers.
  {
    file: 'src/engine/PhaserBridge.ts',
    name: 'PHASER_TINT_MODE_FILL',
  },
  // Door art contract string used as assertion messages in unit tests that
  // verify the projection/framing contract on shipped door PNGs.
  {
    file: 'src/engine/sprites/door-visuals.ts',
    name: 'DOOR_ART_CONTRACT_NOTE',
  },
  // terrain-pack-visuals: pure helper + interface used only in unit tests
  // that verify preload-entry generation without loading Phaser.
  {
    file: 'src/engine/sprites/terrain-pack-visuals.ts',
    name: 'TerrainPackLoaderLike',
  },
  {
    file: 'src/engine/sprites/terrain-pack-visuals.ts',
    name: 'collectTerrainPackPreloadEntries',
  },
  // terrain-pack-types: zod sub-schemas and constants exposed so unit tests
  // can validate schema fragments independently of the top-level pack schema.
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'terrainPackIdSchema',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'provenanceSchema',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'transformIdSchema',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'WALL_ACCENT_COUNT',
  },
  // terrain-pack-variants: internal variance helpers tested in isolation so
  // that seed-based determinism and pool-weight contracts are unit-verifiable.
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'deriveTileVariantSeed',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'pickPoolVariant',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'buildWeightedCombos',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'WALL_ACCENT_DENSITY',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'GROUND_DECAL_DENSITY',
  },
] as const satisfies readonly TestScaffoldAllowlistEntry[];

function toAllowlistKey(file: string, name: string): string {
  return `${file}#${name}`;
}

/** Build a path-scoped allowlist set from explicit file + symbol entries. */
export function buildTestScaffoldAllowlist(
  entries: readonly TestScaffoldAllowlistEntry[],
): ReadonlySet<string> {
  return new Set(entries.map((entry) => toAllowlistKey(entry.file, entry.name)));
}

/** Default path-scoped allowlist used by the guard wrapper. */
export const TEST_SCAFFOLD_ALLOWLIST = buildTestScaffoldAllowlist(TEST_SCAFFOLD_ALLOWLIST_ENTRIES);

/** Check whether an export is allowlisted as intentional test scaffold. */
export function isTestScaffoldAllowlisted(
  exp: ExportDef,
  allowlist: ReadonlySet<string> = TEST_SCAFFOLD_ALLOWLIST,
): boolean {
  return allowlist.has(toAllowlistKey(exp.file, exp.name));
}

// ---------------------------------------------------------------------------
// Export collection
// ---------------------------------------------------------------------------

/**
 * Collect all named exported identifiers from the given files using the
 * TypeScript AST.
 *
 * Handles:
 * - `export function foo` / `export const foo` / `export class Foo` / etc.
 * - `export { foo, bar }` (specifier lists, WITHOUT `from`)
 * - `export { foo as bar }` (uses the *exported* name `bar`)
 *
 * Does NOT handle:
 * - `export default` (anonymous or hard to track by name)
 * - `export { foo } from '...'` (barrel re-exports with `from`) — intentionally
 *   excluded: the re-export is a `src/` consumer of the original declaration;
 *   including it would cause barrel files to be incorrectly flagged as test-only.
 */
export function collectNamedExports(files: readonly SourceFile[]): ExportDef[] {
  const result: ExportDef[] = [];

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ false,
    );

    for (const node of sourceFile.statements) {
      // export function foo / export const foo = / export class Foo / etc.
      if (
        ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        if (!hasExportModifier(node)) continue;
        const name = getDeclarationName(node);
        if (name) {
          result.push({ name, file: file.path });
        }
        // Variable declarations may declare multiple names (e.g. `export const a = 1, b = 2`).
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            const varName = getBindingName(decl.name);
            if (varName && varName !== name) {
              result.push({ name: varName, file: file.path });
            }
          }
        }
      }

      // export { foo, bar as baz } (local re-export, WITHOUT a `from` clause)
      // These are internal re-groupings that are valid dead-export candidates.
      // `export { foo } from '...'` (WITH `from`) is a barrel re-export and is
      // intentionally excluded here: the re-export IS the src/ consumer of the
      // original declaration, so collecting it as an export candidate would
      // cause barrel files to be incorrectly flagged as test-only.
      if (ts.isExportDeclaration(node) && node.exportClause && !node.moduleSpecifier) {
        if (ts.isNamedExports(node.exportClause)) {
          for (const specifier of node.exportClause.elements) {
            // The exported name is the alias if present, otherwise the original.
            const exportedName = specifier.name.text;
            result.push({ name: exportedName, file: file.path });
          }
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Import collection
// ---------------------------------------------------------------------------

/**
 * For each file, collect all named identifiers brought in via import
 * declarations.
 *
 * Returns a `Map<symbolName, Set<importingFilePath>>` so callers can quickly
 * ask "which files import symbol X?".
 *
 * Handles:
 * - `import { foo, bar } from '...'`
 * - `import { foo as localFoo } from '...'` (tracks the *original* name `foo`)
 * Does NOT handle:
 * - `import * as X from '...'` (namespace — would require tracking X.foo usage)
 * - `import defaultExport from '...'` (default imports)
 * - Dynamic `import('...')`
 */
export function collectNamedImports(files: readonly SourceFile[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  const addImport = (name: string, filePath: string): void => {
    let set = result.get(name);
    if (!set) {
      set = new Set();
      result.set(name, set);
    }
    set.add(filePath);
  };

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ false,
    );

    for (const node of sourceFile.statements) {
      // import { foo, bar as baz } from '...'
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
        const bindings = node.importClause.namedBindings;
        if (ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            // el.propertyName is the original name (if aliased); el.name is the local alias.
            const originalName = el.propertyName ? el.propertyName.text : el.name.text;
            addImport(originalName, file.path);
          }
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main algorithm
// ---------------------------------------------------------------------------

/**
 * Find exports from `srcFiles` whose only consumers are in `testFiles`.
 *
 * An export is "test-only" when:
 * - No `src/` file other than the defining file imports it (by name), AND
 * - At least one `tests/` file imports it (by name).
 */
export function findTestOnlyExports(
  srcFiles: readonly SourceFile[],
  testFiles: readonly SourceFile[],
): TestOnlyExport[] {
  const exports = collectNamedExports(srcFiles);
  const srcImports = collectNamedImports(srcFiles);
  const testImports = collectNamedImports(testFiles);

  const result: TestOnlyExport[] = [];

  for (const exp of exports) {
    if (isExplicitTestScaffoldingExport(exp.name)) continue;
    if (isTestScaffoldAllowlisted(exp)) continue;

    // Consumers in src/ other than the exporting file itself.
    const srcConsumers = srcImports.get(exp.name) ?? new Set<string>();
    const outsideSrcConsumers = [...srcConsumers].filter(
      (f) => f !== exp.file && isProductionConsumerPath(f),
    );

    if (outsideSrcConsumers.length > 0) continue; // production-used — skip

    const testConsumers = [...(testImports.get(exp.name) ?? new Set<string>())];
    if (testConsumers.length === 0) continue; // unused everywhere — not our concern

    result.push({ name: exp.name, file: exp.file, testConsumers });
  }

  return result;
}

function exportKey(exp: Pick<TestOnlyExport, 'file' | 'name'>): string {
  return `${exp.file}::${exp.name}`;
}

/**
 * Compare two repo snapshots and return only exports that became test-only in
 * the current snapshot. This filters out pre-existing debt in files that a PR
 * merely happened to touch, while still catching unchanged exports whose last
 * production caller was removed by the branch.
 */
export function findNewlyTestOnlyExports(
  currentSrcFiles: readonly SourceFile[],
  currentTestFiles: readonly SourceFile[],
  baseSrcFiles: readonly SourceFile[],
  baseTestFiles: readonly SourceFile[],
): TestOnlyExport[] {
  const baseKeys = new Set(
    findTestOnlyExports(baseSrcFiles, baseTestFiles).map((exp) => exportKey(exp)),
  );

  return findTestOnlyExports(currentSrcFiles, currentTestFiles).filter(
    (exp) => !baseKeys.has(exportKey(exp)),
  );
}

/**
 * Detect duplicate export names across all files (a name exported by two or
 * more files). The name-based import scan cannot distinguish which file a
 * given import targets, so duplicates create ambiguity and may produce false
 * negatives (one file's export "shields" another from being flagged).
 */
export function findDuplicateExportNames(
  exports: readonly ExportDef[],
): Array<{ name: string; files: string[] }> {
  const byName = new Map<string, string[]>();
  for (const exp of exports) {
    const list = byName.get(exp.name);
    if (list) {
      list.push(exp.file);
    } else {
      byName.set(exp.name, [exp.file]);
    }
  }
  return [...byName.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files }));
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function hasExportModifier(node: ts.Declaration | ts.VariableStatement): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function getDeclarationName(
  node:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration
    | ts.EnumDeclaration
    | ts.VariableStatement,
): string | undefined {
  if (ts.isVariableStatement(node)) {
    // Return the first name; additional names are handled by the caller.
    const first = node.declarationList.declarations[0];
    return first ? getBindingName(first.name) : undefined;
  }
  return node.name?.text;
}

function getBindingName(name: ts.BindingName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  // Object/array destructuring — skip; these are unusual at module level.
  return undefined;
}
