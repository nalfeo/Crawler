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

/**
 * Path-scoped allowlist entry for intentional test-scaffold exports.
 *
 * Governed as `time-bounded` by `check-allowlist-expiry.ts`: every entry must
 * carry a specific `reason` and a real `expiresOn` review deadline, so the list
 * cannot quietly become a permanent record of dead exports.
 */
export interface TestScaffoldAllowlistEntry {
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
  /** Exported identifier name. */
  readonly name: string;
  /**
   * Why this symbol is exported but has no production caller outside its
   * defining file. Must be specific (what the symbol is, why tests need it).
   */
  readonly reason: string;
  /**
   * ISO date (YYYY-MM-DD) by which the entry must be re-justified, wired into
   * production, or deleted. Enforced by `check-allowlist-expiry.ts`.
   */
  readonly expiresOn: string;
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
export const TEST_SCAFFOLD_ALLOWLIST_ENTRIES = [
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES',
    reason:
      'Safe-room egress tuning constant (30 frames of exit hysteresis) consumed only inside bt-ai-provider itself; exported so AI unit tests can assert egress timing without hard-coding the frame count.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES',
    reason:
      'Safe-room egress tuning constant (45 frames without progress before bail-out) used only within bt-ai-provider; exported so AI unit tests assert the stall threshold symbolically.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'SAFE_ROOM_EGRESS_SUPPRESS_FRAMES',
    reason:
      'Safe-room egress tuning constant (120-frame re-entry suppression window) used only within bt-ai-provider; exported so AI unit tests assert the suppression window symbolically.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'FusedHeadingDebug',
    reason:
      'Debug-only shape describing the fused heading candidates (desired vs chosen) for one AI tick; it is a diagnostic record type, so tests are its only consumer until a debug overlay renders it.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'resolveFloor1AiCollapsePanicDeadlineMs',
    reason:
      'One-line pure clamp of the Floor 1 objective deadline to the collapse-panic ceiling; production calls it through computeCollapsePanicProfile in the same file, so only unit tests import it directly.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/ai/bt-ai-provider.ts',
    name: 'computeCollapsePanicProfile',
    reason:
      'Pure collapse-panic profile computation extracted from the provider tick for determinism testing; production reaches it via the provider in the same file rather than importing it.',
    expiresOn: '2026-11-13',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_REWARD_BUNDLE_RARITIES',
    reason:
      'Underscore-prefixed re-export of the reward-bundle rarity ladder so rarity-distribution tests enumerate exactly what the resolver uses; production code reads the upstream generated-equipment constant directly.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_REWARD_BUNDLE_AFFINITY_PROB',
    reason:
      'Frozen per-rarity affinity-alignment probability table used only inside the resolver; exported so probability tests assert the exact table instead of duplicating magic numbers.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_assertGeneratedRewardInstanceLegal',
    reason:
      'Internal legality assertion for a generated reward instance (e.g. common items may not carry non-armor stat bonuses); called from the resolver in-file, imported only by tests that probe illegal authoring.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_alignmentFromRoll',
    reason:
      'Pure roll-to-alignment decision split out of _rollAffinityAlignment so tests can drive it with explicit roll values; production only goes through the RNG-taking wrapper in the same file.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rollAffinityAlignment',
    reason:
      'Single affinity-alignment draw from a SeededRandom; used by the resolver in-file and imported by determinism tests that replay a seeded sequence step by step.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_resolvePlayerBuildAffinity',
    reason:
      'Maps the active weapon type to a magic/physical build affinity for reward weighting; production calls it in-file during bundle resolution, tests import it to assert the mapping directly.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rarityEligibleBaseIds',
    reason:
      'Internal base-id eligibility filter for a rarity under the decoupled affix model; used in-file by the resolver, exported so authoring tests can assert eligibility without resolving a whole bundle.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_computeFloor2RewardPoolTierEligibility',
    reason:
      'Pure tier-eligibility report builder over the Floor 2 reward pool; production consumes it through _validateFloor2RewardPoolTierEligibility in the same file, tests import it to inspect the report.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_Floor2RewardPoolAuthoringError',
    reason:
      'Error subclass thrown when the Floor 2 reward pool is authored with an unreachable tier; only tests import the class, since production catches nothing and lets it fail loudly at startup.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_validateFloor2RewardPoolTierEligibility',
    reason:
      'Authoring-time validation that every reward tier has eligible bases; invoked in-file at module scope, so data-authoring tests are the only external importers.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: '_rollTierRarity',
    reason:
      'Pure per-tier rarity draw from a SeededRandom, split out of bundle resolution so seeded-distribution tests can sample it in isolation; production uses it in-file.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    name: 'FLOOR2_REWARD_WEAPON_CATEGORY_WEIGHT',
    reason:
      'The 0.25 weapon-vs-non-weapon category weight used by the in-file category roll; exported so balance tests assert the weight symbolically rather than re-typing the literal.',
    expiresOn: '2026-11-20',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_GeneratedEquipmentGeneratorError',
    reason:
      'Coded error class thrown by the generated-equipment generator; production lets it propagate rather than catching by type, so only tests asserting error codes import it.',
    expiresOn: '2026-11-27',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_GenerateEquipmentInstanceRequest',
    reason:
      'Request shape for the internal instance generator; production builds the object inline at the single call site, so the named type exists for test fixtures.',
    expiresOn: '2026-11-27',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: '_getGeneratedEquipmentBaseV1',
    reason:
      'Thin test seam over resolveGeneratedEquipmentBase that returns just the V1 base record; production uses the full resolver result, tests use this to assert base data.',
    expiresOn: '2026-11-27',
  },
  {
    file: 'src/game/generated-equipment-generator.ts',
    name: 'generatedEquipmentBaseHasNonArmorStatBonus',
    reason:
      'Predicate answering whether a base id carries a non-armor stat bonus; used in-file for rarity legality, exported so reward-legality tests can check bases directly.',
    expiresOn: '2026-11-27',
  },
  {
    file: 'src/game/systems/achievementSystem.ts',
    name: 'unlockAchievement',
    reason:
      'Direct unlock entry point that production reaches only through the achievement system tick and its evaluators in the same file; tests call it to force a specific unlock deterministically.',
    expiresOn: '2026-12-04',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_LOOT_TIERS',
    reason:
      'Source-of-truth tuple behind the Floor2AchievementLootTier type and the isFloor2AchievementLootTier guard in the same file; production consumes the type and guard, tests enumerate the tuple.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'ACHIEVEMENT_SCOPES',
    reason:
      'Source-of-truth tuple behind the AchievementScope type in the same file; production consumes the type, tests enumerate the tuple to prove catalogs cover every scope.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'parseAchievementCatalog',
    reason:
      'Zod parse + cross-field validation for a raw achievement catalog; production reaches it through createAchievementCatalog in the same file, tests call it to assert authoring errors.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'createAchievementCatalog',
    reason:
      'Catalog factory invoked at module scope in this same file to build the shipped Floor 1/2 catalogs; tests call it with synthetic data to validate catalog construction.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'createAchievementCatalogRegistry',
    reason:
      'Registry factory invoked at module scope in this same file to build ACHIEVEMENT_CATALOG_REGISTRY; tests call it to build isolated registries instead of mutating the shipped one.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_CATALOG',
    reason:
      'The shipped Floor 2 catalog object; production consumes it via ACHIEVEMENT_CATALOG_REGISTRY built in the same file, so direct importers are catalog-content tests.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENTS',
    reason:
      'Flat list view of the Floor 2 catalog; production goes through the registry lookups, tests use the flat list to assert per-achievement authoring.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_ACHIEVEMENT_COUNT',
    reason:
      'Derived count of Floor 2 floor-scoped achievements, kept as a named constant so content tests can pin the expected catalog size; no runtime consumer needs the count.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR2_RUN_GLOBAL_ACHIEVEMENT_COUNT',
    reason:
      'Derived count of Floor 2 current_run-scoped achievements, kept so content tests pin the run-global catalog size; no runtime consumer needs the count.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'getAchievementCatalogForFloor',
    reason:
      'Registry lookup by floor whose production callers all pass through the achievement system paths that already hold a catalog; tests use it to fetch a floor catalog directly.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'getCurrentRunGlobalAchievements',
    reason:
      'Computes run-global achievements for a set of reached floors; currently exercised only by tests pending the run-summary UI that will consume it.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'buildAchievementArtBacklog',
    reason:
      'Tooling helper that lists achievement icon/loot-box art still to be produced; consumed by asset-pipeline tests and reporting rather than by the running game.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/achievements.ts',
    name: 'FLOOR1_ACHIEVEMENT_COUNT',
    reason:
      'Derived count of Floor 1 achievements, kept as a named constant so content tests pin the expected catalog size; no runtime consumer needs the count.',
    expiresOn: '2026-12-11',
  },
  {
    file: 'src/shared/data/floor2-equipment-wave-b.ts',
    name: 'FLOOR2_EQUIPMENT_WAVE_B_STABLE_IDS',
    reason:
      'Concatenation of the wave-B weapon and non-weapon stable-id tuples; production imports the two narrower tuples, tests use the combined list to assert full wave coverage.',
    expiresOn: '2026-12-18',
  },
  {
    file: 'src/shared/data/floor2-reward-pool.ts',
    name: 'FLOOR2_ARMOR_SLOT_IDS',
    reason:
      'Derived list of every non-hand equipment slot from SLOT_REGISTRY; production iterates the slot registry directly, tests use this to assert armor-slot coverage of the reward pool.',
    expiresOn: '2026-12-22',
  },
  {
    file: 'src/shared/data/floor2-reward-pool.ts',
    name: 'FLOOR2_REWARD_POOL_NON_WEAPON_IDS',
    reason:
      'Derived non-weapon half of the Floor 2 reward pool; the resolver consumes the combined pool, so this split view exists for pool-composition tests.',
    expiresOn: '2026-12-22',
  },
  {
    file: 'src/shared/generated-equipment-types.ts',
    name: 'EQUIPMENT_REWARD_TIERS',
    reason:
      'Source-of-truth tuple behind the EquipmentRewardTier type in the same file; production consumes the type, tests enumerate the tuple to cover every tier.',
    expiresOn: '2027-01-08',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'search',
    reason:
      'Inventory text-search accessor kept as the canonical API for the inventory UI; no production screen calls it yet, and it is the export that motivated this guard, so it stays under explicit review.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'filterByTag',
    reason:
      'Inventory tag-filter accessor kept as the canonical API for the inventory UI; no production screen calls it yet, so it remains tracked rather than silently dead.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'getActiveTags',
    reason:
      'Computes which tags currently have items, intended to drive inventory tab visibility; no production screen calls it yet.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'reorderTab',
    reason:
      'Mutates TabPreferences order for user-driven tab reordering; the inventory UI has no reorder affordance yet, so tests are the only consumer.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'hideTab',
    reason:
      'Hides a custom inventory tab in TabPreferences (refuses known tags); the inventory UI has no hide affordance yet, so tests are the only consumer.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/inventory.ts',
    name: 'showTab',
    reason:
      'Unhides a custom inventory tab in TabPreferences; paired with hideTab and equally unreachable from the UI today.',
    expiresOn: '2027-01-15',
  },
  {
    file: 'src/shared/items.ts',
    name: '_customTag',
    reason:
      'Underscore-prefixed alias of the internal customTag brand constructor, exported purely so tests can mint custom-tag values that production only creates through item authoring.',
    expiresOn: '2027-01-22',
  },
  {
    file: 'src/shared/weaponDefs.ts',
    name: 'WEAPON_DEFS',
    reason:
      'The raw weapon-definition Map; production code resolves weapons through the accessor helpers in this file, so direct importers are balance and data-integrity tests.',
    expiresOn: '2027-01-29',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'computeNormalizedWeaponAnchor',
    reason:
      'Pure normalization of a generated sprite entry weapon anchor to 0..1 frame space; production reaches it through resolveWeaponAnchorWorldPos in the same file, tests assert the normalization directly.',
    expiresOn: '2026-11-06',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'resolveWeaponAnchorWorldPos',
    reason:
      'Resolves a weapon anchor to world coordinates with facing applied; awaiting the engine attachment call site, so anchor-contract tests are the only consumer today.',
    expiresOn: '2026-11-06',
  },
  {
    file: 'src/shared/generated-assets.ts',
    name: 'buildGeneratedSpriteRegistry',
    reason:
      'Parse-then-load convenience over parseGeneratedManifest + loadGeneratedManifest; production performs the two steps explicitly, tests use the one-shot helper on fixture manifests.',
    expiresOn: '2026-11-06',
  },
  {
    file: 'src/engine/PhaserBridge.ts',
    name: 'PHASER_TINT_MODE_FILL',
    reason:
      'Numeric Phaser tint-mode constant re-exported so integration tests can assert flash-overlay tintMode values without embedding the magic number 1.',
    expiresOn: '2026-12-01',
  },
  {
    file: 'src/engine/sprites/door-visuals.ts',
    name: 'DOOR_ART_CONTRACT_NOTE',
    reason:
      'Door art contract sentence used as the assertion message in unit tests that verify projection/framing on shipped door PNGs; it is test-facing documentation, not runtime behavior.',
    expiresOn: '2026-12-08',
  },
  {
    file: 'src/engine/sprites/terrain-pack-visuals.ts',
    name: 'TerrainPackLoaderLike',
    reason:
      'Structural loader interface (image/spritesheet) that lets preload tests pass a fake instead of a Phaser loader; production passes the real Phaser loader, which structurally matches without importing the type.',
    expiresOn: '2026-12-15',
  },
  {
    file: 'src/engine/sprites/terrain-pack-visuals.ts',
    name: 'collectTerrainPackPreloadEntries',
    reason:
      'Pure enumeration of every terrain pack preload entry; production consumes it through the preload call in the same file, tests call it to assert entry generation without Phaser.',
    expiresOn: '2026-12-15',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'terrainPackIdSchema',
    reason:
      'Zod enum sub-schema that also backs the TerrainPackId type; production validates through the top-level pack schema, tests validate this fragment independently.',
    expiresOn: '2027-01-05',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'provenanceSchema',
    reason:
      'Zod discriminated-union sub-schema for asset provenance; production validates through the top-level pack schema, tests exercise provenance variants in isolation.',
    expiresOn: '2027-01-05',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'transformIdSchema',
    reason:
      'Zod enum sub-schema for tile transform ids; production validates through the top-level pack schema, tests validate this fragment independently.',
    expiresOn: '2027-01-05',
  },
  {
    file: 'src/shared/terrain-pack-types.ts',
    name: 'WALL_ACCENT_COUNT',
    reason:
      'Count of wall accent slots a pack must provide; used by pack authoring/validation tests to assert atlas shape, with no separate runtime importer.',
    expiresOn: '2027-01-05',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'deriveTileVariantSeed',
    reason:
      'Pure per-tile seed derivation (floor seed XOR coordinate hash) used in-file by pickPoolVariant; exported so determinism tests can assert seed stability per coordinate.',
    expiresOn: '2027-01-12',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'pickPoolVariant',
    reason:
      'Deterministic pool-variant selection consumed by the terrain renderer through the higher-level helpers in this file; tests call it directly to assert seed-to-variant stability.',
    expiresOn: '2027-01-12',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'buildWeightedCombos',
    reason:
      'Memoized weighted-combo expansion of a variant pool used in-file by pickPoolVariant; exported so tests can assert the weight expansion and cache contract.',
    expiresOn: '2027-01-12',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'WALL_ACCENT_DENSITY',
    reason:
      'Wall-accent probability (0.2) used by the in-file accent decision; exported so variance tests assert the density symbolically instead of duplicating the literal.',
    expiresOn: '2027-01-12',
  },
  {
    file: 'src/shared/terrain-pack-variants.ts',
    name: 'GROUND_DECAL_DENSITY',
    reason:
      'Ground-decal probability (0.75) used by the in-file decal decision; exported so variance tests assert the density symbolically instead of duplicating the literal.',
    expiresOn: '2027-01-12',
  },
  {
    file: 'src/game/floor2Scenario.ts',
    name: 'denFavorGoalId',
    reason:
      'FR13 favor-route goal-id factory (`floor2-family-<id>-favor-earned`); used internally by floor2ObjectiveTick and seeded to false at init; exported so integration tests can assert the favor-specific flag state separately from the den-unlock flag (telemetry/HUD distinguish the two paths).',
    expiresOn: '2026-11-03',
  },
  {
    file: 'src/game/floor2Scenario.ts',
    name: 'hasEarnedDenFavor',
    reason:
      'Pure predicate for the FR13 win-favor route (Friendly band >75, reputation-system active); used internally by floor2ObjectiveTick; exported so integration tests can drive the predicate in isolation (band-boundary, reputation-inactive guard, relation-drop latch).',
    expiresOn: '2026-11-03',
  },
  {
    file: 'src/game/ai/auto-progression.ts',
    name: 'MAX_STAIR_DESCEND_DEFER_FRAMES',
    reason:
      'Loot-aware stair-descend deferral cap (1800 frames = 30 s); used internally by shouldDeferStairDescend; exported so integration tests can drive the cap-expiry branch without hard-coding the frame count.',
    expiresOn: '2026-11-08',
  },
  // Floor 3 (Companion League) epic, slice 1 of 16 (`.specify/specs/floor3-companion-league.md`
  // §Epic decomposition): pure data/lookup foundation landed ahead of its production callers by
  // design. `affinityMultiplier` is wired into the damage-apply path by slice 2 (after 1); the
  // species/style registries are wired by slices 3-5 (companion entity, AI personas, leveling).
  // Until then only the roster/matrix unit tests exercise these exports.
  {
    file: 'src/shared/data/floor3/affinity.ts',
    name: 'AFFINITY_MATRIX',
    reason:
      'Floor 3 slice 1: derived 7x7 affinity multiplier table backing affinityMultiplier(); wired into the damage-apply path by slice 2.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/data/floor3/affinity.ts',
    name: 'affinityMultiplier',
    reason:
      'Floor 3 slice 1: affinity-vs-affinity damage multiplier lookup; wired into the damage-apply path by slice 2.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/data/floor3/affinity.ts',
    name: 'strongAgainst',
    reason:
      'Floor 3 slice 1: lists the two affinities a given affinity is strong against; consumed by the matchup-indicator UX surface (slice 12-14).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/affinity.ts',
    name: 'predatorsOf',
    reason:
      'Floor 3 slice 1: lists the two affinities a given affinity is weak against; consumed by the matchup-indicator UX surface (slice 12-14).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/affinity.ts',
    name: 'isAffinity',
    reason:
      'Floor 3 slice 1: runtime guard for the Affinity union; consumed once Floor 3 wild-spawn and recruiting data (slice 6-7) validate untrusted content input.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'FORM_MIN_LEVELS',
    reason:
      'Floor 3 slice 1: evolution-stage level thresholds (1/10/25) backing formForLevel(); wired into per-creature leveling by slice 5.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'ABILITY_MILESTONE_LEVELS',
    reason:
      'Floor 3 slice 1: ability-unlock milestone levels (1/8/16/25/34) backing learnedAbilityIds(); wired into per-creature leveling by slice 5.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'loadPetSpecies',
    reason:
      'Floor 3 slice 1: cached, validated species roster loader; consumed by companion-entity spawning (slice 3) and wild-spawn generation (slice 7).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'getPetSpecies',
    reason:
      'Floor 3 slice 1: single species-by-id lookup; consumed by companion-entity spawning (slice 3) and the roster/detail UX surface (slice 12-14).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'petSpeciesByAffinity',
    reason:
      'Floor 3 slice 1: affinity-filtered species lookup; consumed by affinity-weighted wild spawns (slice 7).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'petSpeciesByStyle',
    reason:
      'Floor 3 slice 1: fighting-style-filtered species lookup; consumed by the recruiting/starter-picker flow (slice 6).',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'formForLevel',
    reason:
      'Floor 3 slice 1: resolves a species evolution form for a given level; wired into per-creature leveling and the level-up/evolution UX surface by slice 5.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/species.ts',
    name: 'learnedAbilityIds',
    reason:
      'Floor 3 slice 1: resolves the abilities learned by a given level; wired into per-creature leveling and the ability-command UX surface by slice 5.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/styles.ts',
    name: 'STAT_BAND_SCALE',
    reason:
      'Floor 3 slice 1: stat-band multiplier table backing StylePersona; wired into companion-entity stat derivation by slice 3.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/styles.ts',
    name: 'STYLE_PERSONAS',
    reason:
      'Floor 3 slice 1: fighting-style to AI-persona registry; wired into companion-entity AI assignment by slice 3 and the two net-new personas by slice 4.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/styles.ts',
    name: 'stylePersona',
    reason:
      'Floor 3 slice 1: single fighting-style persona lookup; wired into companion-entity AI assignment by slice 3.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/shared/data/floor3/styles.ts',
    name: 'isFightingStyle',
    reason:
      'Floor 3 slice 1: runtime guard for the FightingStyle union; consumed once Floor 3 wild-spawn and recruiting data (slice 6-7) validate untrusted content input.',
    expiresOn: '2026-11-15',
  },
  {
    file: 'src/core/systems/companionProgressionSystem.ts',
    name: 'companionLearnedAbilityIds',
    reason:
      'Floor 3 slice 5: derived (species, level) -> learned ability ids read for the ability-command UX (slice 12-14) and ability-selection AI, neither of which has landed yet; only the lab panel and unit tests call it until those consumers land.',
    expiresOn: '2026-11-22',
  },
  {
    file: 'src/core/spawners/world-objects.ts',
    name: 'spawnRallyPoint',
    reason:
      'Floor 3 slice 6: KO/recovery world-object; no Floor 3 map generator exists yet (wild-spawn/overworld placement lands in slice 7), so only the KO-system unit tests spawn one until that placement path lands.',
    expiresOn: '2026-11-29',
  },
  {
    file: 'src/game/floor3Scenario.ts',
    name: 'FLOOR3_STAIRS_POPPED_GOAL_ID',
    reason:
      'Floor 3 slice 8 objective-observability goal flag written by popFloor3ExitStairs to mirror floor2 flag telemetry; the production win path currently reads the parallel floor3Studios.staircaseSpawned boolean, so only the victory-system tests import the id until a HUD/headless reader lands.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/game/floor3Scenario.ts',
    name: 'FLOOR3_STAIRS_DISCOVERED_GOAL_ID',
    reason:
      'Floor 3 slice 8 objective-observability goal flag written by confirmFloor3StairDescend; production run-outcome reads the parallel floor3Studios.staircaseDiscovered boolean, so only the victory-system tests import the id until a HUD/headless reader lands.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/game/floor3Scenario.ts',
    name: 'FLOOR3_FINAL_FOUR_UNLOCK_GOAL_ID',
    reason:
      'Floor 3 slice 8 gate flag set by floor3ObjectiveTick when all Studios fall; the tick itself is the only production reader (via the same-file goalFlags map), so external importers are the victory-system tests until a HUD/headless progress reader lands.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/game/floor3Scenario.ts',
    name: 'floor3StudioDefeatGoalId',
    reason:
      'Floor 3 slice 8 per-Studio defeat goal-flag id builder used inside floor3ObjectiveTick to latch progress; only the victory-system tests import it directly until a HUD/headless objective-progress reader consumes the per-Studio flags.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/shared/data/floor3/studios.ts',
    name: 'FLOOR3_STUDIO_SELECT_COUNT',
    reason:
      'Floor 3 slice 8 Studio selection size (6) consumed only as the default arg of selectFloor3Studios in the same file; exported so the studios unit tests assert the pick size symbolically rather than hard-coding 6.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/shared/data/floor3/studios.ts',
    name: 'FLOOR3_FINAL_FOUR_SELECT_COUNT',
    reason:
      'Floor 3 slice 8 Final Four selection size (4) consumed only as the default arg of selectFloor3FinalFour in the same file; exported so the studios unit tests assert the pick size symbolically rather than hard-coding 4.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/shared/data/floor3/studios.ts',
    name: 'STUDIO_CANDIDATES',
    reason:
      'Floor 3 slice 8 Studio candidate roster pool consumed within the same file by selectSeeded and the known-species assertion; exported so the studios unit tests validate roster content and pool size until the recruiting/HUD layer reads it directly.',
    expiresOn: '2026-11-23',
  },
  {
    file: 'src/shared/data/floor3/studios.ts',
    name: 'FINAL_FOUR_CANDIDATES',
    reason:
      'Floor 3 slice 8 Final Four candidate handler pool consumed within the same file by selectSeeded and the known-species assertion; exported so the studios unit tests validate roster content and pool size until the recruiting/HUD layer reads it directly.',
    expiresOn: '2026-11-23',
  },
] as const satisfies readonly TestScaffoldAllowlistEntry[];

function toAllowlistKey(file: string, name: string): string {
  return `${file}#${name}`;
}

/**
 * Build a path-scoped allowlist set from explicit file + symbol entries.
 *
 * Takes only the keying fields (`file`, `name`) so callers — including tests
 * that build synthetic allowlists — do not have to supply governance metadata
 * that plays no part in lookup. The governance fields on the real entries are
 * enforced by `check-allowlist-expiry.ts`.
 */
export function buildTestScaffoldAllowlist(
  entries: readonly Pick<TestScaffoldAllowlistEntry, 'file' | 'name'>[],
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
