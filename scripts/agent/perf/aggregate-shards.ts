#!/usr/bin/env node
/**
 * PURE fan-in aggregation for the cloud combo × hill-climb eval pipeline.
 *
 * Each cloud shard uploads a JSON artifact of per-RUN rows (one row per
 * combo×config×weapon×seed) plus provenance metadata. This module merges those
 * artifacts into a leaderboard the S4 decision packet is built from. It is the
 * trust boundary of the whole pipeline, so it is deliberately paranoid:
 *
 *   - It RECOMPUTES every total from the per-run rows — it never trusts a
 *     shard-reported sum (a shard could be buggy or partial).
 *   - It REJECTS conflicting duplicates: the same (combo,config,weapon,seed) with
 *     differing facts is a determinism violation and throws. Identical duplicates
 *     are collapsed (they double as a cross-shard determinism proof).
 *   - It REJECTS provenance mismatch: differing schema version / win budget /
 *     frame budget across shards means the rows aren't comparable and throws.
 *   - It can REJECT missing coverage against an expected manifest.
 *
 * It produces BOTH orderings the plan requires: the composite-score ordering
 * (the user's stated "highest total score" metric, the headline) AND a
 * win-count-first lexicographic ordering, and flags when they disagree so the
 * human sees the divergence before the S5 flip. It also carries the existing A/B
 * safety contract forward as explicit columns: win→loss flips vs the LEGACY
 * incumbent and the aggregate win-rate delta.
 *
 * Deterministic and free of Math.random / Date.now.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunStats } from '../../../src/game/ai/types.js';
import { scoreRun, isOfficialWin, SAFE_ROOM_FLAG_MS } from '../../../src/game/ai/scoring.js';
import type { SweepConfig } from './gen-configs.js';

/** Current shard-artifact schema version. Bump on any breaking row/meta change. */
export const SHARD_SCHEMA_VERSION = 2;

/** One evaluated headless run. `officialWin` is the SSOT tournament win. */
export interface RunRow {
  combo: string;
  configId: string;
  weapon: string;
  seed: number;
  outcome: RunStats['outcome'];
  officialWin: boolean;
  gameTimeMs: number;
  /** Safe-room dwell (ms); collapse deadline pauses here, so it is excluded
   *  from the active time behind {@link deriveRunFacts}'s official-win check. */
  safeRoomMs: number;
  score: number;
  xp: number;
  gold: number;
  minHealthPercent: number;
  finalLevel: number;
}

/** The subset of RunStats the SSOT scorer reads. The producer (sweep-eval) and
 *  this fan-in verifier both derive a row's facts through {@link deriveRunFacts},
 *  so a row's (officialWin, score) can never drift between the two. */
export type ScorableStats = Pick<
  RunStats,
  'outcome' | 'gameTimeMs' | 'safeRoomMs' | 'totalXp' | 'totalGold' | 'finalLevel'
>;

/**
 * Derive the SSOT tournament facts for one run: whether it is an official win (a
 * victory whose safe-room-credited active time is within the budget) and its
 * composite score. An OVER-BUDGET victory is the only outcome downgraded —
 * scored as a timeout to strip its victory/time bonus; deaths and timeouts keep
 * their real outcome so a future death penalty in scoreRun is never masked.
 * Scoring stays on RAW gameTimeMs (see scoreRun) so the search gradient never
 * rewards idling in a safe room. Deterministic.
 *
 * PRECONDITION: Floor-1 runs only. The safe-room active-time credit inside
 * `isOfficialWin` is a Floor-1 mechanic (the collapse deadline only pauses in
 * Floor-1 safe rooms) and `budgetMs` is always the Floor-1 budget. This is
 * enforced at BOTH boundaries — sweep-eval rejects `--floor` != floor1 and
 * mergeShards rejects a non-floor1 shard — so a non-Floor-1 run can never reach
 * here to be misclassified with Floor-1 win semantics.
 */
export function deriveRunFacts(
  stats: ScorableStats,
  budgetMs: number,
): { officialWin: boolean; score: number } {
  const officialWin = isOfficialWin(stats, budgetMs);
  const statsForScore: ScorableStats =
    stats.outcome === 'victory' && !officialWin ? { ...stats, outcome: 'timeout' } : stats;
  const { score } = scoreRun(statsForScore as RunStats, budgetMs);
  return { officialWin, score };
}

/** Provenance recorded on every shard so cross-runner comparability is auditable. */
export interface ShardMeta {
  schemaVersion: number;
  /** SSOT win budget in ms (FLOOR1_TIME_BUDGET_MS). */
  budgetMs: number;
  /** The floor these runs were produced on. Only `floor1` carries the safe-room
   *  active-time credit that {@link deriveRunFacts}/`isOfficialWin` apply, so a
   *  non-floor1 batch is rejected rather than misclassified with Floor-1 win
   *  semantics. */
  floorId: string;
  /** Frame budget the runs used (slack budget). */
  maxFrames: number;
  stage: string;
  runnerOs: string;
  nodeVersion: string;
  packageLockHash: string;
  workflowSha: string;
}

export interface ShardArtifact {
  meta: ShardMeta;
  /** Config definitions referenced by `rows`, keyed by configId. */
  configs: Record<string, SweepConfig>;
  rows: RunRow[];
}

/** Identity of a single run within the tournament. */
function rowKey(row: Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>): string {
  return `${row.combo}\u0000${row.configId}\u0000${row.weapon}\u0000${row.seed}`;
}

/** The fields that must be identical for two rows with the same key to be a
 * benign duplicate rather than a determinism violation. */
function rowFacts(row: RunRow): string {
  return JSON.stringify([
    row.outcome,
    row.officialWin,
    row.gameTimeMs,
    row.safeRoomMs,
    row.score,
    row.xp,
    row.gold,
    row.minHealthPercent,
    row.finalLevel,
  ]);
}

/**
 * Validate a row's safe-room credit is a real, in-range number BEFORE any
 * consumer trusts it. `safeRoomMs` is typed `number`, but rows arrive from a
 * `JSON.parse` cast straight to `RunRow`, so an artifact that OMITS the field
 * (→ `undefined`), carries a `NaN`, or a value outside `[0, gameTimeMs]` slips
 * past the type. `activeTimeMs` coalesces a missing value to `0` (silently
 * restoring raw-time classification) and clamps a value > `gameTimeMs` to `0`
 * active time (manufacturing an official win for ANY victory regardless of real
 * clear time). The schema-version guard proves the field is EXPECTED at this
 * version; this proves it is PRESENT and SANE. Throws on the first violation.
 *
 * Exported so any consumer that injects externally-loaded rows OUTSIDE
 * {@link mergeShards}' fan-in guard (e.g. `sweep-eval.ts`'s `--legacy-baseline`
 * artifact for the legacy `--stage search` path) can apply the same per-row
 * validation before trusting those rows.
 */
export function assertRowSafeRoomInRange(row: RunRow): void {
  const label = rowKey(row).split('\u0000').join('/');
  if (!Number.isFinite(row.gameTimeMs) || row.gameTimeMs < 0) {
    throw new Error(
      `Row ${label}: gameTimeMs=${row.gameTimeMs} is not a finite, non-negative number.`,
    );
  }
  const safeRoomMs = row.safeRoomMs as number | undefined;
  if (
    typeof safeRoomMs !== 'number' ||
    !Number.isFinite(safeRoomMs) ||
    safeRoomMs < 0 ||
    safeRoomMs > row.gameTimeMs
  ) {
    throw new Error(
      `Row ${label}: safeRoomMs=${safeRoomMs} must be a finite number in ` +
        `[0, gameTimeMs=${row.gameTimeMs}] — a missing or out-of-range value would ` +
        `silently skew safe-room win credit at the fan-in boundary.`,
    );
  }
}

/**
 * Validate a SEARCH artifact's provenance before its tuned finalist config is
 * used to seed a fresh VALIDATE shard. Unlike shard rows — which pass through
 * {@link mergeShards}' schema/floor/budget guards at the aggregate fan-in — the
 * finalist config crosses the search→validate job boundary WITHOUT that vetting,
 * then the validate stage emits a fresh, well-formed shard, so a stale or
 * mismatched search artifact would silently seed valid-looking v{@link
 * SHARD_SCHEMA_VERSION} validation rows and evade the merge guard entirely. A
 * pre-v{@link SHARD_SCHEMA_VERSION} artifact in particular selected its winner
 * under the OLD raw-time win definition, so its finalist is not comparable under
 * the current safe-room-credited SSOT win.
 *
 * @param meta     the artifact's recorded provenance (absent on a legacy artifact)
 * @param combo    the combo the artifact was produced for (`SearchArtifact.combo`)
 * @param expected the current runner's calibration the artifact must match — schema/
 *   stage/floor/budget/frames/combo PLUS the current-build fingerprint
 *   (runnerOs/nodeVersion/packageLockHash/workflowSha) so a schema/floor/budget-
 *   matching artifact from a DIFFERENT code or runtime build (e.g. a stale
 *   `--legacy-baseline` produced before a scoring-logic change landed) is still
 *   rejected, mirroring {@link mergeShards}' per-shard build-fingerprint checks.
 */
export function assertSearchArtifactProvenance(
  meta: ShardMeta | undefined,
  combo: string | undefined,
  expected: {
    combo: string;
    floorId: string;
    budgetMs: number;
    maxFrames: number;
    runnerOs: string;
    nodeVersion: string;
    packageLockHash: string;
    workflowSha: string;
  },
): void {
  if (!meta) {
    throw new Error(
      `Search artifact has no meta/provenance block (pre-v${SHARD_SCHEMA_VERSION} schema); ` +
        `re-run --stage search on the current build before validating.`,
    );
  }
  if (meta.schemaVersion !== SHARD_SCHEMA_VERSION) {
    throw new Error(
      `Search artifact schema version ${meta.schemaVersion} != current ${SHARD_SCHEMA_VERSION}; ` +
        `its finalist was tuned under an older win definition (pre-v${SHARD_SCHEMA_VERSION} rows ` +
        `lack safeRoomMs). Re-run --stage search.`,
    );
  }
  if (meta.stage !== 'search') {
    throw new Error(
      `Search artifact stage '${meta.stage}' != 'search'; pass a --stage search artifact.`,
    );
  }
  if (meta.floorId !== expected.floorId) {
    throw new Error(
      `Search artifact floorId '${meta.floorId}' != '${expected.floorId}'; ` +
        `the finalist was tuned on a different floor.`,
    );
  }
  if (meta.budgetMs !== expected.budgetMs) {
    throw new Error(
      `Search artifact win-budget ${meta.budgetMs} != current ${expected.budgetMs}; ` +
        `the finalist was tuned against a different win budget.`,
    );
  }
  if (meta.maxFrames !== expected.maxFrames) {
    throw new Error(
      `Search artifact frame-cap ${meta.maxFrames} != current ${expected.maxFrames}; ` +
        `the finalist was tuned under a different frame budget.`,
    );
  }
  if (combo !== expected.combo) {
    throw new Error(
      `Search artifact combo '${combo}' != requested '${expected.combo}'; ` +
        `this finalist belongs to a different combo.`,
    );
  }
  // Build-fingerprint checks — mirror mergeShards' per-shard guards so an
  // artifact whose schema/floor/budget/frames happen to match, but whose rows
  // were produced by a different code revision or runtime, is still rejected
  // rather than silently trusted as a comparable incumbent/finalist.
  if (meta.runnerOs !== expected.runnerOs) {
    throw new Error(
      `Search artifact runner-OS '${meta.runnerOs}' != current '${expected.runnerOs}'; ` +
        `the finalist/baseline was produced on a different runner.`,
    );
  }
  if (meta.nodeVersion !== expected.nodeVersion) {
    throw new Error(
      `Search artifact node-version '${meta.nodeVersion}' != current '${expected.nodeVersion}'; ` +
        `the finalist/baseline was produced under a different Node runtime.`,
    );
  }
  if (meta.packageLockHash !== expected.packageLockHash) {
    throw new Error(
      `Search artifact package-lock '${meta.packageLockHash}' != current ` +
        `'${expected.packageLockHash}'; the finalist/baseline was produced against different ` +
        `dependencies.`,
    );
  }
  if (meta.workflowSha !== expected.workflowSha) {
    throw new Error(
      `Search artifact workflow-sha '${meta.workflowSha}' != current '${expected.workflowSha}'; ` +
        `the finalist/baseline was produced by a different code revision and is not comparable.`,
    );
  }
}

export interface MergedShards {
  meta: ShardMeta;
  rows: RunRow[];
  configs: Record<string, SweepConfig>;
  /** How many identical-duplicate rows were collapsed (cross-shard determinism proof). */
  collapsedDuplicates: number;
}

/**
 * Merge shard artifacts into one deduped row set, throwing on any provenance
 * mismatch or conflicting duplicate.
 */
export function mergeShards(shards: readonly ShardArtifact[]): MergedShards {
  if (shards.length === 0) {
    throw new Error('mergeShards: no shard artifacts provided');
  }
  const first = shards[0]!;
  const meta = first.meta;
  // Reject a batch whose schema predates the current version. All shards must
  // agree with each OTHER (checked per-shard below) AND with the current SSOT:
  // an all-v1 batch agrees internally yet its rows lack safeRoomMs, so
  // deriveRunFacts/isOfficialWin would silently fall back to raw-time
  // classification — the exact bug the safeRoomMs field fixed.
  if (meta.schemaVersion !== SHARD_SCHEMA_VERSION) {
    throw new Error(
      `Shard schema version ${meta.schemaVersion} != current ${SHARD_SCHEMA_VERSION}; ` +
        `re-run the sweep — pre-v${SHARD_SCHEMA_VERSION} rows lack safeRoomMs and would ` +
        `misclassify safe-room-credited wins.`,
    );
  }
  // The safe-room active-time credit in deriveRunFacts/isOfficialWin is a
  // Floor-1 mechanic (the collapse deadline only pauses in Floor-1 safe rooms).
  // A non-floor1 batch would be scored with Floor-1 win semantics, so reject it
  // outright rather than silently misclassify. sweep-eval enforces this at the
  // producer too; this is the fan-in's own defense against a hand-crafted or
  // legacy artifact.
  if (meta.floorId !== 'floor1') {
    throw new Error(
      `Shard floorId '${meta.floorId}' is not supported: the safe-room win credit is ` +
        `Floor-1-specific. Re-run the sweep on floor1 (non-Floor-1 win semantics are undefined).`,
    );
  }
  const rowsByKey = new Map<string, RunRow>();
  const configs: Record<string, SweepConfig> = {};
  let collapsedDuplicates = 0;

  for (const shard of shards) {
    // Provenance must match across all shards or the rows aren't comparable.
    if (shard.meta.schemaVersion !== meta.schemaVersion) {
      throw new Error(
        `Shard schema version mismatch: ${shard.meta.schemaVersion} vs ${meta.schemaVersion}`,
      );
    }
    if (shard.meta.budgetMs !== meta.budgetMs) {
      throw new Error(`Shard win-budget mismatch: ${shard.meta.budgetMs} vs ${meta.budgetMs}`);
    }
    if (shard.meta.floorId !== meta.floorId) {
      throw new Error(`Shard floor mismatch: ${shard.meta.floorId} vs ${meta.floorId}`);
    }
    if (shard.meta.maxFrames !== meta.maxFrames) {
      throw new Error(`Shard frame-budget mismatch: ${shard.meta.maxFrames} vs ${meta.maxFrames}`);
    }
    // Rows from a different stage / runtime / code revision are not comparable
    // and must never be summed into one leaderboard.
    if (shard.meta.stage !== meta.stage) {
      throw new Error(`Shard stage mismatch: ${shard.meta.stage} vs ${meta.stage}`);
    }
    if (shard.meta.runnerOs !== meta.runnerOs) {
      throw new Error(`Shard runner-OS mismatch: ${shard.meta.runnerOs} vs ${meta.runnerOs}`);
    }
    if (shard.meta.nodeVersion !== meta.nodeVersion) {
      throw new Error(
        `Shard node-version mismatch: ${shard.meta.nodeVersion} vs ${meta.nodeVersion}`,
      );
    }
    if (shard.meta.packageLockHash !== meta.packageLockHash) {
      throw new Error(
        `Shard package-lock mismatch: ${shard.meta.packageLockHash} vs ${meta.packageLockHash}`,
      );
    }
    if (shard.meta.workflowSha !== meta.workflowSha) {
      throw new Error(
        `Shard workflow-sha mismatch: ${shard.meta.workflowSha} vs ${meta.workflowSha}`,
      );
    }
    for (const [id, config] of Object.entries(shard.configs)) {
      // configId injectively encodes every knob value, so two differing configs
      // for the same id is definitionally a runner bug or tamper — surface it.
      const existingConfig = configs[id];
      if (existingConfig && JSON.stringify(existingConfig) !== JSON.stringify(config)) {
        throw new Error(
          `Conflicting config definition for id ${id} — determinism violation across shards.`,
        );
      }
      configs[id] = config;
    }
    for (const row of shard.rows) {
      assertRowSafeRoomInRange(row);
      const key = rowKey(row);
      const existing = rowsByKey.get(key);
      if (existing) {
        if (rowFacts(existing) !== rowFacts(row)) {
          throw new Error(
            `Conflicting duplicate run for ${key.split('\u0000').join('/')}: ` +
              `${rowFacts(existing)} vs ${rowFacts(row)} — determinism violation across shards.`,
          );
        }
        collapsedDuplicates++;
        continue;
      }
      rowsByKey.set(key, row);
    }
  }

  return { meta, rows: [...rowsByKey.values()], configs, collapsedDuplicates };
}

/** An expected (combo,config,weapon,seed) coverage cell. */
export type ExpectedCell = Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>;

/** Throw if any expected run is missing from `rows`. No-op when `expected` is empty. */
export function assertComplete(rows: readonly RunRow[], expected: readonly ExpectedCell[]): void {
  if (expected.length === 0) {
    return;
  }
  const present = new Set(rows.map(rowKey));
  const missing = expected.filter((cell) => !present.has(rowKey(cell)));
  if (missing.length > 0) {
    const preview = missing
      .slice(0, 8)
      .map((c) => `${c.combo}/${c.configId}/${c.weapon}/${c.seed}`)
      .join(', ');
    throw new Error(
      `Missing ${missing.length} expected run(s): ${preview}${missing.length > 8 ? ', …' : ''}`,
    );
  }
}

/**
 * Verify every row's stored (officialWin, score) matches a fresh SSOT recompute
 * from its raw facts. A disagreement means a producer bug (e.g. a gameTimeMs
 * units error, or a stale scorer) that must fail loudly rather than silently
 * skew the leaderboard. Throws on the first mismatch. Deterministic.
 */
export function assertRowsConsistent(rows: readonly RunRow[], budgetMs: number): void {
  for (const row of rows) {
    const derived = deriveRunFacts(
      {
        outcome: row.outcome,
        gameTimeMs: row.gameTimeMs,
        safeRoomMs: row.safeRoomMs,
        totalXp: row.xp,
        totalGold: row.gold,
        finalLevel: row.finalLevel,
      },
      budgetMs,
    );
    const label = rowKey(row).split('\u0000').join('/');
    if (derived.officialWin !== row.officialWin) {
      throw new Error(
        `Row ${label} claims officialWin=${row.officialWin} but its raw facts derive ` +
          `${derived.officialWin} at budget ${budgetMs}ms — shard integrity violation.`,
      );
    }
    if (derived.score !== row.score) {
      throw new Error(
        `Row ${label} claims score=${row.score} but its raw facts derive ` +
          `${derived.score} — shard integrity violation.`,
      );
    }
  }
}

export interface LeaderboardRow {
  combo: string;
  configId: string;
  config: SweepConfig | null;
  runs: number;
  wins: number;
  winRate: number;
  /** Σ composite score across runs — the user's stated headline metric. */
  totalScore: number;
  meanScore: number;
  meanClearTimeMsWins: number | null;
  meanXp: number;
  meanGold: number;
  meanMinHealthPercent: number;
  perWeaponWins: Record<string, { wins: number; runs: number }>;
  /** Paired win→loss flips vs the LEGACY incumbent (null if no incumbent or self).
   *  Informational only — no longer a hard gate, see {@link selectQualifiedWinner}. */
  flipsVsIncumbent: number | null;
  /** Aggregate win-rate delta vs the incumbent (null if no incumbent or self). */
  winRateDeltaVsIncumbent: number | null;
  /** Candidate's total wins minus the incumbent's total wins (null if no
   *  incumbent, self, or the groups cover different weapon/seed panels).
   *  Positive means the candidate has strictly MORE total wins than the
   *  incumbent — the hard gate {@link selectQualifiedWinner} now uses in place
   *  of the old zero-flips requirement, per the human-approved net-win promotion
   *  rule: a candidate may flip incumbent wins into losses as long as its
   *  absolute total wins strictly increase over the incumbent's. */
  winsVsIncumbentDelta: number | null;
  isIncumbent: boolean;
}

function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function groupKey(combo: string, configId: string): string {
  return `${combo}\u0000${configId}`;
}

export interface BuildLeaderboardOptions {
  /** The LEGACY incumbent to compute flips/delta against, e.g. `legacy+legacy`.
   *  NOTE: this identifies exactly ONE incumbent (comboKey + configId) for the
   *  whole call. `winsVsIncumbentDelta`/`flipsVsIncumbent`/`winRateDeltaVsIncumbent`
   *  are only meaningful when every row passed in shares that same fixed
   *  validation panel / incumbent context. Batching rows from multiple
   *  checkpoints or combos that each declare a DIFFERENT incumbent into a
   *  single `buildLeaderboard()` call is unsupported and would silently
   *  compare candidates against the wrong incumbent's win count. */
  incumbentCombo?: string;
  incumbentConfigId?: string;
  configs?: Record<string, SweepConfig>;
  /** SSOT win budget (ms). When set, officialWin is recomputed from each row's
   *  raw outcome + gameTimeMs rather than trusting the stored flag. */
  budgetMs?: number;
}

/**
 * Build one leaderboard row per (combo, configId), recomputing all totals from
 * the per-run rows. Flips + win-rate delta + `winsVsIncumbentDelta` are
 * computed against the incumbent group when one is supplied and identifiable
 * (see {@link BuildLeaderboardOptions} — single-incumbent-per-call only).
 */
export function buildLeaderboard(
  rows: readonly RunRow[],
  options: BuildLeaderboardOptions = {},
): LeaderboardRow[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = groupKey(row.combo, row.configId);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  // Whether a row is an official win. Recomputed from raw facts (safe-room
  // credited) when a budget is supplied (aggregate always supplies
  // meta.budgetMs) so a runner's stored officialWin flag can never corrupt the
  // wins/flips safety columns; falls back to the stored flag only for primitive
  // ranking tests that omit the budget.
  const isWin = (row: RunRow): boolean =>
    options.budgetMs !== undefined ? isOfficialWin(row, options.budgetMs) : row.officialWin;

  // Incumbent per-(weapon,seed) win map for flip computation.
  const incumbentKey =
    options.incumbentCombo && options.incumbentConfigId
      ? groupKey(options.incumbentCombo, options.incumbentConfigId)
      : null;
  const incumbentRows = incumbentKey ? (groups.get(incumbentKey) ?? []) : [];
  const incumbentWinByCell = new Map<string, boolean>();
  for (const row of incumbentRows) {
    incumbentWinByCell.set(`${row.weapon}\u0000${row.seed}`, isWin(row));
  }
  const incumbentWinRate =
    incumbentRows.length > 0
      ? incumbentRows.filter((r) => isWin(r)).length / incumbentRows.length
      : null;
  const incumbentWins =
    incumbentRows.length > 0 ? incumbentRows.filter((r) => isWin(r)).length : null;

  const leaderboard: LeaderboardRow[] = [];
  for (const [key, groupRows] of groups) {
    const [combo, configId] = key.split('\u0000') as [string, string];
    const runs = groupRows.length;
    const wins = groupRows.filter((r) => isWin(r)).length;
    const winRows = groupRows.filter((r) => isWin(r));
    const perWeaponWins: Record<string, { wins: number; runs: number }> = {};
    for (const row of groupRows) {
      const wp = (perWeaponWins[row.weapon] ??= { wins: 0, runs: 0 });
      wp.runs++;
      if (isWin(row)) {
        wp.wins++;
      }
    }

    const isIncumbent = key === incumbentKey;
    let flipsVsIncumbent: number | null = null;
    let winRateDeltaVsIncumbent: number | null = null;
    let winsVsIncumbentDelta: number | null = null;
    if (incumbentKey && !isIncumbent && incumbentWinByCell.size > 0) {
      let flips = 0;
      for (const row of groupRows) {
        const incWin = incumbentWinByCell.get(`${row.weapon}\u0000${row.seed}`);
        if (incWin === true && !isWin(row)) {
          flips++;
        }
      }
      flipsVsIncumbent = flips;
      if (incumbentWinRate !== null) {
        winRateDeltaVsIncumbent = wins / runs - incumbentWinRate;
      }
      if (incumbentWins !== null) {
        // Only compute a meaningful delta when the candidate and incumbent were
        // evaluated on an identical (weapon, seed) panel.  Extra or missing
        // cells would inflate/deflate the raw win count and make the comparison
        // meaningless, so leave winsVsIncumbentDelta null for mismatched panels.
        // We also require each group to contain exactly one row per cell so that
        // duplicate rows (which would inflate wins/runs for a group without
        // changing the unique-cell count) cannot corrupt the comparison.
        const candidateCells = new Set(groupRows.map((r) => `${r.weapon}\u0000${r.seed}`));
        const noDuplicateCandidateCells = candidateCells.size === groupRows.length;
        const noDuplicateIncumbentCells = incumbentWinByCell.size === incumbentRows.length;
        const panelsMatch =
          noDuplicateCandidateCells &&
          noDuplicateIncumbentCells &&
          candidateCells.size === incumbentWinByCell.size &&
          groupRows.every((r) => incumbentWinByCell.has(`${r.weapon}\u0000${r.seed}`));
        if (panelsMatch) {
          winsVsIncumbentDelta = wins - incumbentWins;
        }
      }
    }

    leaderboard.push({
      combo,
      configId,
      config: options.configs?.[configId] ?? null,
      runs,
      wins,
      winRate: runs > 0 ? wins / runs : 0,
      totalScore: groupRows.reduce((a, r) => a + r.score, 0),
      meanScore: mean(groupRows.map((r) => r.score)),
      meanClearTimeMsWins: winRows.length > 0 ? mean(winRows.map((r) => r.gameTimeMs)) : null,
      meanXp: mean(groupRows.map((r) => r.xp)),
      meanGold: mean(groupRows.map((r) => r.gold)),
      meanMinHealthPercent: mean(groupRows.map((r) => r.minHealthPercent)),
      perWeaponWins,
      flipsVsIncumbent,
      winRateDeltaVsIncumbent,
      winsVsIncumbentDelta,
      isIncumbent,
    });
  }
  return leaderboard;
}

/** Order by the user's stated headline metric: Σ composite score (desc). */
export function sortByComposite(rows: readonly LeaderboardRow[]): LeaderboardRow[] {
  return [...rows].sort((a, b) => b.totalScore - a.totalScore);
}

/**
 * Win-count-first lexicographic order (the win-rate-first project philosophy):
 * more wins → fewer flips vs incumbent → faster mean clear → more xp → more gold.
 * A time-bonus artifact can't crown a fewer-wins config here (see plan concern 2).
 *
 * DIAGNOSTIC ONLY: this ordering (and the `winnersDiverge` flag it feeds) is
 * surfaced for human visibility when the composite-score winner and this
 * lexicographic winner disagree. It is NOT the promotion gate — `flipsVsIncumbent`
 * here is used purely as a display tie-break, not a qualification requirement.
 * The actual hard gate is {@link selectQualifiedWinner} (win-rate floor +
 * strictly-more-total-wins-than-incumbent via `winsVsIncumbentDelta`).
 */
export function sortByLexicographic(rows: readonly LeaderboardRow[]): LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const aFlips = a.flipsVsIncumbent ?? 0;
    const bFlips = b.flipsVsIncumbent ?? 0;
    if (aFlips !== bFlips) return aFlips - bFlips;
    const aTime = a.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
    const bTime = b.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    if (b.meanXp !== a.meanXp) return b.meanXp - a.meanXp;
    return b.meanGold - a.meanGold;
  });
}

/**
 * Approved hard-gate win-rate floor for search/graduation candidate
 * selection: >=90% official wins. See {@link selectQualifiedWinner}.
 */
export const QUALIFICATION_MIN_WIN_RATE = 0.9;

export interface SelectQualifiedWinnerOptions {
  /** Win-rate floor a candidate must clear. Defaults to {@link QUALIFICATION_MIN_WIN_RATE}. */
  minWinRate?: number;
}

export interface QualifiedSelection {
  /** The selected candidate, or null when nothing met the hard safety gate. */
  winner: LeaderboardRow | null;
  /** Every non-incumbent candidate that passed BOTH the win-rate floor and the
   *  strictly-more-total-wins-than-incumbent hard gate, best-first (see
   *  tie-break order). */
  qualifying: LeaderboardRow[];
  /** Non-null only when the single highest-composite-score candidate overall
   *  was disqualified by the hard gate -- i.e. a naive score-only ranking
   *  would have picked a candidate this gate correctly rejected. */
  reason: string | null;
}

/**
 * Approved qualification order for promoting a search/graduation candidate
 * over the LEGACY incumbent: (1) >=90% official win rate AND (2) the
 * candidate's absolute total wins strictly EXCEED the incumbent's total wins
 * are a HARD gate -- a candidate failing EITHER is disqualified regardless of
 * composite score. Win→loss flips vs the incumbent are ALLOWED as long as the
 * candidate's total wins still strictly increase (human-approved net-win
 * promotion rule, superseding the prior zero-flips requirement). Among
 * qualifiers, rank by (3) highest composite score (Sigma), tie-broken by (4)
 * faster mean clear time on wins, then (5) higher mean minimum HP%, then (6)
 * higher mean XP, then (7) higher mean gold.
 *
 * This gate exists because of the GH run 29597840666 failure mode: both
 * riskRewardFused+legacy and slackAware+legacy out-scored the incumbent
 * (97.3% vs 95.3% wins) but each had 5 win->loss flips vs the incumbent. The
 * hard-gate check used to reject any nonzero flip count outright; the
 * human-approved fix instead compares absolute total wins: 292/300 (candidate)
 * strictly exceeds 286/300 (incumbent), so the flips are tolerated and the
 * candidate now qualifies. `buildLeaderboard`'s `winsVsIncumbentDelta` column
 * exists so this gate can enforce that contract directly, ahead of any score
 * comparison. `flipsVsIncumbent` remains informational (surfaced in the
 * leaderboard) but is no longer part of the hard gate.
 */
export function selectQualifiedWinner(
  rows: readonly LeaderboardRow[],
  options: SelectQualifiedWinnerOptions = {},
): QualifiedSelection {
  const minWinRate = options.minWinRate ?? QUALIFICATION_MIN_WIN_RATE;
  const candidates = rows.filter((r) => !r.isIncumbent);
  if (candidates.length === 0) {
    return {
      winner: null,
      qualifying: [],
      reason: 'No non-incumbent candidates to select from.',
    };
  }

  // Hard gate: winsVsIncumbentDelta must be STRICTLY POSITIVE (candidate's
  // total wins strictly exceed the incumbent's) -- `null` (no incumbent
  // identifiable) must never be treated as "qualifies". Flips are no longer
  // gated directly; a candidate may flip incumbent wins into losses as long
  // as its absolute total wins still strictly increase overall.
  const qualifying = candidates
    .filter(
      (r) =>
        r.winsVsIncumbentDelta !== null && r.winsVsIncumbentDelta > 0 && r.winRate >= minWinRate,
    )
    .sort((a, b) => {
      if (a.totalScore !== b.totalScore) return a.totalScore > b.totalScore ? -1 : 1;
      const aTime = a.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
      const bTime = b.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime < bTime ? -1 : 1;
      if (a.meanMinHealthPercent !== b.meanMinHealthPercent) {
        return a.meanMinHealthPercent > b.meanMinHealthPercent ? -1 : 1;
      }
      if (a.meanXp !== b.meanXp) return a.meanXp > b.meanXp ? -1 : 1;
      if (a.meanGold !== b.meanGold) return a.meanGold > b.meanGold ? -1 : 1;
      return 0;
    });

  if (qualifying.length === 0) {
    return {
      winner: null,
      qualifying: [],
      reason:
        `No candidate met the hard gate (>=${(minWinRate * 100).toFixed(0)}% win rate AND ` +
        `strictly more total wins than the incumbent) among ${candidates.length} candidate(s).`,
    };
  }

  const winner = qualifying[0]!;
  const topOverall = [...candidates].sort((a, b) => b.totalScore - a.totalScore)[0]!;
  const topIsDisqualified = !qualifying.includes(topOverall);
  const reason =
    topIsDisqualified && topOverall.totalScore > winner.totalScore
      ? `${topOverall.combo} scored higher (totalScore=${topOverall.totalScore}) but was ` +
        `disqualified by the hard safety gate (winRate=${(topOverall.winRate * 100).toFixed(1)}%, ` +
        `winsVsIncumbentDelta=${topOverall.winsVsIncumbentDelta ?? 'unknown'}).`
      : null;

  return { winner, qualifying, reason };
}

/**
 * Returns true when candidate `a` ranks strictly ahead of `b` under the same
 * tie-break order used by {@link selectQualifiedWinner}'s qualifying sort:
 * higher `totalScore` → faster `meanClearTimeMsWins` (lower) → higher
 * `meanMinHealthPercent` → higher `meanXp` → higher `meanGold`.
 *
 * When `b` is undefined (e.g. the current position's row is not yet in the
 * leaderboard), `a` is treated as unconditionally better so any qualifying
 * candidate displaces an unknown current position.
 */
export function isBetterQualifiedCandidate(
  a: LeaderboardRow,
  b: LeaderboardRow | undefined,
): boolean {
  if (!b) return true;
  if (a.totalScore !== b.totalScore) return a.totalScore > b.totalScore;
  const aTime = a.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
  const bTime = b.meanClearTimeMsWins ?? Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime < bTime;
  if (a.meanMinHealthPercent !== b.meanMinHealthPercent)
    return a.meanMinHealthPercent > b.meanMinHealthPercent;
  if (a.meanXp !== b.meanXp) return a.meanXp > b.meanXp;
  return a.meanGold > b.meanGold;
}

export interface AggregateResult {
  meta: ShardMeta;
  byComposite: LeaderboardRow[];
  byLexicographic: LeaderboardRow[];
  /** True when the composite-score winner differs from the win-count winner. */
  winnersDiverge: boolean;
  compositeWinner: LeaderboardRow | null;
  lexicographicWinner: LeaderboardRow | null;
  collapsedDuplicates: number;
  totalRuns: number;
  /** Largest safe-room dwell (ms) across all runs — surfaces the maintainer's
   *  ">60s in safe rooms" flag at a glance. */
  maxSafeRoomMs: number;
  /** Count of runs whose safe-room dwell exceeded {@link SAFE_ROOM_FLAG_MS}. */
  safeRoomFlaggedCount: number;
}

/** Full fan-in: merge → (optional completeness check) → leaderboard → both orderings. */
export function aggregate(
  shards: readonly ShardArtifact[],
  options: BuildLeaderboardOptions & {
    expected?: readonly ExpectedCell[];
    /** Verify every row's stored (officialWin, score) against a fresh SSOT
     *  recompute and throw on any disagreement. Default true; the real CLI never
     *  disables it. Unit tests exercising ranking with synthetic scores opt out. */
    verifyRowFacts?: boolean;
  } = {},
): AggregateResult {
  const merged = mergeShards(shards);
  assertComplete(merged.rows, options.expected ?? []);
  if (options.verifyRowFacts !== false) {
    assertRowsConsistent(merged.rows, merged.meta.budgetMs);
  }
  const leaderboard = buildLeaderboard(merged.rows, {
    ...options,
    budgetMs: merged.meta.budgetMs,
    configs: options.configs ?? merged.configs,
  });
  const byComposite = sortByComposite(leaderboard);
  const byLexicographic = sortByLexicographic(leaderboard);
  const compositeWinner = byComposite[0] ?? null;
  const lexicographicWinner = byLexicographic[0] ?? null;
  const winnersDiverge =
    compositeWinner !== null &&
    lexicographicWinner !== null &&
    groupKey(compositeWinner.combo, compositeWinner.configId) !==
      groupKey(lexicographicWinner.combo, lexicographicWinner.configId);
  const maxSafeRoomMs = merged.rows.reduce((m, r) => Math.max(m, r.safeRoomMs ?? 0), 0);
  const safeRoomFlaggedCount = merged.rows.filter(
    (r) => (r.safeRoomMs ?? 0) > SAFE_ROOM_FLAG_MS,
  ).length;
  return {
    meta: merged.meta,
    byComposite,
    byLexicographic,
    winnersDiverge,
    compositeWinner,
    lexicographicWinner,
    collapsedDuplicates: merged.collapsedDuplicates,
    totalRuns: merged.rows.length,
    maxSafeRoomMs,
    safeRoomFlaggedCount,
  };
}

/** Render a GitHub-flavoured Markdown leaderboard for `$GITHUB_STEP_SUMMARY`. */
export function renderMarkdown(result: AggregateResult): string {
  const lines: string[] = [];
  lines.push(`## AI combo eval — ${result.meta.stage}`);
  lines.push('');
  lines.push(
    `Runs: **${result.totalRuns}** · win budget: **${(result.meta.budgetMs / 1000).toFixed(0)}s** · ` +
      `frames: **${result.meta.maxFrames}** · node ${result.meta.nodeVersion} · ${result.meta.runnerOs} · ` +
      `lock \`${result.meta.packageLockHash.slice(0, 12)}\` · sha \`${result.meta.workflowSha.slice(0, 12)}\``,
  );
  if (result.collapsedDuplicates > 0) {
    lines.push('');
    lines.push(
      `> ${result.collapsedDuplicates} identical duplicate run(s) collapsed (determinism proof).`,
    );
  }
  lines.push('');
  lines.push(
    `Safe-room dwell: max **${(result.maxSafeRoomMs / 1000).toFixed(1)}s** · ` +
      `runs over ${(SAFE_ROOM_FLAG_MS / 1000).toFixed(0)}s flag: **${result.safeRoomFlaggedCount}**` +
      (result.safeRoomFlaggedCount > 0 ? ' ⚠️ (inspect for a stuck-near-safe-room stall)' : ''),
  );
  if (result.winnersDiverge) {
    lines.push('');
    lines.push(
      `> ⚠️ **Composite-score winner ≠ win-count winner** — human must adjudicate before any flip. ` +
        `Composite: \`${result.compositeWinner?.combo}\` · Win-count: \`${result.lexicographicWinner?.combo}\`.`,
    );
  }
  lines.push('');
  lines.push('### Ranked by Σ composite score (headline metric)');
  lines.push('');
  lines.push(
    '| # | combo | wins | win% | Σscore | mean clear(s) | xp | gold | minHP% | flips↓ | Δwin% |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  result.byComposite.forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.combo}${row.isIncumbent ? ' _(incumbent)_' : ''} | ${row.wins}/${row.runs} | ` +
        `${(row.winRate * 100).toFixed(1)} | ${row.totalScore.toExponential(3)} | ` +
        `${row.meanClearTimeMsWins !== null ? (row.meanClearTimeMsWins / 1000).toFixed(0) : '—'} | ` +
        `${row.meanXp.toFixed(0)} | ${row.meanGold.toFixed(0)} | ${(row.meanMinHealthPercent * 100).toFixed(0)} | ` +
        `${row.flipsVsIncumbent ?? '—'} | ` +
        `${row.winRateDeltaVsIncumbent !== null ? (row.winRateDeltaVsIncumbent >= 0 ? '+' : '') + (row.winRateDeltaVsIncumbent * 100).toFixed(1) : '—'} |`,
    );
  });

  // Approved qualification order (>=90% wins AND strictly more total wins
  // than the incumbent, then score) — surfaced separately from the raw
  // composite ranking above so a human never mistakes the top composite-score
  // row for the safe recommendation.
  const selection = selectQualifiedWinner(result.byComposite);
  lines.push('');
  lines.push('### Qualified winner (safety-gated recommendation)');
  lines.push('');
  if (selection.winner) {
    const delta = selection.winner.winsVsIncumbentDelta;
    lines.push(
      `✅ **\`${selection.winner.combo}\`** qualifies (win rate ` +
        `${(selection.winner.winRate * 100).toFixed(1)}%, ${delta !== null ? `+${delta}` : '?'} ` +
        `wins vs incumbent, Σscore ${selection.winner.totalScore.toExponential(3)}).`,
    );
  } else {
    lines.push('🚫 **No candidate qualifies.**');
  }
  if (selection.reason) {
    lines.push('');
    lines.push(`> ${selection.reason}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI (guarded). Reads shard JSON files, prints leaderboard JSON, and writes a
// Markdown summary to $GITHUB_STEP_SUMMARY when set.
// ---------------------------------------------------------------------------
function runCli(argv: readonly string[]): void {
  const files: string[] = [];
  let incumbentCombo: string | undefined;
  let incumbentConfigId: string | undefined;
  let outPath: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    if (arg === '--incumbent-combo' && next) {
      incumbentCombo = next;
      i++;
    } else if (arg === '--incumbent-config' && next) {
      incumbentConfigId = next;
      i++;
    } else if (arg === '--out' && next) {
      outPath = next;
      i++;
    } else if (!arg.startsWith('--')) {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    console.error(
      'Usage: ai:aggregate-shards <shard.json...> [--incumbent-combo id --incumbent-config id] [--out leaderboard.json]',
    );
    process.exit(1);
  }
  const shards = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ShardArtifact);
  const result = aggregate(shards, { incumbentCombo, incumbentConfigId });
  const md = renderMarkdown(result);
  console.log(md);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(result, null, 2));
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, md + '\n');
  }
}

if (
  process.env.CRAWLER_PREBUNDLED_ENTRY === 'aggregate-shards' ||
  (process.env.CRAWLER_PREBUNDLED_ENTRY === undefined &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1])
) {
  runCli(process.argv);
}
