/**
 * Repo-wide generated-sprite name taxonomy — pure logic, no IO.
 *
 * Canonical rule (supersedes the item-only scope of ADR 0051): a generated
 * asset's manifest key, `briefId`, `spriteName`, PNG filename and `generated:`
 * catalog id are all the **bare concept**, with variants distinguished by a
 * `-var-<N>` suffix and nothing else. Generation-time lineage tags (`-v1`,
 * `-v2`, …) are retired.
 *
 * WHY this is a correctness fix and not cosmetics: `loadGeneratedManifest`
 * buckets variants by `briefId`, and `pickGeneratedVariant` draws from exactly
 * one bucket. So `rat` and `rat-v1` are two *separate* buckets and only one is
 * ever reachable at runtime — an approved variant that can never render. 24
 * concepts were fragmented this way. Collapsing the lineage tag makes the
 * fragmentation structurally impossible rather than merely fixed once.
 *
 * The taxonomy is driven purely by NAME. It deliberately never reads the
 * manifest `type` field: 227 of 635 shipped entries carry no `type` at all, and
 * ADR 0051 already recorded that `type` disagrees with reality where it does
 * exist (`classified-dossier` real art is `character`, its placeholder `item`).
 *
 * Merge policy for a fragmented concept: keep EVERY approved variant, and
 * renumber deterministically when lineages collide on a variant index (11 of
 * the 24 concepts do — e.g. `rat` has two `var-9`, `slime` two `var-3`).
 * Ordering is oldest-`approvedAt`-first, then manifest key, so the result is
 * stable across machines and reruns.
 *
 * This module is pure so it is trivially unit-testable and so the migration
 * script, the CI guard, and the approve-time recurrence check all share one
 * implementation of the rule.
 */

/** Minimal manifest-entry shape this taxonomy needs. Extra fields pass through. */
export interface TaxonomyEntry {
  readonly briefId: string;
  readonly spriteName?: string;
  readonly assetPath?: string;
  readonly approvedAt?: string;
  readonly sourceRun?: string;
  readonly variantIndex?: number;
}

/** One planned rename of a single manifest entry. */
export interface SpriteRename {
  /** Manifest key today (also the shard path stem). */
  readonly fromKey: string;
  /** Manifest key after migration. */
  readonly toKey: string;
  /** `briefId` today. */
  readonly fromBriefId: string;
  /** Bare concept `briefId` after migration. */
  readonly toBriefId: string;
  /** Variant index after migration (may differ when lineages collided). */
  readonly toVariantIndex: number;
  /** True when the entry's variant index had to change to avoid a collision. */
  readonly renumbered: boolean;
}

/** A concept whose entries could not be planned safely. */
export interface TaxonomyConflict {
  readonly concept: string;
  readonly reason: string;
  readonly keys: readonly string[];
}

export interface TaxonomyPlan {
  /** Renames to apply, in deterministic order. Excludes no-op entries. */
  readonly renames: readonly SpriteRename[];
  /** Concepts that need human attention rather than an automatic rename. */
  readonly conflicts: readonly TaxonomyConflict[];
  /** Concepts that were fragmented across more than one lineage. */
  readonly mergedConcepts: readonly string[];
}

/**
 * Design-name remaps applied BEFORE lineage stripping.
 *
 * A few concepts embed a `-vN`-shaped token that is part of the *design* name
 * rather than a generation lineage tag — `angry-roomba-v2` means "the Roomba
 * mark 2", a distinct enemy from `angry-roomba`, and the repo already asserts
 * it must stay distinct (`tests/unit/sprites/approve.test.ts` "leaves a genuine
 * non-item versioned brief VERSIONED"). Left alone it would strip to a name
 * that still *looks* tagged, forcing a permanent exception in the CI guard.
 *
 * Remapping these to an unambiguous spelling keeps the canonical rule absolute:
 * after migration NO brief id may contain a lineage tag, with no allowlist.
 */
export const DESIGN_NAME_REMAP: Readonly<Record<string, string>> = {
  'angry-roomba-v2': 'angry-roomba-mk2',
};

/**
 * A single trailing lineage tag: `-v` followed by digits, at the very end.
 * Only ONE tag is stripped, so a genuinely odd name like `iron-ore-v1-v2`
 * collapses to `iron-ore-v1` rather than silently losing two segments — that
 * shows up as a conflict instead of a wrong guess.
 */
const LINEAGE_TAG = /^(.+)-v\d+$/;

/** A trailing variant suffix. */
const VARIANT_SUFFIX = /^(.+)-var-(\d+)$/;

/**
 * Strip a single trailing `-vN` lineage tag from a brief id, honouring the
 * design-name remap both BEFORE and AFTER stripping.
 *
 * Checking the remap first is load-bearing: a bare `angry-roomba-v2` brief IS
 * the mark-2 concept, so stripping it first would silently merge the mark 2
 * into `angry-roomba` and destroy the distinction the remap exists to preserve.
 *
 * `rat-v1` -> `rat`; `rat` -> `rat`;
 * `angry-roomba-v2` -> `angry-roomba-mk2`; `angry-roomba-v2-v1` -> `angry-roomba-mk2`.
 */
export function bareConcept(briefId: string): string {
  const direct = DESIGN_NAME_REMAP[briefId];
  if (direct !== undefined) return direct;
  const match = LINEAGE_TAG.exec(briefId);
  const stripped = match !== null ? match[1]! : briefId;
  return DESIGN_NAME_REMAP[stripped] ?? stripped;
}

/**
 * True when a brief id still carries a generation-time lineage tag, i.e. it is
 * not yet canonical. Design-name remap targets (`angry-roomba-mk2`) are
 * canonical by construction and never report as tagged.
 */
export function hasLineageTag(briefId: string): boolean {
  return bareConcept(briefId) !== briefId;
}

/**
 * Split a manifest key into its brief part and variant index.
 * Returns `null` for a key with no `-var-<N>` suffix (e.g. a packed frame-strip
 * entry keyed by the bare brief id, or a nested `equipment/weapon/...` key).
 */
export function splitVariantKey(key: string): { brief: string; variantIndex: number } | null {
  const match = VARIANT_SUFFIX.exec(key);
  if (match === null) return null;
  return { brief: match[1]!, variantIndex: Number(match[2]!) };
}

/** True when an entry is a placeholder rather than real generated art. */
export function isPlaceholder(entry: TaxonomyEntry): boolean {
  return entry.sourceRun === 'placeholder' || /-placeholder\.png$/i.test(entry.assetPath ?? '');
}

/**
 * Deterministic merge order for the variants of one concept: oldest approval
 * first, then manifest key as a total-order tiebreak so entries with an equal
 * or absent `approvedAt` still sort stably across machines.
 */
function compareForMerge(
  a: readonly [string, TaxonomyEntry],
  b: readonly [string, TaxonomyEntry],
): number {
  const aAt = a[1].approvedAt ?? '';
  const bAt = b[1].approvedAt ?? '';
  if (aAt !== bAt) return aAt < bAt ? -1 : 1;
  return a[0].localeCompare(b[0]);
}

/**
 * Build the deterministic rename plan for a whole manifest.
 *
 * Given the same input map this always returns the same plan, and applying the
 * plan twice is a no-op (the second run produces zero renames) — which is what
 * lets the migration double as a `--check` CI guard.
 */
export function buildTaxonomyPlan(entries: Readonly<Record<string, TaxonomyEntry>>): TaxonomyPlan {
  // Group every entry by the bare concept its key resolves to.
  const byConcept = new Map<string, Array<readonly [string, TaxonomyEntry]>>();
  const conflicts: TaxonomyConflict[] = [];

  for (const key of Object.keys(entries).sort((a, b) => a.localeCompare(b))) {
    const entry = entries[key]!;
    const concept = bareConcept(entry.briefId);
    const group = byConcept.get(concept);
    if (group) {
      group.push([key, entry] as const);
    } else {
      byConcept.set(concept, [[key, entry] as const]);
    }
  }

  const renames: SpriteRename[] = [];
  const mergedConcepts: string[] = [];

  for (const concept of Array.from(byConcept.keys()).sort((a, b) => a.localeCompare(b))) {
    const group = byConcept.get(concept)!;
    const lineages = new Set(group.map(([, entry]) => entry.briefId));
    const wasFragmented = lineages.size > 1;
    if (wasFragmented) {
      mergedConcepts.push(concept);
    }

    // A key with no `-var-N` suffix is either a placeholder (`<concept>-placeholder`)
    // or a packed frame-strip / nested key. Placeholders are expected and are
    // handled by the migration's retire step, so they must not block a merge.
    // Anything else has a shape this migration does not model — renaming it
    // would need the strip packing rewritten too — so surface it rather than guess.
    const unkeyed = group.filter(
      ([key, entry]) => splitVariantKey(key) === null && !isPlaceholder(entry),
    );
    if (unkeyed.length > 0 && wasFragmented) {
      conflicts.push({
        concept,
        reason: 'fragmented concept contains a non-variant key (packed strip or nested key)',
        keys: unkeyed.map(([key]) => key).sort((a, b) => a.localeCompare(b)),
      });
      continue;
    }

    const sorted = [...group].sort(compareForMerge);

    // Preserve each entry's existing index where it is free, and only renumber
    // the entries that actually collide. This keeps churn to the 11 genuinely
    // colliding concepts instead of reshuffling all 24.
    const taken = new Set<number>();
    const assigned = new Map<string, number>();
    for (const [key, entry] of sorted) {
      const split = splitVariantKey(key);
      if (split === null) continue;
      const preferred = entry.variantIndex ?? split.variantIndex;
      if (!taken.has(preferred)) {
        taken.add(preferred);
        assigned.set(key, preferred);
      }
    }
    let next = 0;
    for (const [key] of sorted) {
      if (assigned.has(key) || splitVariantKey(key) === null) continue;
      while (taken.has(next)) next += 1;
      taken.add(next);
      assigned.set(key, next);
    }

    for (const [key, entry] of sorted) {
      const split = splitVariantKey(key);
      if (split === null) continue;
      const toVariantIndex = assigned.get(key)!;
      const toKey = `${concept}-var-${toVariantIndex}`;
      if (toKey === key && entry.briefId === concept) {
        continue; // already canonical
      }
      renames.push({
        fromKey: key,
        toKey,
        fromBriefId: entry.briefId,
        toBriefId: concept,
        toVariantIndex,
        renumbered: toVariantIndex !== (entry.variantIndex ?? split.variantIndex),
      });
    }
  }

  // Guard against a plan that would collide two entries onto one key.
  const destinations = new Map<string, string[]>();
  for (const rename of renames) {
    const existing = destinations.get(rename.toKey);
    if (existing) {
      existing.push(rename.fromKey);
    } else {
      destinations.set(rename.toKey, [rename.fromKey]);
    }
  }
  const untouched = new Set(
    Object.keys(entries).filter((key) => !renames.some((r) => r.fromKey === key)),
  );
  for (const [toKey, sources] of destinations) {
    if (sources.length > 1 || untouched.has(toKey)) {
      conflicts.push({
        concept: bareConcept(toKey),
        reason: `rename target "${toKey}" is claimed by more than one entry`,
        keys: [...sources, ...(untouched.has(toKey) ? [toKey] : [])].sort((a, b) =>
          a.localeCompare(b),
        ),
      });
    }
  }

  const conflicted = new Set(conflicts.flatMap((c) => c.keys));
  return {
    renames: renames.filter((r) => !conflicted.has(r.fromKey)),
    conflicts,
    mergedConcepts,
  };
}
