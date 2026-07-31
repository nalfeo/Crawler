/**
 * Run artifact layout + writers for the sprite generation pipeline.
 *
 * Every invocation of `generateOne` (or its CLI front-end) produces a
 * directory of artifacts under `generated/runs/<brief-name>/<run-id>/`. The
 * directory layout is the contract between the orchestrator, the CLI's
 * `--pick` flag, and a future Phase 3 lab/UI:
 *
 *   generated/runs/<brief-name>/<run-id>/
 *     run.json               -- metadata: brief id, prompt hash, timestamp, attempt count
 *     sheet-00.png           -- raw multi-variant sheet from the provider (one per attempt)
 *     raw/NN.png             -- raw N-th slice, before postprocessing
 *     processed/NN.png       -- post-processed native-size PNG (typically 64x64)
 *     processed/NN.scorecard.json  -- sensor scorecard for processed/NN.png
 *     processed/NN.anchor.json     -- derived anchor sidecar (only when the brief opts
 *                                     into sensors.anchor.derive and derivation succeeded)
 *     summary.json           -- ranked candidates: passed-first, then by sensor score
 *     selection.json         -- written ONLY when the user runs `sprites:run --pick N`
 *
 * Run IDs are timestamp + short hash so two runs of the same brief are easy
 * to compare and don't collide. The orchestrator is impure (network + IO)
 * so the clock is fine to use here.
 *
 * Symlinks are deliberately NOT used because Windows symlink support is
 * inconsistent. The CLI writes a small JSON manifest instead.
 */

import { createHash } from 'node:crypto';
import type { Brief } from './brief-schema.js';
import type { DiversitySummary } from './diversity.js';
import type { ExpansionSkipReason } from './expand-variations.js';
import type { JudgeScorecard } from './judge.js';
import type { PostprocessOptions } from './postprocess.js';
import type {
  FacingOverride,
  ManualAnchorOverride,
  ManualWeaponAnchorOverride,
} from './postprocess-overrides.js';
import type { Scorecard } from './score-candidate.js';
import type { DerivedAnchor } from './sensors/derive-anchor.js';
import type { SpriteType } from '../../src/shared/sprite-types.js';

export interface RunPaths {
  readonly root: string;
  readonly runId: string;
  readonly briefDir: string;
  readonly rawDir: string;
  readonly processedDir: string;
}

export type JudgeSkipReason = 'judge-disabled' | 'sensor-failed' | 'over-cap' | 'over-budget';

export interface RunSummaryEntry {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  /**
   * Per-sensor breakdown mirrored from the candidate's scorecard so UIs can
   * show exactly which sensor(s) failed without opening extra files.
   */
  readonly breakdown: Scorecard['breakdown'];
  /**
   * Sensor-only passed flag. Reflects the deterministic scorecard. The
   * full pipeline-pass decision (sensor AND judge when judge is enabled)
   * is `combinedPassed` — consumers should rank on that, not on `passed`.
   */
  readonly passed: boolean;
  readonly rawPath: string;
  readonly processedPath: string;
  readonly scorecardPath: string;
  /**
   * Anchor derived by the `anchor-derivable` sensor for this variant. Null
   * when the brief uses the legacy `anchor-opaque` sensor, or when
   * derivation failed.
   */
  readonly derivedAnchor: DerivedAnchor | null;
  readonly derivedAnchors: {
    readonly hold: DerivedAnchor | null;
    readonly centerOfGravity: DerivedAnchor | null;
  };
  /**
   * Path to the per-variant anchor sidecar JSON, when `derivedAnchor` is
   * non-null. Mirrors what gets surfaced in `RunSummary.chosen`.
   */
  readonly anchorSidecarPath: string | null;
  readonly centerOfGravitySidecarPath: string | null;
  /**
   * Path to the per-variant `anchor-overlay.png`: a transparent PNG matching
   * the processed sprite dimensions
   * with one opaque red pixel at the derived anchor, or fully transparent
   * when derivation failed. Always written so the gallery can composite a
   * consistent layer on top of every candidate without special-casing
   * "no anchor". Empty string only on legacy summary.json artifacts
   * produced before this field existed.
   */
  readonly anchorOverlayPath: string;
  /**
   * VLM judge scorecard for this variant, when the brief opted in
   * (`brief.judge.enabled === true`) AND this variant was actually
   * judged. Three reasons this is null:
   *   1. judge disabled — no judging happens
   *   2. judge enabled but this variant failed sensors — we don't waste
   *      vision credits on sensor-failed variants
   *   3. judge enabled but this variant was outside `judge.maxVariants`
   *      after ranking sensor-passing variants by sensor score
   *
   * `judgeSkipReason` disambiguates 2 vs 3 vs null-for-other-reasons so
   * dashboards can explain WHY a variant has no judge verdict.
   */
  readonly judgeScorecard: JudgeScorecard | null;
  /** See `judgeScorecard`. */
  readonly judgeSkipReason: JudgeSkipReason | null;
  /**
   * The pipeline-level pass. With judge disabled, equals `passed`. With
   * judge enabled, requires BOTH `passed` (sensors) AND
   * `judgeScorecard?.passed === true`. Use this for ranking, picking,
   * and the CLI "any passed" check.
   */
  readonly combinedPassed: boolean;
}

/**
 * Source of the anchor surfaced in `RunSummary.chosen.anchor`. `derived`
 * means the `anchor-derivable` sensor produced it from the silhouette;
 * `brief` means it came from the static `brief.anchor` pixel.
 */
export type ChosenAnchorSource = 'manual' | 'derived' | 'brief';

export interface ChosenAnchor {
  readonly x: number;
  readonly y: number;
  readonly source: ChosenAnchorSource;
}

export interface ChosenCandidate {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  readonly passed: boolean;
  /**
   * Anchor for the chosen variant — derived when the brief opted into
   * `sensors.anchor.derive`, otherwise the static `brief.anchor` pixel.
   * Null only if the brief's static anchor is somehow absent (defensive;
   * the schema requires it today).
   */
  readonly anchor: ChosenAnchor | null;
  readonly anchors: {
    readonly hold: ChosenAnchor | null;
    readonly centerOfGravity: ChosenAnchor | null;
  };
  /**
   * Judge scorecard for the chosen variant, when the judge ran. Null
   * means either the brief didn't opt in or this variant wasn't judged
   * (sensor-failed / over the maxVariants cap).
   */
  readonly judgeScorecard: JudgeScorecard | null;
  /**
   * Combined sensor + judge gate result for the chosen variant. True iff
   * sensors passed AND (judge disabled OR judge ran and passed). Mirrored
   * from the underlying `RunSummaryEntry.combinedPassed` so downstream
   * consumers don't need to re-derive the formula (and risk getting the
   * over-cap edge case wrong).
   */
  readonly combinedPassed: boolean;
}

/**
 * A single reference sprite the selector picked to send to the image provider
 * (and, transitively, the judge). Mirrors the manifest entry's identity +
 * quality signals so a rerun/rejudge can re-resolve the exact bytes and
 * fail loudly if the on-disk asset drifted (`contentHash` mismatch).
 */
export interface ReferenceSpriteRef {
  readonly briefId: string;
  readonly spriteName: string;
  readonly type: SpriteType;
  /** Repo-relative under `public/assets/` (always starts with `generated/`). */
  readonly assetPath: string;
  readonly sensorScore: string;
  readonly judgeScore: string | null;
  /** SHA of the asset bytes when the manifest recorded one; null for legacy entries. */
  readonly contentHash: string | null;
}

/**
 * Auditable record of the deterministic reference-sprite selection for a run.
 * Replaces the retired static Kenney `brief.references`: generation now sends
 * our own highest-quality approved sprites, chosen by `selectReferences`.
 */
export interface ReferenceSpriteSelection {
  readonly selectorVersion: string;
  readonly seed: number;
  readonly requestedCount: number;
  /** Eligible candidates after quality-floor + placeholder/self filtering. */
  readonly eligibleCount: number;
  /** Of the eligible candidates, how many shared the brief's `type`. */
  readonly sameTypeCount: number;
  readonly selected: ReadonlyArray<ReferenceSpriteRef>;
}

export interface RunSummary {
  readonly brief: string;
  readonly briefPath: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly promptHash: string;
  readonly attempts: number;
  readonly variantCount: number;
  /**
   * The ACTUAL data-driven sheet grid the slicer landed on at generation time:
   * rows × cols and the empty-cell coordinates. The slicer cuts only at real
   * gutters and trims runt edges, so this reflects what the model actually drew,
   * NOT the brief's commanded grid. Captured so re-postprocess can re-slice the
   * stored sheet anchored on this grid and confirm it reproduces the same
   * structure (rows, cols AND empty-cell set) — a mismatch means the persisted
   * grid no longer matches the sheet and would silently corrupt the row-major
   * per-variant entries. Absent on legacy runs generated before this field
   * existed; consumers fall back to `variantCount` then (and backfill it on the
   * next successful re-run).
   */
  readonly grid?: {
    readonly rows: number;
    readonly cols: number;
    readonly emptyCells: ReadonlyArray<readonly [number, number]>;
  };
  /**
   * Present only when `brief.frameSequence.enabled` — carries the ordered
   * animation-cycle intent from the brief through generation to approval, so
   * `approveFrameSequence` (approve.ts) knows to treat this run's candidates
   * as ORDERED FRAMES of one animation rather than independent design
   * alternatives, and what descriptor to stamp on the manifest entry.
   * Absent (undefined) for every normal (non-sequence) run.
   */
  readonly frameSequence?: {
    readonly frameCount: number;
    readonly frameRate: number;
    readonly loop: boolean;
  };
  /** Candidates ranked best-first: passed first, then by sensor score desc. */
  readonly candidates: ReadonlyArray<RunSummaryEntry>;
  /** Pairwise perceptual-hash diversity across processed variants; null when n < 2. */
  readonly diversity: DiversitySummary | null;
  /**
   * Resolved variations fed into the sheet prompt. Captures both the
   * author seed (so reruns are auditable) and any LLM-proposed
   * additions plus the reason expansion was or wasn't run. Always
   * present so dashboards don't need null-handling.
   */
  readonly variations: {
    readonly seed: ReadonlyArray<string>;
    readonly proposed: ReadonlyArray<string>;
    readonly final: ReadonlyArray<string>;
    readonly minVariations: number;
    readonly skippedReason: ExpansionSkipReason | null;
  };
  /**
   * The top-ranked candidate plus its anchor, lifted out of `candidates` so
   * consumers (CLI summary line, future SpriteDef promotion, lab UI) don't
   * have to re-rank. Null only when there are no candidates at all, which
   * shouldn't happen for a well-formed brief.
   */
  readonly chosen: ChosenCandidate | null;
  /**
   * Cost-tracking snapshot for this run. Null when the judge wasn't
   * enabled (no calls to bill). When present, surfaces both per-run
   * counters and the persisted cross-run totals so reviewers can see
   * how close the batch is to the configured ceiling without opening
   * `generated/.cost-state.json`.
   */
  readonly judgeBudget: {
    readonly budgetUsd: number;
    readonly spentUsd: number;
    readonly remainingUsd: number;
    readonly callCount: number;
    readonly callsThisRun: number;
    readonly callsSkippedDueToBudget: number;
  } | null;
  /**
   * Cache-hit accounting for the judge cache. Null when the judge
   * wasn't enabled. `bypassed` is non-zero when caching was disabled
   * for the run via `--no-judge-cache`.
   */
  readonly judgeCache: {
    readonly hits: number;
    readonly misses: number;
    readonly bypassed: number;
  } | null;
  readonly postprocessOverrides?: {
    readonly profilePath: string | null;
    readonly snapshotJsonPath: string | null;
    readonly snapshotYamlPath: string | null;
    readonly options: PostprocessOptions | null;
    readonly manualAnchor: ManualAnchorOverride | null;
    readonly manualWeaponAnchor: ManualWeaponAnchorOverride | null;
    readonly facing: FacingOverride | null;
    readonly appliedMode: 'default' | 'persisted' | 'replace' | 'reset';
    readonly updatedAt: string | null;
  };
  /**
   * Optional model/deployment IDs attached by orchestrators that perform
   * additional LLM stages (for example issue-originated synth + brief selection).
   */
  readonly modelDeployments?: {
    readonly synth?: string | null;
    readonly briefSelector?: string | null;
    readonly image?: string | null;
    readonly vision?: string | null;
  };
  /**
   * Deterministic reference-sprite selection fed to the image provider (and
   * judge) for this run. Present on runs produced after the Kenney-reference
   * retirement; absent on legacy runs whose refs came from `brief.references`.
   */
  readonly referenceSprites?: ReferenceSpriteSelection;
  /**
   * Optional deterministic sensor telemetry counters for operator dashboards.
   */
  readonly sensorTelemetry?: {
    readonly orientation: {
      readonly failed: number;
      readonly total: number;
    };
  };
}

/** Pure run-id builder. Caller supplies `now` and the prompt so tests are deterministic. */
export function makeRunId(now: Date, prompt: string): string {
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 8);
  return `${ts}-${hash}`;
}

/**
 * Rank candidates with the combined sensor + judge pipeline gate.
 *
 * Three buckets, in priority order:
 *   1. Sensor passed AND combined pipeline passed                  — full pass
 *   2. Sensor passed, combined pipeline failed                     — includes
 *      both judge-failed variants AND sensor-passed-but-not-judged
 *      variants (e.g. `judgeSkipReason: 'over-cap'`). These are
 *      "sensor-good but the full pipeline didn't clear them" and
 *      must rank below bucket 1 so over-cap entries can't sneak
 *      ahead of variants that actually passed the judge gate.
 *   3. Sensor failed (judge never runs on these)                   — reject pile
 *
 * Within bucket 1 (when judge ran), tie on judge `minScore` desc, then
 * sensor score desc, then index asc. Within bucket 1 (judge disabled)
 * and within the other buckets, tie on sensor score desc, then index asc.
 *
 * Pure.
 */
export function rankCandidates(entries: ReadonlyArray<RunSummaryEntry>): RunSummaryEntry[] {
  function bucket(e: RunSummaryEntry): 0 | 1 | 2 {
    if (!e.passed) return 2;
    // Use combinedPassed as the source of truth. Sensor-passed-but-not-judged
    // entries (e.g. judgeSkipReason: 'over-cap') have combinedPassed=false
    // when judging is enabled, so they correctly fall into bucket 1 instead
    // of jumping ahead of variants that actually passed the judge gate.
    if (e.combinedPassed) return 0;
    return 1;
  }
  return [...entries].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Same bucket: prefer higher judge minScore when both have one.
    const ja = a.judgeScorecard?.minScore;
    const jb = b.judgeScorecard?.minScore;
    if (ja !== undefined && jb !== undefined && ja !== jb) return jb - ja;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
}

/**
 * Pick the top-ranked candidate and resolve its anchor:
 *   - In legacy mode (brief did not opt into `sensors.anchor.derive`), the
 *     static `brief.anchor` pixel applies to every variant.
 *   - In derive mode, only a `derivedAnchor` from the variant is a valid
 *     anchor — `brief.anchor` is informational and must not be surfaced.
 *     If derivation failed for the top variant, `anchor` is null so
 *     downstream consumers see the failure instead of a wrong static value.
 *
 * Returns null when `ranked` is empty. Pure.
 *
 * Note: the chosen candidate's `passed` field reflects the SENSOR scorecard
 * only, for backwards compatibility with consumers that pre-date the judge.
 * The combined sensor+judge pipeline-pass for the chosen variant is carried
 * on `chosen.combinedPassed` (mirrored from the underlying entry). Do NOT
 * derive it from `passed && (judgeScorecard?.passed ?? true)` — that
 * formula wrongly treats sensor-passing-but-not-judged variants
 * (`judgeSkipReason: 'over-cap'`) as full pipeline passes. The ranking
 * already puts combined-passing variants first, so when ANY variant
 * passed the full pipeline, `chosen` will be that variant.
 */
export function pickChosen(
  ranked: ReadonlyArray<RunSummaryEntry>,
  brief: Brief,
  manualAnchor: ManualAnchorOverride | null = null,
): ChosenCandidate | null {
  const top = ranked[0];
  if (!top) return null;
  const deriveMode = brief.sensors.anchor?.derive === true;
  const resolvedHold = top.derivedAnchors.hold ?? top.derivedAnchor;
  const holdAnchor: ChosenAnchor | null =
    manualAnchor &&
    (manualAnchor.applyToAllVariants === true || manualAnchor.variantIndex === top.index)
      ? { x: manualAnchor.x, y: manualAnchor.y, source: 'manual' }
      : resolvedHold
        ? { x: resolvedHold.x, y: resolvedHold.y, source: 'derived' }
        : deriveMode
          ? null
          : { x: brief.anchor.x, y: brief.anchor.y, source: 'brief' };
  const centerOfGravityAnchor: ChosenAnchor | null = top.derivedAnchors.centerOfGravity
    ? {
        x: top.derivedAnchors.centerOfGravity.x,
        y: top.derivedAnchors.centerOfGravity.y,
        source: 'derived',
      }
    : holdAnchor
      ? { x: holdAnchor.x, y: holdAnchor.y, source: holdAnchor.source }
      : null;
  return {
    index: top.index,
    score: top.score,
    outOf: top.outOf,
    passed: top.passed,
    anchor: holdAnchor,
    anchors: {
      hold: holdAnchor,
      centerOfGravity: centerOfGravityAnchor,
    },
    judgeScorecard: top.judgeScorecard,
    combinedPassed: top.combinedPassed,
  };
}
