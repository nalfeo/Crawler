#!/usr/bin/env node
/**
 * PURE round-planning + checkpointing for the cloud combo × hill-climb eval
 * pipeline. This is what turns the old ONE-JOB-PER-COMBO coordinate-ascent
 * search (which flattened every round's candidates × weapons × seeds into a
 * single 4-worker task queue, so wall time scaled as totalTasks/4) into a
 * FAN-OUT design: each round's candidates become independent matrix jobs, so
 * wall time per round is bounded by (candidates / concurrency), not by
 * (candidates × weapons × seeds / workers).
 *
 * Three pure operations, mirroring the three round-DAG steps in
 * `.github/workflows/ai-sweep.yml`:
 *
 *   - {@link initCheckpoint}   Wrap a combo's baseline shard (from
 *                              `sweep-eval --stage search-baseline`) into a
 *                              round-0 `RoundCheckpoint`. One per combo.
 *   - {@link planRoundMatrix}  Flatten every still-open combo's next-round
 *                              candidate neighbours into ONE matrix-ready
 *                              list (each entry independently evaluable by
 *                              `sweep-eval --stage search-eval`), capped for
 *                              GitHub Actions matrix safety.
 *   - {@link applyRoundResult} Merge a round's evaluated candidate shards back
 *                              into a combo's checkpoint: adopt the best
 *                              improving candidate, or halve steps toward
 *                              convergence. This IS the checkpoint — every
 *                              round's `RoundCheckpoint` is a complete,
 *                              self-contained artifact, so a downstream
 *                              timeout/failure never discards a prior round's
 *                              progress (the last successfully-uploaded
 *                              checkpoint is always valid input to `validate`).
 *
 * `RoundCheckpoint` is a superset of the legacy `SearchArtifact` shape
 * (`{ meta, combo, bestConfigId, configs, rows }` via {@link toSearchArtifact}),
 * so `sweep-eval --stage validate` needs NO changes to consume it.
 *
 * Deterministic and free of Math.random / Date.now — same discipline as
 * gen-configs.ts / aggregate-shards.ts, which this module is built on top of.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';
import {
  assertMatrixWithinCap,
  baseConfigForCombo,
  comboId,
  configId,
  LEGACY_COMBO_ID,
  knobsForCombo,
  neighbors,
  parseComboId,
  rangeFor,
  SECONDARY_KNOBS,
  type Combo,
  type SweepConfig,
  type TunableKnob,
} from './gen-configs.js';
import { parsePositiveInt, parseSeeds } from './winrate-sweep-args.js';
import {
  assertRowSafeRoomInRange,
  buildLeaderboard,
  isBetterQualifiedCandidate,
  selectQualifiedWinner,
} from './aggregate-shards.js';
import type { LeaderboardRow, RunRow, ShardArtifact, ShardMeta } from './aggregate-shards.js';

/** Σ composite score for one config's rows — the search hill-climb heuristic. */
function totalScoreOf(rows: readonly RunRow[], id: string): number {
  return rows.filter((r) => r.configId === id).reduce((a, r) => a + r.score, 0);
}

/** Dedup/conflict key for a run row: `configId\0weapon\0seed`. */
function makeRowKey(r: RunRow): string {
  return `${r.configId}\u0000${r.weapon}\u0000${r.seed}`;
}

/**
 * Stable (key-order-independent) JSON serialization for config body comparison.
 * Plain `JSON.stringify` can produce different output for two logically-equal
 * objects that were constructed by different code paths with different key
 * insertion orders, causing spurious "conflicting config definition" errors.
 *
 * Exported so `sweep-eval.ts` can reuse it for exact (non-rounded) config-body
 * provenance checks — see `assertLegacyBaselineProvenance`. Unlike `configId()`,
 * this performs no numeric rounding, so it catches sub-4dp tuned drift that a
 * configId-based body comparison would miss.
 */
export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`);
  return `{${sorted.join(',')}}`;
}

export interface SweepLineageArtifact {
  schemaVersion: 1;
  kind: 'resume';
  sourceRunId: number;
}

/**
 * Deterministically materialize the Sweep Results Viewer lineage contract from
 * a workflow-dispatch `resume_run_id` input.
 *
 * Returns `null` for a blank or non-positive-integer input so the workflow can
 * skip emitting/uploading the artifact without changing existing resume-import
 * semantics for malformed values.
 */
export function buildResumeLineageArtifact(
  resumeRunId: string | number | null | undefined,
): SweepLineageArtifact | null {
  if (resumeRunId === null || resumeRunId === undefined) return null;
  const raw = typeof resumeRunId === 'number' ? String(resumeRunId) : resumeRunId.trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return {
    schemaVersion: 1,
    kind: 'resume',
    sourceRunId: parsePositiveInt('--resume-run-id', raw),
  };
}

/**
 * Returns true when two rows for the same key share identical run facts.
 * "Run facts" are all fields that describe the outcome of the simulation run:
 * outcome, officialWin, gameTimeMs, safeRoomMs, score, xp, gold,
 * minHealthPercent, finalLevel.  Identity fields (configId, weapon, seed) are
 * already asserted equal by the caller via the same makeRowKey.  Add any new
 * RunRow result fields here when they are introduced.
 */
function rowFactsMatch(a: RunRow, b: RunRow): boolean {
  return (
    a.outcome === b.outcome &&
    a.officialWin === b.officialWin &&
    a.gameTimeMs === b.gameTimeMs &&
    a.safeRoomMs === b.safeRoomMs &&
    a.score === b.score &&
    a.xp === b.xp &&
    a.gold === b.gold &&
    a.minHealthPercent === b.minHealthPercent &&
    a.finalLevel === b.finalLevel
  );
}

/**
 * Halve every knob's step; return whether any step is still ≥ its minStep
 * (i.e. there is more room to refine). Moved here (out of sweep-eval.ts,
 * unchanged in behaviour) so both the legacy monolithic `--stage search` loop
 * and the new per-round checkpoint advance share one implementation.
 */
export function halveSteps(
  steps: Partial<Record<TunableKnob, number>>,
  knobs: readonly TunableKnob[],
): boolean {
  let anyAboveMin = false;
  for (const knob of knobs) {
    const range = rangeFor(knob);
    const next = (steps[knob] ?? range.step) / 2;
    steps[knob] = next;
    if (next >= range.minStep) {
      anyAboveMin = true;
    }
  }
  return anyAboveMin;
}

/**
 * A combo's full search state after N completed rounds. A superset of the
 * legacy `SearchArtifact` — {@link toSearchArtifact} projects it back down for
 * the unchanged `validate` stage.
 */
export interface RoundCheckpoint {
  meta: ShardMeta;
  combo: string;
  /** Number of rounds folded into this checkpoint so far (0 = baseline only). */
  round: number;
  bestConfigId: string;
  bestScore: number;
  /**
   * The baseline/incumbent config id — set once in {@link initCheckpoint} and
   * NEVER reassigned across rounds (baseline rows are seeded into `rows` at
   * round 0 and never removed). Lets every later round evaluate promotion
   * candidates against the SAME hard safety gate that governs final
   * graduation (`selectQualifiedWinner`: >=90% official wins AND strictly
   * MORE total wins than the incumbent, THEN highest score) instead of
   * promoting on composite score alone — see `applyRoundResult`. Win→loss
   * flips vs the incumbent are allowed as long as total wins still strictly
   * increase (human-approved net-win promotion rule).
   */
  incumbentConfigId: string;
  /**
   * The combo string whose rows contain the incumbent — `LEGACY_COMBO_ID`
   * (`'riskRewardFused+legacy'`) when a `legacyBaseline` was provided in
   * {@link initCheckpoint}, otherwise equal to `combo`. Must be passed to
   * {@link buildLeaderboard} as `incumbentCombo` so flip-gating correctly
   * identifies the incumbent's run rows even for non-incumbent combos.
   */
  incumbentCombo: string;
  /** Current per-knob step size (halves on a round with no improvement). */
  steps: Partial<Record<TunableKnob, number>>;
  /** True once every knob's step has fallen below its minStep — no more candidates. */
  converged: boolean;
  /** Every config evaluated so far (baseline + all candidates across all rounds), keyed by id. */
  configs: Record<string, SweepConfig>;
  /** Every evaluated run across all rounds so far. */
  rows: RunRow[];
  /**
   * The TRAIN seed panel + weapon list + secondary-knobs flag this
   * checkpoint's search has been run against so far — set once in
   * {@link initCheckpoint} and never reassigned across rounds (same
   * lifecycle as `meta`/`incumbentConfigId`). `secondary` is part of this
   * provenance (not just trainSeeds/weapons) because `knobsFor(combo,
   * secondary)` selects a DIFFERENT `TunableKnob[]` set depending on its
   * value — resuming a checkpoint searched under one `secondary` value
   * under a dispatch requesting the other would silently continue a
   * different search space. Optional because checkpoints produced before
   * cross-run resume support never populated it; {@link assertResumeCompatible}
   * falls back to {@link inferRunInputsFromCheckpoint} for such a legacy
   * checkpoint — deriving (never trusting/hard-coding) its implicit
   * trainSeeds/weapons/secondary from the checkpoint's own baseline rows and
   * steps, failing closed if that panel cannot be safely characterized —
   * rather than silently permitting a resume it cannot verify.
   */
  runInputs?: { trainSeeds: string; weapons: string; secondary: boolean };
}

/**
 * Resolve `--mode init`'s optional `--train-seeds`/`--weapons` CLI flags into a
 * `runInputs` provenance record, or `undefined` when the caller supplied
 * neither (producing a legacy-style checkpoint on purpose).
 *
 * `trainSeeds` and `weapons` are a required PAIR — either both are present or
 * neither is. Silently accepting exactly one (e.g. a typo dropping
 * `--weapons`) would produce a checkpoint with no `runInputs` at all, which
 * *looks* like a deliberately-legacy checkpoint but is actually a malformed
 * modern one; every later resume then falls through to
 * {@link inferRunInputsFromCheckpoint}'s legacy inference path instead of the
 * strict modern equality check the caller almost certainly intended. Fail
 * closed instead: reject the one-present/one-missing case before
 * constructing the checkpoint.
 */
export function resolveInitRunInputs(
  trainSeeds: string | null | undefined,
  weapons: string | null | undefined,
  secondary: boolean,
): { trainSeeds: string; weapons: string; secondary: boolean } | undefined {
  if (Boolean(trainSeeds) !== Boolean(weapons)) {
    throw new Error(
      '--mode init requires --train-seeds and --weapons together (both or neither) to record runInputs provenance; supplying only one silently drops both and produces a legacy-style checkpoint',
    );
  }
  return trainSeeds && weapons ? { trainSeeds, weapons, secondary } : undefined;
}

/** Build the round-0 checkpoint from a combo's baseline shard (`--stage search-baseline`).
 *
 * When `legacyBaseline` is provided and the combo is not `riskRewardFused+legacy`, the
 * incumbent config becomes the safety-gate reference (matching the final
 * graduation gate in {@link selectQualifiedWinner}). Without it, the combo's
 * own base config is used, which can allow a flip-tainted candidate to pass the
 * in-search gate while still being rejected at graduation.
 *
 * `runInputs`, when supplied, is stamped onto the checkpoint verbatim and
 * carried through every later round untouched (see `RoundCheckpoint.runInputs`)
 * so a later cross-run resume can verify the TRAIN seed panel, weapon list,
 * AND secondary-knobs flag this checkpoint's search actually ran against.
 */
export function initCheckpoint(
  combo: Combo,
  knobs: readonly TunableKnob[],
  baseline: ShardArtifact,
  legacyBaseline?: ShardArtifact,
  runInputs?: { trainSeeds: string; weapons: string; secondary: boolean },
): RoundCheckpoint {
  const comboStr = comboId(combo);
  const baseIds = Object.keys(baseline.configs);
  const baseId = baseIds[0];
  if (!baseId || baseIds.length !== 1) {
    throw new Error(
      `initCheckpoint(${comboStr}): baseline shard must contain exactly one config, got ${baseIds.length}`,
    );
  }
  const steps: Partial<Record<TunableKnob, number>> = {};
  for (const knob of knobs) {
    steps[knob] = rangeFor(knob).step;
  }

  // Incumbent for the safety gate: use the incumbent (from legacyBaseline)
  // for non-incumbent combos so that the in-search net-win check mirrors the final
  // graduation gate (`selectQualifiedWinner`). For `riskRewardFused+legacy` the combo
  // IS the incumbent, so no separate baseline is needed.
  const comboIsLegacy = comboStr === LEGACY_COMBO_ID;
  let incumbentConfigId = baseId;
  // incumbentCombo tracks which combo string owns the incumbent rows in `rows`.
  // For a non-incumbent combo with a legacyBaseline, the incumbent rows carry
  // `combo: LEGACY_COMBO_ID`, NOT `combo: comboStr` — so buildLeaderboard must
  // be given the correct `incumbentCombo` or it will find no incumbent rows,
  // winsVsIncumbentDelta becomes null, and selectQualifiedWinner disqualifies
  // every candidate (preventing any promotion).
  let incumbentCombo = comboStr;
  const allConfigs: Record<string, SweepConfig> = { ...baseline.configs };
  const allRows: RunRow[] = [...baseline.rows];

  if (!comboIsLegacy && legacyBaseline) {
    const legacyIds = Object.keys(legacyBaseline.configs);
    const legacyId = legacyIds[0];
    if (!legacyId || legacyIds.length !== 1) {
      throw new Error(
        `initCheckpoint(${comboStr}): legacyBaseline shard must contain exactly one config, got ${legacyIds.length}`,
      );
    }
    // The declared config/id must be the CANONICAL incumbent base config — not
    // merely "exactly one config, tagged combo=riskRewardFused+legacy" — because a
    // same-build `--stage search-eval` shard for a *tuned* `riskRewardFused+legacy`
    // candidate also has one config, incumbent-tagged rows, and valid row facts,
    // so it would otherwise pass every check below and silently replace the
    // fixed incumbent with a tuned (non-canonical) incumbent variant.
    const canonicalLegacyConfig = baseConfigForCombo({
      pathing: AIPathingMode.RISK_REWARD_FUSED,
      decision: AIDecisionMode.LEGACY,
    });
    const canonicalLegacyId = configId(canonicalLegacyConfig);
    if (legacyId !== canonicalLegacyId) {
      throw new Error(
        `initCheckpoint(${comboStr}): legacyBaseline shard's declared config must be the ` +
          `canonical incumbent base config (id '${canonicalLegacyId}'), got a tuned/non-canonical ` +
          `config (id '${legacyId}').`,
      );
    }
    // Also verify the stored config BODY is *exactly* the canonical incumbent base
    // config — the key check above catches a mis-keyed artifact, but the body
    // could still carry tuned values if the canonical key string was supplied
    // manually while the config object itself was a tuned variant. Comparing
    // via `configId()` would miss sub-4dp drift: configId() rounds every
    // numeric knob to 4dp (see gen-configs.ts `round4`), so a tuned value like
    // canonical+0.00001 would round to the identical id and slip past an
    // id-based body check while still being a non-canonical runtime config.
    // `stableStringify` performs no rounding, so it catches any body drift,
    // however small.
    const canonicalLegacyBody = stableStringify(canonicalLegacyConfig);
    const storedBody = stableStringify(legacyBaseline.configs[legacyId]!);
    if (storedBody !== canonicalLegacyBody) {
      throw new Error(
        `initCheckpoint(${comboStr}): legacyBaseline shard config body does not match the ` +
          `canonical incumbent base config. Config key '${legacyId}' is correct, but the stored ` +
          `config body's values differ from the untuned canonical incumbent base. The config body ` +
          `must be exactly the canonical incumbent base, not a tuned variant under a ` +
          `canonical-looking key.`,
      );
    }
    const legacyRowCombos = new Set(legacyBaseline.rows.map((r) => r.combo));
    if (legacyRowCombos.size !== 1 || !legacyRowCombos.has(LEGACY_COMBO_ID)) {
      throw new Error(
        `initCheckpoint(${comboStr}): legacyBaseline shard rows must all be tagged combo='${LEGACY_COMBO_ID}', got: ` +
          `${[...legacyRowCombos].join(', ')}.`,
      );
    }
    // Every row must reference the shard's sole config (legacyId), or
    // `buildLeaderboard`'s (incumbentCombo, incumbentConfigId) lookup below
    // finds no incumbent rows at all — silently making the incumbent
    // unfindable and disqualifying EVERY candidate (winsVsIncumbentDelta
    // becomes null for all of them) rather than failing fast here.
    const legacyRowConfigIds = new Set(legacyBaseline.rows.map((r) => r.configId));
    if (legacyRowConfigIds.size !== 1 || !legacyRowConfigIds.has(legacyId)) {
      throw new Error(
        `initCheckpoint(${comboStr}): legacyBaseline shard rows must all reference its sole ` +
          `config '${legacyId}', got: ${[...legacyRowConfigIds].join(', ')}.`,
      );
    }
    // Vet legacyBaseline's provenance against the combo's own baseline shard
    // (which becomes this checkpoint's meta below) — the production
    // round-DAG's equivalent of sweep-eval.ts's assertLegacyBaselineProvenance
    // (the legacy/manual `--stage search` path), so both paths reject a
    // stale/wrong-floor/wrong-build legacyBaseline shard from silently
    // seeding a mis-calibrated incumbent.
    assertShardCompatible(baseline.meta, legacyBaseline, `initCheckpoint(${comboStr})`);
    // Per-row safe-room sanity — mirrors assertLegacyBaselineProvenance's own
    // per-row loop in sweep-eval.ts, so a pre-v2 or malformed legacyBaseline
    // artifact (missing/out-of-range safeRoomMs) cannot silently undercount
    // the incumbent's win classification in the production round-DAG path.
    for (const row of legacyBaseline.rows) {
      assertRowSafeRoomInRange(row);
    }
    incumbentConfigId = legacyId;
    incumbentCombo = LEGACY_COMBO_ID;
    Object.assign(allConfigs, legacyBaseline.configs);
    allRows.push(...legacyBaseline.rows);
  }

  return {
    meta: baseline.meta,
    combo: comboStr,
    round: 0,
    bestConfigId: baseId,
    bestScore: totalScoreOf(baseline.rows, baseId),
    incumbentConfigId,
    incumbentCombo,
    steps,
    converged: false,
    configs: allConfigs,
    rows: allRows,
    ...(runInputs ? { runInputs } : {}),
  };
}

/**
 * Derive the canonical incumbent baseline shard (`{meta, configs, rows}` with
 * EXACTLY the round-0 canonical incumbent config + its rows) from an
 * already-checkpointed `riskRewardFused+legacy` {@link RoundCheckpoint} — used when
 * `riskRewardFused+legacy` itself is cross-run RESUMED (see `resume-import` in
 * `.github/workflows/ai-sweep.yml`), so no fresh `search-baseline-riskRewardFused+legacy`
 * shard is produced by the `baseline` job this run (that job only runs for
 * FRESH combos). Without this, non-incumbent combos initialized fresh this same
 * run would silently fall back to their own base as the in-search incumbent
 * instead of hard-requiring the real incumbent — the exact bug class
 * this workflow elsewhere hard-fails on (see `checkpoint-init`'s incumbent
 * baseline requirement).
 *
 * Safe because `RoundCheckpoint.configs`/`rows` are ADDITIVE-ONLY across
 * rounds (`applyRoundResult` only merges in new entries, never removes) — the
 * original round-0 canonical incumbent config + rows are guaranteed to still be
 * present in a `riskRewardFused+legacy` checkpoint at ANY round. This filters them
 * back out into the exact shard shape {@link initCheckpoint}'s
 * `legacyBaseline` parameter already validates (exactly one config, all rows
 * tagged `combo=riskRewardFused+legacy` referencing that config) — reusing that
 * existing strict provenance check rather than adding a new one.
 */
export function extractLegacyBaselineShard(checkpoint: RoundCheckpoint): ShardArtifact {
  if (checkpoint.combo !== LEGACY_COMBO_ID) {
    throw new Error(
      `extractLegacyBaselineShard: checkpoint combo must be '${LEGACY_COMBO_ID}', got '${checkpoint.combo}'.`,
    );
  }
  const canonicalLegacyConfig = baseConfigForCombo({
    pathing: AIPathingMode.RISK_REWARD_FUSED,
    decision: AIDecisionMode.LEGACY,
  });
  const canonicalLegacyId = configId(canonicalLegacyConfig);
  const canonicalLegacyBody = stableStringify(canonicalLegacyConfig);
  const storedConfig = checkpoint.configs[canonicalLegacyId];
  if (!storedConfig || stableStringify(storedConfig) !== canonicalLegacyBody) {
    throw new Error(
      `extractLegacyBaselineShard(${checkpoint.combo}): checkpoint does not contain the canonical ` +
        `incumbent base config (id '${canonicalLegacyId}') with an exact-matching body — cannot derive ` +
        `a baseline shard from a checkpoint whose round-0 config was never the canonical incumbent base.`,
    );
  }
  const rows = checkpoint.rows.filter(
    (r) => r.combo === LEGACY_COMBO_ID && r.configId === canonicalLegacyId,
  );
  if (rows.length === 0) {
    throw new Error(
      `extractLegacyBaselineShard(${checkpoint.combo}): checkpoint has no rows for the canonical ` +
        `incumbent base config '${canonicalLegacyId}' — cannot derive a baseline shard.`,
    );
  }
  return {
    meta: checkpoint.meta,
    configs: { [canonicalLegacyId]: storedConfig },
    rows,
  };
}

/**
 * Derive a legacy (pre-resume-support) checkpoint's implicit TRAIN seed
 * panel + weapon list + secondary-knobs flag directly from its OWN persisted
 * baseline rows/steps — for checkpoints produced before
 * {@link RoundCheckpoint.runInputs} existed (e.g. cancelled run 29786216369).
 * NEVER trusts or hard-codes any canonical/expected config: every value is
 * derived from, and validated against, THIS checkpoint's own contents, so it
 * works for any legacy checkpoint's actual search space — not just one
 * specific run's hard-coded shape.
 *
 * - `secondary`: `RoundCheckpoint.steps` is populated once in
 *   {@link initCheckpoint} from `knobsFor(combo, secondary)`, whose secondary
 *   portion is always ALL of `SECONDARY_KNOBS` (secondary=true) or NONE of
 *   them (secondary=false) — never a partial subset. This function requires
 *   that same all-or-none shape; any OTHER count fails closed rather than
 *   guessing (a `.some()` check would wrongly treat even ONE stray secondary
 *   key as proof of a full secondary-knobs search). A config BODY can never
 *   be used for this instead —
 *   {@link baseConfigForCombo} always sets every knob, secondary knobs
 *   included, to its SSOT default regardless of `secondary`.
 * - `trainSeeds`/`weapons`: derived from the checkpoint's OWN round-0 base
 *   rows — `combo === checkpoint.combo`, `configId === configId(baseConfigForCombo(parseComboId(checkpoint.combo)))`
 *   — the checkpoint's OWN canonical base config, deliberately NOT
 *   `checkpoint.incumbentCombo`/`incumbentConfigId`. For a non-LEGACY combo
 *   initialized with a `legacyBaseline`, those `incumbent*` fields point at
 *   the SEPARATE LEGACY incumbent (see `initCheckpoint`'s "Incumbent for the
 *   safety gate" branch), not this checkpoint's own search-space rows — a
 *   malformed checkpoint whose own combo was evaluated on a narrow/wrong
 *   panel (e.g. seeds 1-24) while carrying a rectangular LEGACY incumbent
 *   panel (e.g. seeds 1-80) would otherwise have its OWN panel silently
 *   inferred from the LEGACY incumbent's rows instead — accepting it as
 *   1-80 and later mixing incomparable old (1-24) and new (1-80) candidate
 *   totals. Only if those own-combo rows form a COMPLETE, DUPLICATE-FREE,
 *   RECTANGULAR (seed × weapon) panel: every (seed, weapon) pair appears
 *   EXACTLY once, and the row count exactly equals seeds×weapons. A sparse,
 *   duplicated, or ragged panel means this checkpoint's baseline was never a
 *   clean full sweep this function can safely characterize, so it throws
 *   rather than guess.
 * - When a SEPARATE LEGACY incumbent panel is present (non-LEGACY combo +
 *   `legacyBaseline`), it is ALSO derived (same complete/duplicate-free/
 *   rectangular requirement) and compared EXACTLY against the checkpoint's
 *   own panel — the two panels being anything other than identical means
 *   the combo's search and its LEGACY safety-gate incumbent were evaluated
 *   on different train spaces, so results between them are not comparable
 *   and this checkpoint cannot be safely characterized as one train run.
 *
 * Fails closed (throws) on ANY of: no identifiable round-0 rows (own combo OR
 * incumbent), a duplicate (seed, weapon) pair, a non-rectangular row count, or
 * an own-vs-incumbent panel mismatch. Never returns a partial/best-guess
 * result.
 */
export function inferRunInputsFromCheckpoint(checkpoint: RoundCheckpoint): {
  trainSeeds: number[];
  weapons: string[];
  secondary: boolean;
} {
  const contextLabel = `inferRunInputsFromCheckpoint(${checkpoint.combo})`;
  // `.some()` cannot prove the search space: a checkpoint with only ONE
  // surviving secondary key (e.g. a malformed/partial checkpoint) would be
  // treated as secondary=true even though its own step set is not actually a
  // full secondary-knobs search. `initCheckpoint` always seeds `steps` from
  // `knobsFor(combo, secondary)`, which either includes EVERY
  // `SECONDARY_KNOBS` entry (secondary=true) or NONE of them
  // (secondary=false) — there is no shape in between. Require the SAME
  // all-or-none: any OTHER count (1 or 2 of 3 today) is a partial/malformed
  // checkpoint and fails closed rather than guessing.
  const stepKeys = new Set(Object.keys(checkpoint.steps));
  const secondaryKeysPresent = SECONDARY_KNOBS.filter((knob) => stepKeys.has(knob));
  let secondary: boolean;
  if (secondaryKeysPresent.length === 0) {
    secondary = false;
  } else if (secondaryKeysPresent.length === SECONDARY_KNOBS.length) {
    secondary = true;
  } else {
    throw new Error(
      `${contextLabel}: checkpoint.steps has a PARTIAL secondary-knobs key set ` +
        `(${secondaryKeysPresent.length}/${SECONDARY_KNOBS.length}: ` +
        `{${secondaryKeysPresent.join(',')}}) — a real checkpoint always has either ALL of ` +
        `{${SECONDARY_KNOBS.join(',')}} (secondary=true) or NONE of them (secondary=false); ` +
        `cannot prove the secondary-knobs flag from a partial/malformed checkpoint.`,
    );
  }

  // Derive a COMPLETE/DUPLICATE-FREE/RECTANGULAR (seed × weapon) panel from a
  // set of rows, or throw. Shared by both the checkpoint's own panel and (when
  // present) its separate LEGACY incumbent panel, so both are held to the
  // identical proof requirement.
  const derivePanel = (
    rows: readonly RunRow[],
    panelLabel: string,
  ): { trainSeeds: number[]; weapons: string[] } => {
    if (rows.length === 0) {
      throw new Error(
        `${contextLabel}: no round-0 baseline rows found for ${panelLabel} — cannot infer ` +
          `trainSeeds/weapons for a checkpoint with no recorded runInputs.`,
      );
    }
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.seed}\u0000${row.weapon}`;
      if (seen.has(key)) {
        throw new Error(
          `${contextLabel}: duplicate ${panelLabel} row for (seed=${row.seed}, weapon=${row.weapon}) — ` +
            `cannot infer a rectangular panel from a checkpoint with duplicated rows.`,
        );
      }
      seen.add(key);
    }
    const trainSeeds = [...new Set(rows.map((r) => r.seed))].sort((a, b) => a - b);
    const weapons = [...new Set(rows.map((r) => r.weapon))].sort();
    if (rows.length !== trainSeeds.length * weapons.length) {
      throw new Error(
        `${contextLabel}: ${rows.length} ${panelLabel} row(s) do not form a complete rectangular panel ` +
          `of ${trainSeeds.length} seed(s) × ${weapons.length} weapon(s) (expected ` +
          `${trainSeeds.length * weapons.length}) — cannot infer trainSeeds/weapons from an ` +
          `incomplete/ragged panel.`,
      );
    }
    return { trainSeeds, weapons };
  };

  // This checkpoint's OWN canonical round-0 base config id — NEVER
  // `checkpoint.incumbentConfigId`, which for a non-LEGACY combo with a
  // `legacyBaseline` names the separate LEGACY incumbent's config instead
  // (see the docstring above).
  const ownBaseConfigId = configId(baseConfigForCombo(parseComboId(checkpoint.combo)));
  const ownRows = checkpoint.rows.filter(
    (r) => r.combo === checkpoint.combo && r.configId === ownBaseConfigId,
  );
  const { trainSeeds, weapons } = derivePanel(
    ownRows,
    `own base config '${ownBaseConfigId.slice(0, 48)}' (combo '${checkpoint.combo}')`,
  );

  // A non-LEGACY combo initialized with a `legacyBaseline` carries a SEPARATE
  // LEGACY incumbent panel (`incumbentCombo === LEGACY_COMBO_ID !== checkpoint.combo`).
  // Prove it was evaluated on the IDENTICAL train panel as this checkpoint's
  // own combo — otherwise the two are not comparable and this checkpoint's
  // search space cannot be safely characterized as one train run.
  if (checkpoint.incumbentCombo !== checkpoint.combo) {
    const incumbentRows = checkpoint.rows.filter(
      (r) => r.combo === checkpoint.incumbentCombo && r.configId === checkpoint.incumbentConfigId,
    );
    const incumbentPanel = derivePanel(
      incumbentRows,
      `LEGACY incumbent config '${checkpoint.incumbentConfigId.slice(0, 48)}' (combo '${checkpoint.incumbentCombo}')`,
    );
    const sameSeeds =
      incumbentPanel.trainSeeds.length === trainSeeds.length &&
      incumbentPanel.trainSeeds.every((s, i) => s === trainSeeds[i]);
    const sameWeapons =
      incumbentPanel.weapons.length === weapons.length &&
      incumbentPanel.weapons.every((w, i) => w === weapons[i]);
    if (!sameSeeds || !sameWeapons) {
      throw new Error(
        `${contextLabel}: own combo's train panel (seeds [${trainSeeds.join(',')}], weapons ` +
          `[${weapons.join(',')}]) does not match its LEGACY incumbent's train panel (seeds ` +
          `[${incumbentPanel.trainSeeds.join(',')}], weapons [${incumbentPanel.weapons.join(',')}]) — ` +
          `the combo's search and its safety-gate incumbent were evaluated on different train ` +
          `spaces, so this checkpoint cannot be safely characterized as one train run.`,
      );
    }
  }

  return { trainSeeds, weapons, secondary };
}

/**
 * The still-unevaluated neighbour candidates of a checkpoint's current best
 * config. Empty once converged, or once every neighbour at the current step
 * has already been evaluated in an earlier round (coordinate-ascent moving
 * back over already-visited ground).
 *
 * `round`, when supplied, gates cross-run RESUME (not ordinary progression):
 * if `checkpoint.round >= round`, this round's work was already completed by
 * a PRIOR run and imported verbatim (see `resume-import` in
 * `.github/workflows/ai-sweep.yml`), so no new candidates are planned here —
 * `applyRoundResult` correspondingly no-ops this round's `select` step too.
 * Without this guard, a resumed round-2 checkpoint's round-1 `select`/`plan`
 * step would compute a fresh coordinate-ascent step from the CURRENT (already
 * round-2) state and mislabel it as "round 1", silently performing extra,
 * unrequested optimization work beyond `inputs.rounds` instead of continuing
 * only unfinished stages.
 */
export function planCandidates(
  checkpoint: RoundCheckpoint,
  knobs: readonly TunableKnob[],
  round?: number,
): { id: string; config: SweepConfig }[] {
  if (checkpoint.converged) {
    return [];
  }
  if (round !== undefined && checkpoint.round >= round) {
    return [];
  }
  const currentConfig = checkpoint.configs[checkpoint.bestConfigId];
  if (!currentConfig) {
    throw new Error(
      `planCandidates(${checkpoint.combo}): missing config for bestConfigId ${checkpoint.bestConfigId}`,
    );
  }
  const evaluated = new Set(Object.keys(checkpoint.configs));
  return neighbors(currentConfig, knobs, checkpoint.steps)
    .map((config) => ({ id: configId(config), config }))
    .filter((c) => !evaluated.has(c.id));
}

/** One matrix-ready candidate: independently evaluable by `sweep-eval --stage search-eval`. */
export interface FlatCandidate {
  combo: string;
  configId: string;
  config: SweepConfig;
}

export interface CheckpointWithKnobs {
  checkpoint: RoundCheckpoint;
  knobs: readonly TunableKnob[];
}

/**
 * Flatten every still-open combo's next-round candidates into ONE
 * matrix-ready list (mixed across combos — each entry carries its own
 * `combo`), and hard-fail BEFORE any runner spins up if the combined count
 * would exceed a safe GitHub Actions matrix cap (same guard `preflight`
 * already applies to the combo matrix; default cap kept in sync with
 * `assertMatrixWithinCap`'s own default of 200, well under GitHub's hard
 * 256-job matrix limit).
 *
 * `round`, when supplied, is forwarded to {@link planCandidates} so a
 * cross-run-resumed checkpoint already past this round contributes zero
 * candidates instead of silently redoing completed optimization work.
 */
export function planRoundMatrix(
  checkpoints: readonly CheckpointWithKnobs[],
  cap = 200,
  round?: number,
): FlatCandidate[] {
  const out: FlatCandidate[] = [];
  for (const { checkpoint, knobs } of checkpoints) {
    for (const c of planCandidates(checkpoint, knobs, round)) {
      out.push({ combo: checkpoint.combo, configId: c.id, config: c.config });
    }
  }
  if (out.length > 0) {
    assertMatrixWithinCap(out.length, cap);
  }
  return out;
}

/** Fields that must match a checkpoint's own provenance for a candidate shard to be mergeable.
 *
 * Also reused by {@link initCheckpoint} to vet an externally-supplied
 * `legacyBaseline` shard against the combo's own `baseline` shard — this is
 * `round-plan.ts`'s production-round-DAG equivalent of `sweep-eval.ts`'s
 * `assertLegacyBaselineProvenance`/`assertSearchArtifactProvenance` (the
 * legacy/manual `--stage search` path), so both paths reject a
 * stale/wrong-floor/wrong-build shard from silently seeding a
 * mis-calibrated incumbent or corrupting a round's candidate pool — see
 * `assertSearchArtifactProvenance`'s doc comment in `aggregate-shards.ts`
 * for the build-fingerprint rationale.
 */
function assertShardCompatible(
  expectedMeta: ShardMeta,
  shard: ShardArtifact,
  contextLabel: string,
): void {
  if (shard.meta.schemaVersion !== expectedMeta.schemaVersion) {
    throw new Error(
      `${contextLabel}: shard schemaVersion ${shard.meta.schemaVersion} != checkpoint ${expectedMeta.schemaVersion}`,
    );
  }
  if (shard.meta.floorId !== expectedMeta.floorId) {
    throw new Error(
      `${contextLabel}: shard floorId '${shard.meta.floorId}' != checkpoint '${expectedMeta.floorId}'`,
    );
  }
  if (shard.meta.budgetMs !== expectedMeta.budgetMs) {
    throw new Error(
      `${contextLabel}: shard budgetMs ${shard.meta.budgetMs} != checkpoint ${expectedMeta.budgetMs}`,
    );
  }
  if (shard.meta.maxFrames !== expectedMeta.maxFrames) {
    throw new Error(
      `${contextLabel}: shard maxFrames ${shard.meta.maxFrames} != checkpoint ${expectedMeta.maxFrames}`,
    );
  }
  // Rows from a different stage are not comparable and must never be merged —
  // mirrors mergeShards' own stage guard in aggregate-shards.ts.
  if (shard.meta.stage !== expectedMeta.stage) {
    throw new Error(
      `${contextLabel}: shard stage '${shard.meta.stage}' != checkpoint '${expectedMeta.stage}'`,
    );
  }
  // Build-fingerprint checks — mirror mergeShards'/assertSearchArtifactProvenance's
  // per-shard guards so a shard whose schema/floor/budget/frames happen to
  // match, but whose rows were produced by a different code revision or
  // runtime, is still rejected rather than silently trusted.
  if (shard.meta.runnerOs !== expectedMeta.runnerOs) {
    throw new Error(
      `${contextLabel}: shard runner-OS '${shard.meta.runnerOs}' != checkpoint '${expectedMeta.runnerOs}'`,
    );
  }
  if (shard.meta.nodeVersion !== expectedMeta.nodeVersion) {
    throw new Error(
      `${contextLabel}: shard node-version '${shard.meta.nodeVersion}' != checkpoint '${expectedMeta.nodeVersion}'`,
    );
  }
  if (shard.meta.packageLockHash !== expectedMeta.packageLockHash) {
    throw new Error(
      `${contextLabel}: shard package-lock '${shard.meta.packageLockHash}' != checkpoint '${expectedMeta.packageLockHash}'`,
    );
  }
  if (shard.meta.workflowSha !== expectedMeta.workflowSha) {
    throw new Error(
      `${contextLabel}: shard workflow-sha '${shard.meta.workflowSha}' != checkpoint '${expectedMeta.workflowSha}'`,
    );
  }
}

/** A cross-run resume candidate's expected provenance: this run's own runner
 *  calibration (from `sweep-eval --print-meta`) plus its TRAIN seed panel,
 *  weapon list, and secondary-knobs flag — PLUS the combo id and round number
 *  the workflow selected THIS specific checkpoint file for (e.g. from its
 *  `search-checkpoint-r2-<combo>.json` artifact filename). These bind the
 *  payload to the slot the shell script is filling; see `assertResumeCompatible`
 *  docstring for why filename trust alone is insufficient. */
export interface ResumeExpectedProvenance {
  meta: ShardMeta;
  trainSeeds: string;
  weapons: string;
  secondary: boolean;
  combo: string;
  round: number;
}

/**
 * Validate that a checkpoint recovered from a PRIOR workflow run (cross-run
 * `resume_run_id`) is safe to continue in THIS run — must never silently
 * combine incompatible search state. Reuses {@link assertShardCompatible}'s
 * existing schemaVersion/floorId/budgetMs/maxFrames/stage/runnerOs/
 * nodeVersion checks (the exact same guard intra-run candidate shards must
 * already pass — `workflowSha`/`packageLockHash` are neutralized for THIS
 * check specifically, see below), then adds checks that ONLY matter
 * ACROSS separate runs: within one run every job shares one checkout + one
 * runner image, so those fields can never differ — but a PRIOR run may have
 * used a different weapon list or TRAIN seed panel, silently making its
 * scores incomparable with this run's. Fails closed on the FIRST mismatch
 * found (never partially merges an incompatible checkpoint).
 *
 * `workflowSha` (`GITHUB_SHA` at run time — see `ShardMeta`) and
 * `packageLockHash` (a hash of the ENTIRE `package-lock.json`) are
 * deliberately NEUTRALIZED before delegating to `assertShardCompatible` (by
 * copying the checkpoint's own values for both fields into the comparison
 * object), rather than checked for equality. Both drift on ORDINARY repo
 * activity unrelated to the search itself: `workflowSha` changes on every
 * commit to the default branch (including the commit that ships resume
 * support itself), and `packageLockHash` changes on any dependency bump —
 * even a purely transitive/dev-tooling one that never touches simulation
 * code (e.g. run 29786216369's own lockfile differs from a later `main` by
 * a `fast-uri` patch-version bump and a `brace-expansion` dev-marker
 * change — routine Dependabot/npm churn, not a runtime-behavior change). An
 * exact-match check on either would make it structurally impossible to EVER
 * resume a prior run once the workflow file OR the lockfile has since been
 * touched by anything — permanently defeating the one scenario (a
 * runner-starvation cancellation motivating a same-day-or-later resume)
 * this feature exists for. Every OTHER field `assertShardCompatible` checks
 * — schemaVersion/floorId/budgetMs/maxFrames (win-definition + eval
 * parameters), stage, and runnerOs/nodeVersion (runtime provenance) — is
 * still genuinely enforced via that shared function, plus trainSeeds/
 * weapons/secondary (the actual search space, via `runInputs`) below. A
 * source-level game/eval logic change that isn't captured by any of those
 * fields (e.g. a scoring-formula edit that doesn't bump `schemaVersion`, or
 * a dependency bump that DOES change simulation determinism) is a
 * pre-existing, separately-tracked gap in `SHARD_SCHEMA_VERSION` hygiene,
 * not something `workflowSha`/`packageLockHash` equality was actually able
 * to catch reliably either — an unrelated commit anywhere in the repo also
 * changes `GITHUB_SHA`, and an unrelated dev-dependency bump also changes
 * the lockfile hash, so neither field was a precise proxy for "did the
 * ACTUAL simulation-affecting code change" in the first place.
 *
 * LEGACY FALLBACK (checkpoint has no recorded `runInputs`, e.g. a checkpoint
 * produced before cross-run resume support existed — such as cancelled run
 * 29786216369): rather than unconditionally refusing to resume, this derives
 * the checkpoint's implicit trainSeeds/weapons/secondary via
 * {@link inferRunInputsFromCheckpoint} (which itself fails closed on an
 * incomplete/duplicate/non-rectangular baseline panel or an unprovable
 * secondary flag — see its docstring) and compares the SEMANTIC result
 * (parsed seed set / weapon set / boolean) against this run's requested
 * inputs. This is intentionally a set/array comparison, not the raw-string
 * `!==` used for modern checkpoints below — a legacy checkpoint's rows carry
 * no memory of the ORIGINAL request string's exact notation (e.g. `"1-80"`
 * vs an equivalent explicit list), only the actual seeds evaluated, so
 * comparing derived sets is the correct (and only) exact-equality check
 * available. The REQUESTED trainSeeds/weapons strings are themselves
 * rejected outright if they contain a duplicate seed or an empty/duplicate
 * weapon entry — the real evaluator (`sweep-eval.ts`'s `--train-seeds`/
 * `--seeds`/`--weapons` parsing) preserves duplicates verbatim, so silently
 * deduping the request before comparing would accept a request that a FRESH
 * run would NOT execute identically to the imported (duplicate-free)
 * panel. Modern checkpoints (`runInputs` present) are NOT affected — they
 * keep the original strict raw-string equality unchanged.
 *
 * COMBO/ROUND BINDING: none of the checks above ever compare the checkpoint
 * payload itself against the combo/round SLOT the workflow selected it for
 * — the shell script only trusts the `search-checkpoint-${r}-${COMBO}.json`
 * ARTIFACT FILENAME, then renames the parsed JSON. A mislabeled artifact
 * (wrong `checkpoint.combo`, or a `checkpoint.round` that doesn't match the
 * tier being imported) would otherwise pass every check above and either
 * fail confusingly much later, or silently resume MORE completed
 * optimization than the requested tier. `expected.combo`/`expected.round`
 * close this gap: they are checked FIRST, before any other field, so a
 * mislabeled artifact fails fast with an unambiguous error.
 *
 * This same `expected.round` check ALSO doubles as the guard against an
 * INFRA-INCOMPLETE round being mistaken for a genuinely-complete one:
 * `applyRoundResult` deliberately does NOT advance `checkpoint.round` when
 * some of that round's planned candidates never produced a shard (see its
 * doc comment), so a `search-checkpoint-rN-*` artifact whose search never
 * actually finished round N carries an internal `round` strictly LESS than
 * N — failing this check and causing `resume-import`'s tier scan to fall
 * back to the next-older (genuinely complete) tier, rather than silently
 * validating partial round-N search state (found in review, 2026-07-22).
 */
export function assertResumeCompatible(
  checkpoint: RoundCheckpoint,
  expected: ResumeExpectedProvenance,
): void {
  const contextLabel = `assertResumeCompatible(${checkpoint.combo})`;
  if (checkpoint.combo !== expected.combo) {
    throw new Error(
      `${contextLabel}: checkpoint combo '${checkpoint.combo}' != expected combo '${expected.combo}' — ` +
        `this artifact appears mislabeled (imported for the wrong combo).`,
    );
  }
  if (checkpoint.round !== expected.round) {
    throw new Error(
      `${contextLabel}: checkpoint round ${checkpoint.round} != expected round ${expected.round} for ` +
        `the tier being imported — this artifact appears mislabeled (contains more or less completed ` +
        `optimization than the requested tier).`,
    );
  }
  // Reuse the shared shard-compatibility guard for every field EXCEPT
  // workflowSha and packageLockHash, both neutralized by copying the
  // checkpoint's own values into the expected-meta comparison object — see
  // docstring above for why.
  assertShardCompatible(
    {
      ...expected.meta,
      workflowSha: checkpoint.meta.workflowSha,
      packageLockHash: checkpoint.meta.packageLockHash,
    },
    { meta: checkpoint.meta, configs: {}, rows: [] },
    contextLabel,
  );

  if (!checkpoint.runInputs) {
    // Fails closed (throws) if the panel can't be safely characterized —
    // see inferRunInputsFromCheckpoint's docstring for every fail-closed case.
    const inferred = inferRunInputsFromCheckpoint(checkpoint);
    // Requested trainSeeds/weapons must themselves be duplicate-free and
    // non-empty BEFORE comparing against the inferred panel. `parseSeeds`
    // (used by the ACTUAL evaluator, `sweep-eval.ts`'s `--train-seeds`/
    // `--seeds` parsing) preserves duplicates verbatim — a fresh leg
    // requesting e.g. `"1,1,2"` genuinely executes seed 1 TWICE and persists
    // two rows for it. Deduping the REQUESTED string here before comparing
    // would silently accept that request as equivalent to an inferred
    // duplicate-free `[1,2]` panel, even though a fresh run of the same
    // request would NOT produce a matching (duplicate-free) row set — a
    // real, if narrow, correctness gap (found in review). Reject duplicates/
    // empties in the request outright instead of canonicalizing past them;
    // this only affects the LEGACY (no-runInputs) inference path — modern
    // checkpoints below keep exact raw-string equality regardless.
    const parsedSeeds = parseSeeds(expected.trainSeeds);
    const expectedSeeds = [...new Set(parsedSeeds)].sort((a, b) => a - b);
    if (parsedSeeds.length !== expectedSeeds.length) {
      throw new Error(
        `${contextLabel}: requested trainSeeds '${expected.trainSeeds}' contains duplicate seed(s) — ` +
          `legacy-checkpoint resume requires an exact, duplicate-free requested seed set (a fresh run ` +
          `of a duplicate-containing request would execute and persist duplicate rows the imported ` +
          `panel does not have).`,
      );
    }
    const rawWeaponParts = expected.weapons.split(',').map((w) => w.trim());
    if (rawWeaponParts.some((w) => w.length === 0)) {
      throw new Error(
        `${contextLabel}: requested weapons '${expected.weapons}' contains an empty entry ` +
          `(check for stray/doubled commas).`,
      );
    }
    const expectedWeapons = [...new Set(rawWeaponParts)].sort();
    if (expectedWeapons.length !== rawWeaponParts.length) {
      throw new Error(
        `${contextLabel}: requested weapons '${expected.weapons}' contains duplicate weapon(s) — ` +
          `legacy-checkpoint resume requires an exact, duplicate-free requested weapon set.`,
      );
    }
    const seedsMatch =
      inferred.trainSeeds.length === expectedSeeds.length &&
      inferred.trainSeeds.every((s, idx) => s === expectedSeeds[idx]);
    if (!seedsMatch) {
      throw new Error(
        `${contextLabel}: checkpoint has no recorded runInputs — inferred trainSeeds ` +
          `[${inferred.trainSeeds.join(',')}] from its own baseline panel != expected ` +
          `[${expectedSeeds.join(',')}] (from '${expected.trainSeeds}').`,
      );
    }
    const weaponsMatch =
      inferred.weapons.length === expectedWeapons.length &&
      inferred.weapons.every((w, idx) => w === expectedWeapons[idx]);
    if (!weaponsMatch) {
      throw new Error(
        `${contextLabel}: checkpoint has no recorded runInputs — inferred weapons ` +
          `[${inferred.weapons.join(',')}] from its own baseline panel != expected ` +
          `[${expectedWeapons.join(',')}] (from '${expected.weapons}').`,
      );
    }
    if (inferred.secondary !== expected.secondary) {
      throw new Error(
        `${contextLabel}: checkpoint has no recorded runInputs — inferred secondary knobs flag ` +
          `'${inferred.secondary}' (from its own steps) != expected '${expected.secondary}' — resuming ` +
          `would silently continue a DIFFERENT search space.`,
      );
    }
    return;
  }

  if (checkpoint.runInputs.trainSeeds !== expected.trainSeeds) {
    throw new Error(
      `${contextLabel}: checkpoint trainSeeds '${checkpoint.runInputs.trainSeeds}' != expected '${expected.trainSeeds}'`,
    );
  }
  if (checkpoint.runInputs.weapons !== expected.weapons) {
    throw new Error(
      `${contextLabel}: checkpoint weapons '${checkpoint.runInputs.weapons}' != expected '${expected.weapons}'`,
    );
  }
  if (checkpoint.runInputs.secondary !== expected.secondary) {
    throw new Error(
      `${contextLabel}: checkpoint secondary knobs flag '${checkpoint.runInputs.secondary}' != expected '${expected.secondary}' — resuming would silently continue a DIFFERENT search space (knobsFor selects a different TunableKnob[] set per secondary value).`,
    );
  }
}

/**
 * Re-stamp an ACCEPTED cross-run resume checkpoint's `meta.workflowSha` AND
 * `meta.packageLockHash` to THIS run's values. Call this ONLY after
 * {@link assertResumeCompatible} has already returned successfully for
 * `checkpoint` against `expectedMeta` — it performs no compatibility checks
 * of its own.
 *
 * `assertResumeCompatible` intentionally neutralizes BOTH fields for the
 * compatibility CHECK itself (see its docstring) so a prior run's checkpoint
 * isn't rejected purely because the workflow file or the lockfile has since
 * been touched. But the checkpoint OBJECT must not keep carrying the PRIOR
 * run's values forward once accepted: every later round in THIS SAME run
 * compares shards against THIS run's `meta` via the ordinary (non-resume)
 * `assertShardCompatible` path — `applyRoundResult`'s round-N shard check and
 * `aggregate-shards.ts`'s validate-stage provenance check both do exact
 * `workflowSha`/`packageLockHash` `!==` comparisons with no resume-awareness.
 * Without this re-stamp, an accepted resumed checkpoint would fail those
 * checks one round after import, silently defeating the whole feature for
 * exactly the artifacts it exists to recover.
 */
export function normalizeResumedCheckpoint(
  checkpoint: RoundCheckpoint,
  expectedMeta: ShardMeta,
): RoundCheckpoint {
  if (
    checkpoint.meta.workflowSha === expectedMeta.workflowSha &&
    checkpoint.meta.packageLockHash === expectedMeta.packageLockHash
  ) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    meta: {
      ...checkpoint.meta,
      workflowSha: expectedMeta.workflowSha,
      packageLockHash: expectedMeta.packageLockHash,
    },
  };
}

/**
 * Merge this round's evaluated candidate shards into a combo's checkpoint and
 * advance the search: promote the highest-scoring candidate that ALSO passes
 * the approved hard safety gate (>=90% official wins AND strictly MORE total
 * wins than the incumbent — the same {@link selectQualifiedWinner} gate that
 * governs final graduation in `aggregate-shards.ts`), or — when nothing
 * qualifying improved — halve the step sizes and mark `converged` once every
 * knob's step has fallen below its minStep.
 *
 * This is the round-plan half of the fix for the real bug the 2026-07 untuned
 * graduation run (GitHub run 29597840666) exposed: a config can out-score the
 * incumbent while quietly flipping incumbent wins into losses, and a
 * score-only hill-climb would happily chase that config round after round.
 * Per the human-approved net-win promotion rule, such flips are now ALLOWED
 * when the candidate's absolute total wins still strictly exceed the
 * incumbent's (e.g. 292/300 candidate vs 286/300 incumbent, 5 flips —
 * qualifies); a candidate whose total wins tie or fall below the incumbent's
 * is still rejected regardless of flips or score. Gating promotion on
 * `selectQualifiedWinner` means the search's own trajectory can never walk
 * toward (or settle on) a config the final gate would reject.
 *
 * `options.plannedCount` (when supplied) lets the caller distinguish "this
 * round genuinely produced fewer/no improving candidates" (a real search
 * dead-end — halve steps, converge if at the floor) from "some of this
 * round's PLANNED candidates never produced a shard at all" (an infra
 * failure — a matrix leg failed or was cancelled). In the infra-failure case
 * we deliberately do NOT halve/converge: `planCandidates` re-derives the
 * SAME neighbour set from `checkpoint.configs` next round (the missing
 * candidate's config was never absorbed), so leaving `steps`/`converged`
 * untouched simply retries the same candidates rather than falsely recording
 * "the algorithm learned there's no improvement here" from partial data.
 * Legacy/test callers that omit `plannedCount` keep the original
 * always-halve-on-no-improvement behaviour.
 *
 * `options.plannedCount === 'unknown'` is a DISTINCT sentinel from `0`:
 * `0` means "the planner ran successfully and legitimately decided this
 * combo needed no new candidates" (already converged — halving is correct),
 * while `'unknown'` means "the planner job itself never produced a
 * candidates manifest at all" (e.g. `roundN-candidates` crashed before
 * uploading its artifact) — we cannot tell whether 0 or N candidates were
 * planned for this combo, so we must NOT infer convergence from that
 * silence. `'unknown'` always forces the infra-failure (no halve/converge)
 * path, regardless of `candidateShards.length`.
 *
 * The returned checkpoint's `round` field is likewise NOT advanced to this
 * call's `round` argument when the round is infra-incomplete — it stays at
 * whatever value it already had. `checkpoint.round` doubles as a
 * proven-complete marker that cross-run resume strictly equality-checks
 * against the artifact's filename-implied tier (`assertResumeCompatible`);
 * see the `round:` field comment in the return statement below for the full
 * rationale (found in review — an infra-incomplete round's checkpoint was
 * otherwise silently accepted as a genuinely-complete `rN` tier by a resumed
 * run, permanently abandoning that round's never-evaluated candidates).
 */
export function applyRoundResult(
  checkpoint: RoundCheckpoint,
  round: number,
  knobs: readonly TunableKnob[],
  candidateShards: readonly ShardArtifact[],
  options: { plannedCount?: number | 'unknown' } = {},
): RoundCheckpoint {
  // Idempotent no-op once converged. `planCandidates` never plans anything
  // for a converged checkpoint, so a converged combo should never see
  // non-empty candidateShards here either; short-circuiting avoids
  // repeatedly halving an already-minimal step size on every remaining
  // bounded round (harmless numerically, but confusing to read/debug).
  // `Math.max(round, checkpoint.round)` (here and below) guards a cross-run
  // RESUMED checkpoint: it already has a higher `round` than this call's
  // `round` argument, and must never be relabelled backward.
  if (checkpoint.converged) {
    return { ...checkpoint, round: Math.max(round, checkpoint.round) };
  }
  // Idempotent no-op for a round a cross-run resume already completed:
  // `planCandidates(checkpoint, knobs, round)` correspondingly plans nothing
  // for this round on this checkpoint, so there is nothing to merge — return
  // unchanged (preserving the checkpoint's true, further-along round) rather
  // than silently performing extra, unrequested optimization work beyond
  // what `inputs.rounds` asked for.
  if (checkpoint.round >= round && candidateShards.length === 0) {
    return checkpoint;
  }

  const configs = { ...checkpoint.configs };
  const rows = [...checkpoint.rows];
  const seenRows = new Map<string, RunRow>(rows.map((r) => [makeRowKey(r), r]));
  const newCandidateIds = new Set<string>();

  for (const shard of candidateShards) {
    assertShardCompatible(checkpoint.meta, shard, `applyRoundResult(${checkpoint.combo})`);
    for (const [id, config] of Object.entries(shard.configs)) {
      const existing = configs[id];
      if (existing && stableStringify(existing) !== stableStringify(config)) {
        throw new Error(
          `applyRoundResult(${checkpoint.combo}): conflicting config definition for id ${id} — determinism violation across shards.`,
        );
      }
      configs[id] = config;
      newCandidateIds.add(id);
    }
    for (const r of shard.rows) {
      const key = makeRowKey(r);
      const existing = seenRows.get(key);
      if (existing !== undefined) {
        if (!rowFactsMatch(existing, r)) {
          throw new Error(
            `applyRoundResult(${checkpoint.combo}): conflicting run result for key ${key} — determinism violation across shards.`,
          );
        }
        continue; // benign identical duplicate — skip
      }
      seenRows.set(key, r);
      rows.push(r);
      newCandidateIds.add(r.configId);
    }
  }

  const leaderboard = buildLeaderboard(rows, {
    incumbentCombo: checkpoint.incumbentCombo,
    incumbentConfigId: checkpoint.incumbentConfigId,
    configs,
    budgetMs: checkpoint.meta.budgetMs,
  });
  const newCandidateRows = leaderboard.filter(
    (r) => newCandidateIds.has(r.configId) && !r.isIncumbent,
  );
  const { winner: qualifiedWinner } = selectQualifiedWinner(newCandidateRows);

  // Determine round incompleteness BEFORE promotion: if some planned candidates
  // never produced a shard (infra failure), do not promote even when an arrived
  // shard qualifies — the missing shard might have been even better, and
  // promoting now changes `bestConfigId`, causing `planCandidates` to derive a
  // different neighbour set next round and permanently skip the missing candidate.
  // Instead, leave `bestConfigId`/`bestScore`/`steps`/`converged` untouched so
  // the same neighbour set is retried next round (the arrived data is still
  // merged in, so duplicate rows will be deduped on the next attempt).
  let infraIncomplete: boolean;
  if (options.plannedCount === 'unknown') {
    // The planner job never produced a candidates manifest at all — cannot tell
    // whether 0 or N candidates were planned, so always treat as infra failure.
    infraIncomplete = true;
  } else if (options.plannedCount !== undefined) {
    const missing = Math.max(0, options.plannedCount - candidateShards.length);
    infraIncomplete = options.plannedCount > 0 && missing > 0;
  } else {
    infraIncomplete = false;
  }

  let bestId = checkpoint.bestConfigId;
  let bestScore = checkpoint.bestScore;
  if (!infraIncomplete) {
    const bestRow: LeaderboardRow | undefined = leaderboard.find((r) => r.configId === bestId);
    if (qualifiedWinner && isBetterQualifiedCandidate(qualifiedWinner, bestRow)) {
      bestId = qualifiedWinner.configId;
      bestScore = qualifiedWinner.totalScore;
    }
  }
  const improved = bestId !== checkpoint.bestConfigId;

  const steps = { ...checkpoint.steps };
  let converged: boolean = checkpoint.converged;
  if (!improved) {
    if (!infraIncomplete) {
      converged = !halveSteps(steps, knobs);
    }
    // else: infra failure with incomplete/unknown data this round — leave
    // steps/converged untouched so the same neighbours are retried.
  }

  return {
    ...checkpoint,
    // Do NOT advance `round` on an infra-incomplete round: `checkpoint.round`
    // doubles as this checkpoint's PROVEN-complete tier — the exact value
    // `assertResumeCompatible` strict-equality-checks against the artifact's
    // filename-implied tier (`checkpoint.round !== expected.round`, see its
    // COMBO/ROUND BINDING doc). Bumping it here even when some of this
    // round's planned candidates never produced a shard would let a
    // cross-run resume accept a `search-checkpoint-rN-*` artifact whose
    // internal state never actually finished round N's search (bestConfigId/
    // steps/converged were deliberately left at round N-1's values just
    // above) — the missing candidates would then be silently abandoned
    // forever: `planCandidates`'s `checkpoint.round >= round` resume-gate
    // would treat round N as already done for any NEW dispatch requesting
    // exactly `rounds=N` (see `resume-import` in ai-sweep.yml), so validation
    // would run directly against round N's incomplete state without ever
    // retrying the missing candidates. Leaving `round` at its prior
    // (genuinely-complete) value instead makes THIS artifact fail
    // `assertResumeCompatible`'s existing combo/round check for the `rN`
    // slot it was uploaded under, so `resume-import`'s tier scan falls back
    // to the next-older (still real) tier — reusing that mislabeling guard
    // rather than adding a new field. Ordinary same-run progression is
    // unaffected: every OTHER `checkpoint.round` use site is a `>=`
    // comparison (never strict `===`), so a "round skips ahead" once a LATER
    // round genuinely completes is harmless there, and `planCandidates`
    // naturally re-offers the still-unevaluated neighbours (frozen
    // best/steps mean the same neighbour set is recomputed, filtered only by
    // what has actually been merged into `configs` so far) — found in
    // review (2026-07-22).
    round: infraIncomplete ? checkpoint.round : Math.max(round, checkpoint.round),
    bestConfigId: bestId,
    bestScore,
    steps,
    converged,
    configs,
    rows,
  };
}

/** Legacy `SearchArtifact` shape the unchanged `validate` stage consumes. */
export interface SearchArtifactLike {
  meta: ShardMeta;
  combo: string;
  bestConfigId: string;
  configs: Record<string, SweepConfig>;
  rows: RunRow[];
}

/** Project a checkpoint down to the legacy `SearchArtifact` shape — pure reshape, no data loss to `validate`. */
export function toSearchArtifact(checkpoint: RoundCheckpoint): SearchArtifactLike {
  return {
    meta: checkpoint.meta,
    combo: checkpoint.combo,
    bestConfigId: checkpoint.bestConfigId,
    configs: checkpoint.configs,
    rows: checkpoint.rows,
  };
}

// ---------------------------------------------------------------------------
// CLI (guarded so importing this module for its pure helpers never runs it).
// Six modes mirror the round-DAG workflow steps (init/plan/select) plus the
// cross-run resume compatibility check, legacy-baseline extraction, and the
// additive sweep-lineage viewer contract:
//   --mode init   <combo> --baseline <shard.json> [--secondary] [--train-seeds <str> --weapons <str>] --out <checkpoint.json>
//   --mode plan   --round N [--secondary] [--cap N] --out <matrix.json> <checkpoint.json...>
//   --mode select --round N [--secondary] [--planned-count N|unknown] --checkpoint <checkpoint.json> --out <checkpoint.json> [<shard.json...>]
//   --mode resume-check --checkpoint <checkpoint.json> --expect-meta <meta.json> --combo <id> --round <N> [--expect-train-seeds <str>] [--expect-weapons <str>] [--expect-secondary] [--out <checkpoint.json>]
//   --mode extract-legacy-baseline --checkpoint <checkpoint.json> --out <shard.json>
//   --mode emit-resume-lineage [--resume-run-id <id>] --out <lineage.json>
// ---------------------------------------------------------------------------

function knobsFor(comboStr: string, secondary: boolean): TunableKnob[] {
  return knobsForCombo(parseComboId(comboStr), secondary);
}

interface CliArgs {
  mode:
    | 'init'
    | 'plan'
    | 'select'
    | 'resume-check'
    | 'extract-legacy-baseline'
    | 'emit-resume-lineage'
    | null;
  combo: string | null;
  baseline: string | null;
  legacyBaseline: string | null;
  checkpoint: string | null;
  round: number | null;
  secondary: boolean;
  cap: number;
  plannedCount: number | 'unknown' | null;
  out: string | null;
  files: string[];
  /** `--mode init` only: TRAIN seed panel + weapon list to stamp onto the new
   *  checkpoint's `runInputs` (both required together — see initCheckpoint). */
  trainSeeds: string | null;
  weapons: string | null;
  /** `--mode resume-check` only. */
  expectMeta: string | null;
  expectTrainSeeds: string | null;
  expectWeapons: string | null;
  expectSecondary: boolean;
  resumeRunId: string | null;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    mode: null,
    combo: null,
    baseline: null,
    legacyBaseline: null,
    checkpoint: null,
    round: null,
    secondary: false,
    cap: 200,
    plannedCount: null,
    out: null,
    files: [],
    trainSeeds: null,
    weapons: null,
    expectMeta: null,
    expectTrainSeeds: null,
    expectWeapons: null,
    expectSecondary: false,
    resumeRunId: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    if (arg === '--mode' && next) {
      if (
        next !== 'init' &&
        next !== 'plan' &&
        next !== 'select' &&
        next !== 'resume-check' &&
        next !== 'extract-legacy-baseline' &&
        next !== 'emit-resume-lineage'
      ) {
        throw new Error(
          `--mode must be init|plan|select|resume-check|extract-legacy-baseline|emit-resume-lineage, got ${JSON.stringify(next)}`,
        );
      }
      args.mode = next;
      i++;
    } else if (arg === '--combo' && next) {
      args.combo = next;
      i++;
    } else if (arg === '--baseline' && next) {
      args.baseline = next;
      i++;
    } else if (arg === '--legacy-baseline' && next) {
      args.legacyBaseline = next;
      i++;
    } else if (arg === '--checkpoint' && next) {
      args.checkpoint = next;
      i++;
    } else if (arg === '--round' && next) {
      args.round = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--secondary') {
      args.secondary = true;
    } else if (arg === '--cap' && next) {
      args.cap = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--planned-count' && next) {
      args.plannedCount = next === 'unknown' ? 'unknown' : Number.parseInt(next, 10);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (arg === '--train-seeds' && next) {
      args.trainSeeds = next;
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next;
      i++;
    } else if (arg === '--expect-meta' && next) {
      args.expectMeta = next;
      i++;
    } else if (arg === '--expect-train-seeds' && next) {
      args.expectTrainSeeds = next;
      i++;
    } else if (arg === '--expect-weapons' && next) {
      args.expectWeapons = next;
      i++;
    } else if (arg === '--expect-secondary') {
      args.expectSecondary = true;
    } else if (arg === '--resume-run-id' && next) {
      args.resumeRunId = next;
      i++;
    } else if (!arg.startsWith('--')) {
      args.files.push(arg);
    }
  }
  return args;
}

function emit(value: unknown, out: string | null): void {
  const json = JSON.stringify(value, null, 2);
  if (out) {
    writeFileSync(out, json);
    console.log(`💾 ${out}`);
  } else {
    console.log(json);
  }
}

function runCli(argv: readonly string[]): void {
  const args = parseCliArgs(argv);
  if (!args.mode) {
    console.error(
      'Usage: ai:round-plan --mode init|plan|select|resume-check|extract-legacy-baseline|emit-resume-lineage ... (see round-plan.ts header for per-mode flags)',
    );
    process.exit(1);
    return;
  }

  if (args.mode === 'init') {
    if (!args.combo || !args.baseline) {
      throw new Error('--mode init requires --combo <id> --baseline <shard.json>');
    }
    const combo = parseComboId(args.combo);
    const knobs = knobsFor(args.combo, args.secondary);
    const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as ShardArtifact;
    const legacyBaseline = args.legacyBaseline
      ? (JSON.parse(readFileSync(args.legacyBaseline, 'utf8')) as ShardArtifact)
      : undefined;
    const runInputs = resolveInitRunInputs(args.trainSeeds, args.weapons, args.secondary);
    const checkpoint = initCheckpoint(combo, knobs, baseline, legacyBaseline, runInputs);
    const incumbentNote =
      checkpoint.incumbentConfigId !== checkpoint.bestConfigId
        ? ` (incumbent=${checkpoint.incumbentConfigId.slice(0, 48)})`
        : '';
    console.log(
      `[${checkpoint.combo}] round 0 checkpoint: best=${checkpoint.bestConfigId.slice(0, 48)} score=${checkpoint.bestScore.toExponential(3)}${incumbentNote}`,
    );
    emit(checkpoint, args.out);
    return;
  }

  if (args.mode === 'plan') {
    if (args.round === null) {
      throw new Error('--mode plan requires --round N');
    }
    if (args.files.length === 0) {
      throw new Error('--mode plan requires one or more checkpoint JSON files as positional args');
    }
    const inputs: CheckpointWithKnobs[] = args.files.map((f) => {
      const checkpoint = JSON.parse(readFileSync(f, 'utf8')) as RoundCheckpoint;
      return { checkpoint, knobs: knobsFor(checkpoint.combo, args.secondary) };
    });
    const candidates = planRoundMatrix(inputs, args.cap, args.round);
    const hasCandidates = candidates.length > 0;
    const byCombo = new Map<string, number>();
    for (const c of candidates) {
      byCombo.set(c.combo, (byCombo.get(c.combo) ?? 0) + 1);
    }
    console.log(
      `Round ${args.round}: ${candidates.length} candidate(s) across ${inputs.length} checkpoint(s)` +
        (hasCandidates
          ? ` — ${[...byCombo.entries()].map(([c, n]) => `${c}:${n}`).join(', ')}`
          : ' — all converged, nothing to evaluate this round.'),
    );
    emit({ round: args.round, hasCandidates, candidates }, args.out);
    return;
  }

  if (args.mode === 'resume-check') {
    if (!args.checkpoint || !args.expectMeta || !args.combo || args.round === null) {
      throw new Error(
        '--mode resume-check requires --checkpoint <checkpoint.json> --expect-meta <meta.json> ' +
          '--combo <id> --round <N> (the combo/round SLOT this checkpoint file is being imported ' +
          'for — see assertResumeCompatible docstring for why filename trust alone is insufficient)',
      );
    }
    const checkpoint = JSON.parse(readFileSync(args.checkpoint, 'utf8')) as RoundCheckpoint;
    const meta = JSON.parse(readFileSync(args.expectMeta, 'utf8')) as ShardMeta;
    if (!checkpoint.runInputs) {
      console.warn(
        `⚠️  [${checkpoint.combo}] checkpoint has no recorded runInputs (pre-resume-support ` +
          `checkpoint) — inferring trainSeeds/weapons/secondary from its own baseline panel ` +
          `instead of trusting recorded provenance; failing closed if that panel is not a ` +
          `complete, duplicate-free, rectangular seed×weapon sweep.`,
      );
    }
    assertResumeCompatible(checkpoint, {
      meta,
      trainSeeds: args.expectTrainSeeds ?? '',
      weapons: args.expectWeapons ?? '',
      secondary: args.expectSecondary,
      combo: args.combo,
      round: args.round,
    });
    console.log(
      `[${checkpoint.combo}] resume-compatible: round ${checkpoint.round} checkpoint may be reused (best=${checkpoint.bestConfigId.slice(0, 48)} score=${checkpoint.bestScore.toExponential(3)})`,
    );
    // Re-stamp `meta.workflowSha` to THIS run's value before the accepted
    // checkpoint re-enters the round-DAG — see normalizeResumedCheckpoint's
    // docstring for why the raw prior-run checkpoint must never be copied
    // through unchanged.
    if (args.out) {
      emit(normalizeResumedCheckpoint(checkpoint, meta), args.out);
    }
    return;
  }

  if (args.mode === 'extract-legacy-baseline') {
    if (!args.checkpoint) {
      throw new Error('--mode extract-legacy-baseline requires --checkpoint <checkpoint.json>');
    }
    const checkpoint = JSON.parse(readFileSync(args.checkpoint, 'utf8')) as RoundCheckpoint;
    const shard = extractLegacyBaselineShard(checkpoint);
    console.log(
      `[${checkpoint.combo}] extracted legacy baseline shard: ${shard.rows.length} row(s) for config ${Object.keys(shard.configs)[0]?.slice(0, 48)}`,
    );
    emit(shard, args.out);
    return;
  }

  if (args.mode === 'emit-resume-lineage') {
    const lineage = buildResumeLineageArtifact(args.resumeRunId);
    if (!lineage) {
      console.log(
        'No resume lineage artifact emitted (resume_run_id is blank or not a positive integer).',
      );
      return;
    }
    console.log(`[resume] lineage source run ${lineage.sourceRunId}`);
    emit(lineage, args.out);
    return;
  }

  // select
  if (args.round === null) {
    throw new Error('--mode select requires --round N');
  }
  if (!args.checkpoint) {
    throw new Error('--mode select requires --checkpoint <checkpoint.json>');
  }
  const checkpoint = JSON.parse(readFileSync(args.checkpoint, 'utf8')) as RoundCheckpoint;
  const knobs = knobsFor(checkpoint.combo, args.secondary);
  const shards = args.files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ShardArtifact);
  const updated = applyRoundResult(checkpoint, args.round, knobs, shards, {
    plannedCount: args.plannedCount ?? undefined,
  });
  const improved = updated.bestConfigId !== checkpoint.bestConfigId;
  console.log(
    `[${updated.combo}] round ${args.round}: merged ${shards.length} shard(s) — ` +
      (improved
        ? `✅ ${checkpoint.bestScore.toExponential(3)} → ${updated.bestScore.toExponential(3)} via ${updated.bestConfigId.slice(0, 48)}`
        : updated.converged
          ? 'no improvement, steps at min — converged.'
          : 'no improvement — halved steps.'),
  );
  emit(updated, args.out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
