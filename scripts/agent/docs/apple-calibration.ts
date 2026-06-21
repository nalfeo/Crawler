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
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const LEGACY_LOG_PATH = 'docs/knowledge/metrics/apple-log.json';
const APPLES_DIR = 'docs/knowledge/metrics/apples';
const MIN_ENTRIES = 5;
const MISS_WARN_THRESHOLD = 0.2;
const MISS_ERROR_THRESHOLD = 0.4;
const BIAS_WARN_THRESHOLD = 0.5;

type Verdict = 'exact' | 'under' | 'over' | 'miss';

interface AppleEntry {
  readonly date: string;
  readonly session: string;
  readonly estimated_apples: number;
  readonly actual_apples: number;
  readonly delta: number;
  readonly verdict: Verdict;
  readonly hello_kitties: number;
}

function verdictEmoji(v: Verdict): string {
  switch (v) {
    case 'exact':
      return '🎯';
    case 'under':
      return '📉';
    case 'over':
      return '📈';
    case 'miss':
      return '💥';
  }
}

function loadLegacyEntries(report: Report): AppleEntry[] {
  const path = fromRepo(LEGACY_LOG_PATH);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === '[]') return [];
    return JSON.parse(raw) as AppleEntry[];
  } catch {
    report.error(`${LEGACY_LOG_PATH} is not valid JSON.`, {
      remediation: 'Fix the JSON manually or reset the file to `[]`.',
    });
    return [];
  }
}

function loadDirEntries(report: Report): AppleEntry[] {
  const dir = fromRepo(APPLES_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const entries: AppleEntry[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      entries.push(JSON.parse(raw) as AppleEntry);
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

  const legacyEntries = loadLegacyEntries(report);
  const dirEntries = loadDirEntries(report);

  // Deduplicate by session key — dir entries win over legacy entries.
  const bySession = new Map<string, AppleEntry>();
  for (const e of legacyEntries) bySession.set(e.session, e);
  for (const e of dirEntries) bySession.set(e.session, e);
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

  const log = entries;

  // ── Overall metrics ──────────────────────────────────────────────────────
  const totalSessions = log.length;
  const meanDelta = log.reduce((s, e) => s + e.delta, 0) / totalSessions;
  const missCount = log.filter((e) => Math.abs(e.delta) >= 2).length;
  const missRate = missCount / totalSessions;

  process.stdout.write(`Apple calibration report — ${totalSessions} sessions\n`);
  process.stdout.write(
    `Mean delta: ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)} | Miss rate: ${(missRate * 100).toFixed(1)}%\n\n`,
  );

  // ── Per-level breakdown ───────────────────────────────────────────────────
  const byLevel = new Map<number, AppleEntry[]>();
  for (const e of log) {
    const bucket = byLevel.get(e.estimated_apples) ?? [];
    bucket.push(e);
    byLevel.set(e.estimated_apples, bucket);
  }

  for (const level of [1, 2, 3, 4]) {
    const bucket = byLevel.get(level);
    if (!bucket || bucket.length === 0) continue;
    const levelMiss = bucket.filter((e) => Math.abs(e.delta) >= 2).length;
    const levelMissRate = levelMiss / bucket.length;
    const levelMeanDelta = bucket.reduce((s, e) => s + e.delta, 0) / bucket.length;
    const appleStr = '🍎'.repeat(level);
    process.stdout.write(
      `${appleStr} (n=${bucket.length}) mean delta ${levelMeanDelta >= 0 ? '+' : ''}${levelMeanDelta.toFixed(2)} miss rate ${(levelMissRate * 100).toFixed(0)}%\n`,
    );
  }
  process.stdout.write('\n');

  // ── Verdict distribution ─────────────────────────────────────────────────
  const byVerdict = new Map<Verdict, number>();
  for (const e of log) {
    byVerdict.set(e.verdict, (byVerdict.get(e.verdict) ?? 0) + 1);
  }
  for (const [v, count] of byVerdict.entries()) {
    process.stdout.write(
      `${verdictEmoji(v)} ${v}: ${count} (${((count / totalSessions) * 100).toFixed(0)}%)\n`,
    );
  }
  process.stdout.write('\n');

  // ── Threshold checks ─────────────────────────────────────────────────────
  if (Math.abs(meanDelta) > BIAS_WARN_THRESHOLD) {
    const direction = meanDelta > 0 ? 'underestimating' : 'overestimating';
    report.warn(
      `Systematic bias detected: mean delta ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)} — agents are consistently ${direction}.`,
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
      `Calibration healthy: miss rate ${(missRate * 100).toFixed(1)}%, mean delta ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)}.`,
    );
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`apple-calibration crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
