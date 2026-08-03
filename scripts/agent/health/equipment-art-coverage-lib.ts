/**
 * equipment-art-coverage-lib.ts — Pure logic for the wired-equipment art
 * coverage ratchet. No fs, no process, no console: the CLI resolves every
 * piece's art and hands this module plain records, so each classification and
 * ratchet decision is unit-testable from in-memory fixtures.
 *
 * ## Why this exists
 *
 * Equipment could ship wired-but-un-arted and nothing failed. `resolveItemSprite`
 * happily returns a placeholder (or null), the panels render a placeholder icon
 * (or a two-letter abbreviation), and CI stays green. The gap was therefore only
 * ever found by a human noticing in game — which turned every discovery into its
 * own one-off "add art for X" PR. `sprites:placeholder-audit` does not close
 * this: it walks the manifest, sprite registry, mob defs, and enemy packs, but
 * never the equipment ID space itself.
 *
 * This check walks that ID space — the legacy inventory catalog's equippables
 * plus the Floor 2 generated-equipment reward pool — resolves each piece through
 * the SAME `resolveItemSprite` the game uses, and classifies it.
 *
 * ## Classification
 *
 * | status        | Meaning                                                        |
 * | ------------- | -------------------------------------------------------------- |
 * | `real`        | Resolves to approved, non-placeholder generated art             |
 * | `placeholder` | Resolves only to a placeholder entry (procedural or fetched icon)|
 * | `none`        | Resolves to nothing; the UI falls back to a 2-letter text tile  |
 *
 * `placeholder` and `none` are both **gaps**. They are reported separately
 * because they look different in game, but the ratchet treats them identically:
 * neither is shipped art. A placeholder is deliberately NOT counted as covered —
 * doing so would make the gate green while the game still looks wrong.
 *
 * ## The ratchet
 *
 * The committed baseline lists the gaps that exist today. The check fails when a
 * gap appears that is NOT in the baseline — i.e. new equipment landed without
 * art, or a change regressed a piece that used to resolve real art. Gaps that
 * CLOSE are reported as progress and are expected to be removed from the
 * baseline (`--update`).
 *
 * The baseline is **shrink-only** by construction: `--update` writes exactly the
 * currently-observed gap set, which can only ever be a subset of the baseline on
 * a passing run (a superset would have failed first). So the file can never be
 * used to widen the allowance — the only way to add an ID to it is to fix the
 * failure or to knowingly edit the file by hand, which shows up in review as
 * what it is. There is no allowlist and no per-entry escape hatch: an un-arted
 * piece is either pre-existing debt that is already listed, or a regression that
 * fails.
 */

/** How a wired piece's art resolves. */
export type EquipmentArtStatus = 'real' | 'placeholder' | 'none';

/** Which ID space a piece came from. Reporting only — both are gated equally. */
export type EquipmentArtSource = 'catalog' | 'floor2-pool';

/** One wired equipment piece and how its art resolved. */
export interface EquipmentArtRow {
  /** Item id or Floor 2 stable ID, e.g. `iron-sword` / `weapon.war-fan`. */
  readonly id: string;
  readonly source: EquipmentArtSource;
  readonly status: EquipmentArtStatus;
  /** Resolved asset path, or null when nothing resolved. */
  readonly assetPath: string | null;
  /** Resolved brief id, or null when nothing resolved. */
  readonly briefId: string | null;
}

/** The committed ratchet baseline. */
export interface EquipmentArtBaseline {
  /**
   * IDs known to lack real art. Sorted, unique. Shrink-only: see the module
   * docblock.
   */
  readonly gaps: readonly string[];
}

/** Outcome of evaluating rows against a baseline. */
export interface EquipmentArtCoverageResult {
  readonly rows: readonly EquipmentArtRow[];
  /** Every id whose status is not `real`, sorted. */
  readonly gaps: readonly string[];
  /** Gaps absent from the baseline — these FAIL the check. */
  readonly newGaps: readonly string[];
  /** Baseline ids that now resolve real art — progress, safe to drop. */
  readonly closedGaps: readonly string[];
  /** Baseline ids that no longer exist in the wired ID space at all. */
  readonly staleBaselineIds: readonly string[];
  readonly counts: {
    readonly total: number;
    readonly real: number;
    readonly placeholder: number;
    readonly none: number;
  };
  readonly ok: boolean;
}

/**
 * Classify a resolved manifest entry. `null` (nothing resolved) is `none`;
 * an entry the pipeline marks as a placeholder is `placeholder`; anything else
 * is real approved art.
 *
 * `isPlaceholder` is passed in rather than imported so this module stays free of
 * any dependency on the shared runtime — the CLI supplies the SAME predicate the
 * game uses (`isPlaceholderEntry`), which is what keeps the classification
 * honest instead of re-deriving a second, driftable notion of "placeholder".
 */
export function classifyArtStatus<
  T extends { readonly assetPath: string; readonly briefId: string },
>(entry: T | null, isPlaceholder: (entry: T) => boolean): EquipmentArtStatus {
  if (entry === null) return 'none';
  return isPlaceholder(entry) ? 'placeholder' : 'real';
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Evaluate coverage rows against the committed baseline. */
export function evaluateCoverage(
  rows: readonly EquipmentArtRow[],
  baseline: EquipmentArtBaseline,
): EquipmentArtCoverageResult {
  const baselineSet = new Set(baseline.gaps);
  const allIds = new Set(rows.map((row) => row.id));
  const gaps = sortedUnique(rows.filter((row) => row.status !== 'real').map((row) => row.id));
  const gapSet = new Set(gaps);

  const newGaps = gaps.filter((id) => !baselineSet.has(id));
  const closedGaps = sortedUnique(baseline.gaps.filter((id) => allIds.has(id) && !gapSet.has(id)));
  const staleBaselineIds = sortedUnique(baseline.gaps.filter((id) => !allIds.has(id)));

  let real = 0;
  let placeholder = 0;
  let none = 0;
  for (const row of rows) {
    if (row.status === 'real') real += 1;
    else if (row.status === 'placeholder') placeholder += 1;
    else none += 1;
  }

  return {
    rows,
    gaps,
    newGaps,
    closedGaps,
    staleBaselineIds,
    counts: { total: rows.length, real, placeholder, none },
    ok: newGaps.length === 0,
  };
}

/**
 * The baseline that should be committed for the current corpus: exactly the
 * observed gap set. On a passing run this is always a subset of the previous
 * baseline, which is what makes the file shrink-only.
 */
export function nextBaseline(result: EquipmentArtCoverageResult): EquipmentArtBaseline {
  return { gaps: result.gaps };
}

/**
 * True when writing `next` over `previous` would WIDEN the allowance. Used by
 * the CLI to refuse an `--update` that would add IDs, so the shrink-only
 * property is enforced mechanically rather than by convention.
 */
export function baselineWouldWiden(
  previous: EquipmentArtBaseline,
  next: EquipmentArtBaseline,
): boolean {
  const previousSet = new Set(previous.gaps);
  return next.gaps.some((id) => !previousSet.has(id));
}

/** Human-readable report. Deterministic: rows are emitted in sorted id order. */
export function formatReport(result: EquipmentArtCoverageResult): string {
  const lines: string[] = [];
  const { counts } = result;
  lines.push(
    `Equipment art coverage: ${counts.real}/${counts.total} real ` +
      `(${counts.placeholder} placeholder, ${counts.none} no-art).`,
  );

  if (result.closedGaps.length > 0) {
    lines.push('');
    lines.push(`✅ ${result.closedGaps.length} gap(s) closed since the baseline:`);
    for (const id of result.closedGaps) lines.push(`   - ${id}`);
    lines.push('   Run with --update to shrink the baseline.');
  }

  if (result.staleBaselineIds.length > 0) {
    lines.push('');
    lines.push(`ℹ️  ${result.staleBaselineIds.length} baseline id(s) no longer wired:`);
    for (const id of result.staleBaselineIds) lines.push(`   - ${id}`);
    lines.push('   Run with --update to drop them.');
  }

  if (result.newGaps.length > 0) {
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    lines.push('');
    lines.push(`❌ ${result.newGaps.length} wired equipment piece(s) have no real art:`);
    for (const id of result.newGaps) {
      const row = byId.get(id);
      lines.push(`   - ${id} (${row?.status ?? 'none'})`);
    }
    lines.push('');
    lines.push('Every wired piece needs approved, non-placeholder art. Either land the art');
    lines.push('(see the sprite pipeline in scripts/sprites/) or do not wire the piece yet.');
    lines.push('Do NOT hand-add these ids to the baseline — it is shrink-only by policy.');
  } else {
    lines.push('');
    lines.push('✅ No new equipment art gaps.');
  }

  return lines.join('\n');
}
