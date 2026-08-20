// Hand-written type declarations for `visual-review-lib.mjs` so the tsx-run
// `visual-review-agent.ts` can import the pure helpers and typecheck cleanly.
// (tsconfig only includes `scripts/**/*.ts`, and the lib is intentionally plain
// ESM so `node --test` can run its `.test.mjs` without a loader.)

export interface VisualReviewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VisualReviewRegionKind = 'slot' | 'icon' | 'panel' | 'tooltip' | 'text' | 'other';

export interface VisualReviewRegion {
  id: string;
  box: VisualReviewBox;
  kind?: VisualReviewRegionKind;
  parentId?: string;
}

export interface NormalizedScore {
  /** The score to display/gate on (1 dp, clamped to 1-5, or 0 when unrecoverable). */
  score: number;
  /** The raw `overall.score` the model returned, preserved for provenance. */
  raw: unknown;
  /** True when `score` was synthesized from the axis mean because raw was out of range. */
  normalized: boolean;
}

export interface FindingDiff {
  new: string[];
  recurring: string[];
}

export function computeGeometryBlockers(regions: readonly VisualReviewRegion[]): string[];
export function computeAlignmentBlockers(regions: readonly VisualReviewRegion[]): string[];

export function suppressUnsupportedAlignment(
  result: object,
  deterministicBlockers: readonly string[],
): number;

export interface AnchoredScore {
  /** Reproducible composite: axis mean minus the blocker penalty, 1 dp. */
  score: number;
  /** Mean of the model's per-axis scores, or null when no usable axis existed. */
  axisMean: number | null;
  /** Total points deducted for blocking findings. */
  penalty: number;
  deterministicBlockers: number;
  llmBlockers: number;
  /** The (normalized) headline number the model itself returned, for provenance. */
  modelScore: number;
  /** False when there were no usable axes and the model score was passed through. */
  anchored: boolean;
}

export const DETERMINISTIC_BLOCKER_PENALTY: number;
export const LLM_BLOCKER_PENALTY: number;

export function deriveAnchoredScore(result: unknown): AnchoredScore;

export function normalizeOverallScore(result: unknown): NormalizedScore;

export function findingKey(text: unknown): string;

export function findingKeys(list: readonly unknown[] | undefined): string[];

export function dedupeFindings(list: readonly string[] | undefined): string[];

export function diffFindings(
  prevKeys: readonly string[] | undefined,
  current: readonly string[] | undefined,
): FindingDiff;

export function lacksPixelGroundedGeometry(harvestSource: string, regionCount: number): boolean;
