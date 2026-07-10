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
  /** Paired win→loss flips vs the LEGACY incumbent (null if no incumbent or self). */
  flipsVsIncumbent: number | null;
  /** Aggregate win-rate delta vs the incumbent (null if no incumbent or self). */
  winRateDeltaVsIncumbent: number | null;
  isIncumbent: boolean;
}

function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function groupKey(combo: string, configId: string): string {
  return `${combo}\u0000${configId}`;
}

export interface BuildLeaderboardOptions {
  /** The LEGACY incumbent to compute flips/delta against, e.g. `legacy+legacy`. */
  incumbentCombo?: string;
  incumbentConfigId?: string;
  configs?: Record<string, SweepConfig>;
  /** SSOT win budget (ms). When set, officialWin is recomputed from each row's
   *  raw outcome + gameTimeMs rather than trusting the stored flag. */
  budgetMs?: number;
}

/**
 * Build one leaderboard row per (combo, configId), recomputing all totals from
 * the per-run rows. Flips + win-rate delta are computed against the incumbent
 * group when one is supplied and identifiable.
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
