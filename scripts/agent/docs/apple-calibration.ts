#!/usr/bin/env node
/**
 * docs/apple-calibration.ts — Read per-session apple entry files from
 * `docs/knowledge/metrics/apples/` and the legacy
 * `docs/knowledge/metrics/apple-log.json`, then report calibration health
 * for the apple complexity system.
 *
 * Metrics computed:
 *   - Entry count
 *   - Mean delta (positive = chronic underestimation, negative = overestimation)
 *   - Miss rate  (% of sessions where |delta| >= 2)
 *   - Per-estimated-level summary (which apple level is least calibrated)
 *
 * Thresholds:
 *   - warn  if miss rate  > 0.20 (20 %)
 *   - error if miss rate  > 0.40 (40 %)
 *   - warn  if |mean delta| > 0.5 (systematic bias)
 *
 * New entries go in `docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json`
 * (one JSON object per file). The legacy apple-log.json array is still read
 * for historical data. Skips cleanly when there are fewer than MIN_ENTRIES.
 *
 * Parsing/normalization and the aggregate maths live in
 * `apple-calibration-lib.ts` so they can be unit-tested without file I/O.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  type AppleEntry,
  type RawAppleEntry,
  computeCalibration,
  normalizeEntry,
  verdictEmoji,
} from './apple-calibration-lib.js';

const LEGACY_LOG_PATH = 'docs/knowledge/metrics/apple-log.json';
const APPLES_DIR = 'docs/knowledge/metrics/apples';
const MIN_ENTRIES = 5;
const MISS_WARN_THRESHOLD = 0.2;
const MISS_ERROR_THRESHOLD = 0.4;
const BIAS_WARN_THRESHOLD = 0.5;

interface SourcedEntry {
  readonly source: string;
  readonly raw: RawAppleEntry;
}

function formatDelta(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function loadLegacyEntries(report: Report): SourcedEntry[] {
  const path = fromRepo(LEGACY_LOG_PATH);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === '[]') return [];
    const parsed = JSON.parse(raw) as RawAppleEntry[];
    return parsed.map((entry, i) => ({ source: `${LEGACY_LOG_PATH}[${i}]`, raw: entry }));
  } catch {
    report.error(`${LEGACY_LOG_PATH} is not valid JSON.`, {
      remediation: 'Fix the JSON manually or reset the file to `[]`.',
    });
    return [];
  }
}

function loadDirEntries(report: Report): SourcedEntry[] {
  const dir = fromRepo(APPLES_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const entries: SourcedEntry[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      entries.push({ source: `${APPLES_DIR}/${file}`, raw: JSON.parse(raw) as RawAppleEntry });
    } catch {
      report.error(`${APPLES_DIR}/${file} is not valid JSON.`, {
        remediation: `Fix or remove ${APPLES_DIR}/${file}.`,
      });
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const report = new Report('docs-apple-calibration');

  // Legacy first, then dir, so dir entries win during session deduplication.
  const sourced = [...loadLegacyEntries(report), ...loadDirEntries(report)];

  // Normalize every row and surface any that lack a usable estimate/actual.
  // A missing/non-numeric field previously yielded `NaN` mean delta and an
  // `undefined` verdict in the report; skipping (and warning about) such rows
  // keeps the aggregate finite.
  const normalized: AppleEntry[] = [];
  for (const { source, raw } of sourced) {
    const entry = normalizeEntry(raw);
    if (entry) {
      normalized.push(entry);
    } else {
      report.warn('Apple entry is missing a usable estimate/actual and was skipped.', {
        file: source,
        remediation:
          'Use the canonical schema in docs/agent-os/policies/complexity-policy.md (estimated_apples, actual_apples, delta, verdict).',
      });
    }
  }

  // Deduplicate by session — dir entries (loaded last) win over legacy ones.
  const bySession = new Map<string, AppleEntry>();
  for (const e of normalized) bySession.set(e.session, e);
  const entries = [...bySession.values()];

  if (entries.length === 0) {
    report.skip('No apple entries found — no data to analyse.');
    report.finish();
  }

  if (entries.length < MIN_ENTRIES) {
    report.skip(
      `Only ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in apple log (need ${MIN_ENTRIES} for meaningful analysis).`,
    );
    report.finish();
  }

  const stats = computeCalibration(entries);
  const { totalSessions, meanDelta, missCount, missRate } = stats;

  // ── Overall metrics ──────────────────────────────────────────────────────
  process.stdout.write(`Apple calibration report — ${totalSessions} sessions\n`);
  process.stdout.write(
    `Mean delta: ${formatDelta(meanDelta)} | Miss rate: ${(missRate * 100).toFixed(1)}%\n\n`,
  );

  // ── Per-level breakdown ───────────────────────────────────────────────────
  for (const level of [1, 2, 3, 4, 5]) {
    const bucket = stats.byLevel.get(level);
    if (!bucket) continue;
    const appleStr = '🍎'.repeat(level);
    process.stdout.write(
      `${appleStr} (n=${bucket.count}) mean delta ${formatDelta(bucket.meanDelta)} miss rate ${(bucket.missRate * 100).toFixed(0)}%\n`,
    );
  }
  process.stdout.write('\n');

  // ── Verdict distribution ─────────────────────────────────────────────────
  for (const [v, count] of stats.byVerdict.entries()) {
    process.stdout.write(
      `${verdictEmoji(v)} ${v}: ${count} (${((count / totalSessions) * 100).toFixed(0)}%)\n`,
    );
  }
  process.stdout.write('\n');

  // ── Threshold checks ─────────────────────────────────────────────────────
  if (Math.abs(meanDelta) > BIAS_WARN_THRESHOLD) {
    const direction = meanDelta > 0 ? 'underestimating' : 'overestimating';
    report.warn(
      `Systematic bias detected: mean delta ${formatDelta(meanDelta)} — agents are consistently ${direction}.`,
      {
        remediation: `Review complexity-policy.md rubric. The ${direction === 'underestimating' ? 'higher' : 'lower'} apple levels may need sharper definitions.`,
      },
    );
  }

  if (missRate > MISS_ERROR_THRESHOLD) {
    report.error(
      `Miss rate ${(missRate * 100).toFixed(1)}% exceeds ${MISS_ERROR_THRESHOLD * 100}% threshold (${missCount}/${totalSessions} sessions with |delta| ≥ 2).`,
      {
        remediation:
          'Agents are frequently mis-estimating by 2+ apples. Review complexity-policy.md rubric and recent handoff verdicts for patterns.',
      },
    );
  } else if (missRate > MISS_WARN_THRESHOLD) {
    report.warn(
      `Miss rate ${(missRate * 100).toFixed(1)}% exceeds ${MISS_WARN_THRESHOLD * 100}% warning threshold (${missCount}/${totalSessions} sessions).`,
      {
        remediation:
          'Review recent 💥 Miss handoffs to identify which apple levels are least calibrated.',
      },
    );
  } else {
    report.info(
      `Calibration healthy: miss rate ${(missRate * 100).toFixed(1)}%, mean delta ${formatDelta(meanDelta)}.`,
    );
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`apple-calibration crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
