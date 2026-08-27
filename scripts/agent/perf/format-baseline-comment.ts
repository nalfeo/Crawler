import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { compareFunReports, type FunScoreReport } from '../health/fun-score-lib.js';

interface RunSummary {
  gameTimeMs?: number;
  safeRoomMs?: number;
  combat?: { damageDealt?: number };
  lootEfficiency?: {
    xpSpawned?: number;
    xpCollected?: number;
    goldSpawned?: number;
    goldCollected?: number;
  };
}

interface Baseline {
  meta?: {
    commit?: string;
    runUrl?: string;
    sweep?: { revision?: number };
  };
  floorId?: string;
  legId?: string;
  winRate: number;
  totalWins?: number;
  totalRuns: number;
  /** Outcome victories that exceeded the active-time budget (slow clears). */
  totalSlowVictories?: number;
  /** Non-victory runs (deaths, timeouts, stalls). */
  totalTrueLosses?: number;
  /** Complete RunStats are retained for the report's diagnostic metrics. */
  runs?: RunSummary[];
  /** Per-leg results for the complete-floor release sweep. */
  legs?: Record<
    string,
    {
      winRate: number;
      totalWins: number;
      totalRuns: number;
    }
  >;
}

interface BaselineIndexEntry {
  commit: string;
  commitDate?: string;
  capturedAt?: string;
  winRate: number;
}

interface BaselineMetrics {
  loot: {
    xpRatio: number;
    goldRatio: number;
    combinedRatio: number;
  } | null;
  damagePerActiveMinute: number | null;
}

interface ReleaseFunReport {
  report: FunScoreReport;
}

export interface BaselineCommentOptions {
  baselineBlobUrl: string;
  fallbackRunUrl: string;
  reportUrl?: string;
  previousBaseline?: Baseline;
  funReport?: unknown;
  previousFunReport?: unknown;
}

function assertWinRate(winRate: number, context: string): void {
  if (!Number.isFinite(winRate) || winRate < 0 || winRate > 1) {
    throw new Error(`${context} has missing or out-of-range winRate`);
  }
}

function formatReleaseLabel(entry: BaselineIndexEntry): string {
  const timestamp = recordedTimestamp(entry);
  const date = timestamp === null ? 'unknown date' : new Date(timestamp).toISOString().slice(0, 10);
  return `${date} \`${entry.commit.slice(0, 7)}\``;
}

function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return '—';
  const delta = (current - previous) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)} pp`;
}

function formatNumberDelta(current: number, previous: number | undefined, digits = 1): string {
  if (previous === undefined) return '—';
  const delta = current - previous;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(digits)}`;
}

function recordedTimestamp(entry: BaselineIndexEntry): number | null {
  for (const recordedAt of [entry.commitDate, entry.capturedAt]) {
    if (!recordedAt) continue;
    const timestamp = Date.parse(recordedAt);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function summarizeMetrics(baseline: Baseline): BaselineMetrics {
  let xpSpawned = 0;
  let xpCollected = 0;
  let goldSpawned = 0;
  let goldCollected = 0;
  let lootRuns = 0;
  let damageDealt = 0;
  let activeTimeMs = 0;
  let damageRuns = 0;

  for (const run of baseline.runs ?? []) {
    const loot = run.lootEfficiency;
    if (
      loot &&
      isFiniteNonNegative(loot.xpSpawned) &&
      isFiniteNonNegative(loot.xpCollected) &&
      isFiniteNonNegative(loot.goldSpawned) &&
      isFiniteNonNegative(loot.goldCollected)
    ) {
      xpSpawned += loot.xpSpawned;
      xpCollected += loot.xpCollected;
      goldSpawned += loot.goldSpawned;
      goldCollected += loot.goldCollected;
      lootRuns += 1;
    }

    const damage = run.combat?.damageDealt;
    if (
      isFiniteNonNegative(damage) &&
      isFiniteNonNegative(run.gameTimeMs) &&
      isFiniteNonNegative(run.safeRoomMs) &&
      run.safeRoomMs <= run.gameTimeMs
    ) {
      damageDealt += damage;
      activeTimeMs += run.gameTimeMs - run.safeRoomMs;
      damageRuns += 1;
    }
  }

  return {
    loot:
      lootRuns > 0
        ? {
            xpRatio: xpSpawned === 0 ? 1 : xpCollected / xpSpawned,
            goldRatio: goldSpawned === 0 ? 1 : goldCollected / goldSpawned,
            combinedRatio:
              xpSpawned + goldSpawned === 0
                ? 1
                : (xpCollected + goldCollected) / (xpSpawned + goldSpawned),
          }
        : null,
    damagePerActiveMinute:
      damageRuns > 0 && activeTimeMs > 0 ? damageDealt / (activeTimeMs / 60_000) : null,
  };
}

function topLevelLegId(baseline: Baseline): string {
  return baseline.legId ?? baseline.floorId ?? 'floor1';
}

function areCompatible(baseline: Baseline, previous: Baseline | undefined): previous is Baseline {
  return Boolean(
    previous &&
    topLevelLegId(baseline) === 'floor1' &&
    topLevelLegId(previous) === 'floor1' &&
    baseline.totalRuns === previous.totalRuns &&
    typeof baseline.meta?.sweep?.revision === 'number' &&
    baseline.meta.sweep.revision === previous.meta?.sweep?.revision,
  );
}

function isFunReport(value: unknown): value is ReleaseFunReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = (value as { report?: unknown }).report;
  if (typeof report !== 'object' || report === null) return false;
  const candidate = report as Partial<FunScoreReport>;
  return (
    typeof candidate.runs === 'number' &&
    Number.isFinite(candidate.runs) &&
    typeof candidate.overall_fun_score === 'number' &&
    Number.isFinite(candidate.overall_fun_score) &&
    typeof candidate.gate?.pass === 'boolean' &&
    typeof candidate.dimensions === 'object' &&
    candidate.dimensions !== null &&
    typeof candidate.criteria === 'object' &&
    candidate.criteria !== null &&
    typeof candidate.persona_scores === 'object' &&
    candidate.persona_scores !== null
  );
}

function sameLegCohort(baseline: Baseline, previous: Baseline | undefined): boolean {
  if (!previous || !baseline.legs || !previous.legs) return false;
  const currentLegIds = Object.keys(baseline.legs).sort();
  const previousLegIds = Object.keys(previous.legs).sort();
  return (
    currentLegIds.length === previousLegIds.length &&
    currentLegIds.every((legId, index) => {
      const currentRuns = baseline.legs?.[legId]?.totalRuns;
      const previousRuns = previous.legs?.[legId]?.totalRuns;
      return (
        legId === previousLegIds[index] &&
        Number.isFinite(currentRuns) &&
        Number.isFinite(previousRuns) &&
        currentRuns === previousRuns
      );
    })
  );
}

function formatFunSection(
  baseline: Baseline,
  previousBaseline: Baseline | undefined,
  currentValue: unknown,
  previousValue: unknown,
): string[] {
  if (!isFunReport(currentValue)) return [];
  const current = currentValue.report;
  const previous = isFunReport(previousValue) ? previousValue.report : undefined;
  let delta = '—';
  if (previous) {
    try {
      const comparison = compareFunReports(previous, current);
      delta =
        comparison.cohort.matched && sameLegCohort(baseline, previousBaseline)
          ? `${formatNumberDelta(current.overall_fun_score, previous.overall_fun_score)} (${comparison.overall_fun_score.status})`
          : 'inconclusive (cohort changed)';
    } catch {
      // Historical diagnostic reports may predate a criterion; omit their delta.
    }
  }

  return [
    '',
    '### Fun evaluation',
    '',
    `**${current.overall_fun_score.toFixed(1)}/100** · gate **${current.gate.pass ? 'pass' : 'attention'}** · ${current.runs} runs · Δ ${delta}`,
  ];
}

function formatPerformanceSections(baseline: Baseline, previous: Baseline | undefined): string[] {
  const current = summarizeMetrics(baseline);
  const previousMetrics = previous ? summarizeMetrics(previous) : null;
  const compatible = areCompatible(baseline, previous);
  const lootDelta = (currentValue: number, previousValue: number | undefined): string =>
    compatible ? formatDelta(currentValue, previousValue) : '—';
  const dpsDelta = (currentValue: number, previousValue: number | undefined): string =>
    compatible ? formatNumberDelta(currentValue, previousValue) : '—';
  const sections: string[] = [];

  if (current.loot) {
    sections.push(
      '',
      '### Loot efficiency',
      '',
      `XP **${(current.loot.xpRatio * 100).toFixed(1)}%** (${lootDelta(current.loot.xpRatio, previousMetrics?.loot?.xpRatio)}) · ` +
        `gold **${(current.loot.goldRatio * 100).toFixed(1)}%** (${lootDelta(current.loot.goldRatio, previousMetrics?.loot?.goldRatio)}) · ` +
        `combined **${(current.loot.combinedRatio * 100).toFixed(1)}%** (${lootDelta(current.loot.combinedRatio, previousMetrics?.loot?.combinedRatio)})`,
    );
  }
  if (current.damagePerActiveMinute !== null) {
    sections.push(
      '',
      '### Damage rate',
      '',
      `**${current.damagePerActiveMinute.toFixed(1)} damage / active min** (${dpsDelta(current.damagePerActiveMinute, previousMetrics?.damagePerActiveMinute ?? undefined)})`,
    );
  }
  return sections;
}

export function formatBaselineComment(
  baseline: Baseline,
  index: BaselineIndexEntry[],
  options: BaselineCommentOptions,
): string {
  assertWinRate(baseline.winRate, 'baseline.json');
  if (!Number.isFinite(baseline.totalRuns) || baseline.totalRuns <= 0) {
    throw new Error('baseline.json has missing or out-of-range totalRuns');
  }
  if (!Array.isArray(index) || index.length === 0) {
    throw new Error('baseline index is empty or invalid');
  }

  const history = index
    .map((entry, position) => {
      if (!entry || typeof entry.commit !== 'string' || entry.commit.length === 0) {
        throw new Error(`baseline index entry ${position} has no commit`);
      }
      assertWinRate(entry.winRate, `baseline index entry ${position}`);
      return entry;
    })
    .sort((a, b) => {
      const aTimestamp = recordedTimestamp(a);
      const bTimestamp = recordedTimestamp(b);
      if (aTimestamp === null) return bTimestamp === null ? 0 : 1;
      if (bTimestamp === null) return -1;
      return bTimestamp - aTimestamp;
    });
  const newestFive = history.slice(0, 5);
  const trendLines = newestFive
    .map((entry, position) => {
      const previous = history[position + 1];
      return `- ${formatReleaseLabel(entry)} — **${(entry.winRate * 100).toFixed(1)}%** (${formatDelta(entry.winRate, previous?.winRate)})`;
    })
    .reverse();

  const pct = Math.round(baseline.winRate * 100);
  const wins = Number.isFinite(baseline.totalWins) ? baseline.totalWins : '?';
  const runUrl = baseline.meta?.runUrl || options.fallbackRunUrl;
  const slowVictories = baseline.totalSlowVictories;
  const trueLosses = baseline.totalTrueLosses;
  const hasBreakdown = Number.isFinite(slowVictories) && Number.isFinite(trueLosses);
  const fastWins =
    hasBreakdown && Number.isFinite(baseline.totalWins)
      ? (baseline.totalWins as number) - (slowVictories as number)
      : null;
  const breakdownLine =
    hasBreakdown && fastWins !== null
      ? `  ↳ ${fastWins} fast wins · ${slowVictories} slow victories · ${trueLosses} true losses`
      : null;
  const legRows = baseline.legs
    ? Object.entries(baseline.legs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([legId, leg]) => {
          assertWinRate(leg.winRate, `baseline leg "${legId}"`);
          if (!Number.isInteger(leg.totalRuns) || leg.totalRuns <= 0) {
            throw new Error(`baseline leg "${legId}" has missing or invalid totalRuns`);
          }
          if (
            !Number.isInteger(leg.totalWins) ||
            leg.totalWins < 0 ||
            leg.totalWins > leg.totalRuns
          ) {
            throw new Error(`baseline leg "${legId}" has missing or invalid totalWins`);
          }
          if (Math.abs(leg.totalWins / leg.totalRuns - leg.winRate) > 1e-9) {
            throw new Error(`baseline leg "${legId}" winRate does not match totalWins/totalRuns`);
          }
          const blocking = legId === 'floor1' ? 'yes' : 'report-only';
          return `| \`${legId}\` | ${(leg.winRate * 100).toFixed(1)}% | ${leg.totalWins}/${leg.totalRuns} | ${blocking} |`;
        })
    : [];
  const legSection =
    legRows.length > 0
      ? [
          '',
          '### Complete-floor coverage',
          '',
          '| Leg | Win rate | Wins | Gate |',
          '| --- | ---: | ---: | --- |',
          ...legRows,
        ]
      : [];
  const detailsLink = options.reportUrl ? ` · 🧭 [Release report](${options.reportUrl})` : '';

  return [
    `📊 Baseline win-rate for this release: **${pct}%** (${wins}/${baseline.totalRuns})`,
    ...(breakdownLine ? [breakdownLine] : []),
    ...formatPerformanceSections(baseline, options.previousBaseline),
    ...formatFunSection(
      baseline,
      options.previousBaseline,
      options.funReport,
      options.previousFunReport,
    ),
    ...legSection,
    '',
    `📈 Last ${newestFive.length} recorded baseline${newestFive.length === 1 ? '' : 's'} (oldest → newest):`,
    ...trendLines,
    '',
    `🏃 [Sweep run](${runUrl}) · 🗂️ [Recorded baseline](${options.baselineBlobUrl})${detailsLink}`,
  ].join('\n');
}

function readJson<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `${label} unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readOptionalJson(filePath: string | undefined): unknown {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function previousEntry(
  baseline: Baseline,
  index: BaselineIndexEntry[],
): BaselineIndexEntry | undefined {
  if (!baseline.meta?.commit) return undefined;
  const history = [...index].sort((a, b) => {
    const aTimestamp = recordedTimestamp(a);
    const bTimestamp = recordedTimestamp(b);
    if (aTimestamp === null) return bTimestamp === null ? 0 : 1;
    if (bTimestamp === null) return -1;
    return bTimestamp - aTimestamp;
  });
  const currentPosition = history.findIndex((entry) => entry.commit === baseline.meta?.commit);
  return currentPosition === -1 ? undefined : history[currentPosition + 1];
}

function isSafeCommit(commit: string): boolean {
  return /^[a-f0-9]{7,64}$/i.test(commit);
}

function reportUrl(
  pagesUrl: string | undefined,
  repo: string | undefined,
  commit: string | undefined,
): string {
  if (!pagesUrl || !repo || !commit || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !isSafeCommit(commit)) {
    return '';
  }
  const base = pagesUrl.endsWith('/') ? pagesUrl : `${pagesUrl}/`;
  const url = new URL('dev/release-baseline-report.html', base);
  url.searchParams.set('commit', commit);
  url.searchParams.set('repo', repo);
  return url.toString();
}

function main(): void {
  const baselinePath = process.env.BASELINE_JSON;
  const indexPath = process.env.BASELINE_INDEX_JSON;
  if (!baselinePath || !indexPath) {
    throw new Error('BASELINE_JSON and BASELINE_INDEX_JSON are required');
  }

  const baseline = readJson<Baseline>(baselinePath, 'baseline.json');
  const index = readJson<BaselineIndexEntry[]>(indexPath, 'baseline index');
  const previous = previousEntry(baseline, index);
  const baselinesDir = process.env.BASELINES_DIR;
  const previousPath =
    previous && baselinesDir && isSafeCommit(previous.commit)
      ? path.join(baselinesDir, 'by-sha', `${previous.commit}.json`)
      : undefined;
  const previousFunPath =
    previous && baselinesDir && isSafeCommit(previous.commit)
      ? path.join(baselinesDir, 'by-sha', `${previous.commit}.fun-report.json`)
      : undefined;
  process.stdout.write(
    formatBaselineComment(baseline, index, {
      baselineBlobUrl: process.env.BASELINE_BLOB_URL ?? '',
      fallbackRunUrl: process.env.FALLBACK_RUN_URL ?? '',
      reportUrl: reportUrl(process.env.PAGES_URL, process.env.BASELINE_REPO, baseline.meta?.commit),
      previousBaseline: previousPath
        ? (readOptionalJson(previousPath) as Baseline | undefined)
        : undefined,
      funReport: readOptionalJson(process.env.FUN_REPORT_JSON),
      previousFunReport: readOptionalJson(previousFunPath),
    }),
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
