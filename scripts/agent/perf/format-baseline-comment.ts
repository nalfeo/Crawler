import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface Baseline {
  meta?: {
    runUrl?: string;
  };
  winRate: number;
  totalWins?: number;
  totalRuns: number;
  /** Outcome victories that exceeded the active-time budget (slow clears). Optional — present in baselines captured after issue #1146. */
  totalSlowVictories?: number;
  /** Non-victory runs (deaths, timeouts, stalls). Optional — present in baselines captured after issue #1146. */
  totalTrueLosses?: number;
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

export interface BaselineCommentOptions {
  baselineBlobUrl: string;
  fallbackRunUrl: string;
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

function recordedTimestamp(entry: BaselineIndexEntry): number | null {
  for (const recordedAt of [entry.commitDate, entry.capturedAt]) {
    if (!recordedAt) continue;
    const timestamp = Date.parse(recordedAt);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return null;
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

  // Optional breakdown line — only shown when the baseline was captured with
  // the slow-victory separation (introduced in issue #1146).
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

  return [
    `📊 Baseline win-rate for this release: **${pct}%** (${wins}/${baseline.totalRuns})`,
    ...(breakdownLine ? [breakdownLine] : []),
    ...legSection,
    '',
    `📈 Last ${newestFive.length} recorded baseline${newestFive.length === 1 ? '' : 's'} (oldest → newest):`,
    ...trendLines,
    '',
    `🏃 [Sweep run](${runUrl}) · 🗂️ [Recorded baseline](${options.baselineBlobUrl})`,
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

function main(): void {
  const baselinePath = process.env.BASELINE_JSON;
  const indexPath = process.env.BASELINE_INDEX_JSON;
  if (!baselinePath || !indexPath) {
    throw new Error('BASELINE_JSON and BASELINE_INDEX_JSON are required');
  }

  const baseline = readJson<Baseline>(baselinePath, 'baseline.json');
  const index = readJson<BaselineIndexEntry[]>(indexPath, 'baseline index');
  process.stdout.write(
    formatBaselineComment(baseline, index, {
      baselineBlobUrl: process.env.BASELINE_BLOB_URL ?? '',
      fallbackRunUrl: process.env.FALLBACK_RUN_URL ?? '',
    }),
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
