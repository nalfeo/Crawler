#!/usr/bin/env node
/**
 * sprites:search-telemetry-capture — commit a per-session asset-search
 * telemetry summary to docs/knowledge/metrics/asset-search/.
 *
 * Reads `files/asset-search-telemetry.jsonl` (written by the asset-search
 * extension during the session), produces a summary record with:
 *   - totalQueries, emptyQueries (the actual query strings), topTerms
 *   - coverageRate (fraction of queries that found results)
 *
 * Writes to `docs/knowledge/metrics/asset-search/<session-slug>.json`.
 *
 * Usage:
 *   npm run sprites:search-telemetry-capture -- <session-slug>
 *
 * Empty-result query strings are the most actionable signal — agents can
 * scan these committed files to identify patterns and draft briefs for
 * missing asset families.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TELEMETRY_PATH = path.join('files', 'asset-search-telemetry.jsonl');
const OUTPUT_DIR = path.join('docs', 'knowledge', 'metrics', 'asset-search');

interface TelemetryRecord {
  readonly ts?: string;
  readonly query?: string;
  readonly type?: string;
  readonly resultCount?: number;
  readonly topScore?: number;
  readonly found?: boolean;
  readonly topIds?: string[];
}

interface SummaryJson {
  readonly session: string;
  readonly capturedAt: string;
  readonly totalQueries: number;
  readonly foundQueries: number;
  readonly emptyQueries: string[];
  readonly coverageRate: number;
  readonly topTerms: Array<{ term: string; count: number }>;
}

function parseArgs(argv: ReadonlyArray<string>): { sessionSlug: string } {
  const slug = argv[0];
  if (!slug || slug.startsWith('--')) {
    throw new Error(
      'Usage: npm run sprites:search-telemetry-capture -- <session-slug>\n' +
        'Example: npm run sprites:search-telemetry-capture -- my-session-2026-08-01',
    );
  }
  // Enforce kebab-case slug to prevent path traversal (e.g. "../../package").
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      `Invalid session slug: "${slug}". Must be kebab-case (e.g. "my-session-2026-08-01").`,
    );
  }
  return { sessionSlug: slug };
}

function readTelemetry(filePath: string): TelemetryRecord[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const records: TelemetryRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TelemetryRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function buildSummary(records: TelemetryRecord[], sessionSlug: string): SummaryJson {
  const totalQueries = records.length;
  const foundRecords = records.filter((r) => r.found === true);
  const emptyRecords = records.filter((r) => r.found === false);

  const termCounts = new Map<string, number>();
  for (const r of records) {
    if (typeof r.query !== 'string') continue;
    for (const term of tokenize(r.query)) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  const topTerms = Array.from(termCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  const emptyQueries = [
    ...new Set(emptyRecords.map((r) => r.query ?? '').filter((q) => q.length > 0)),
  ].sort();

  return {
    session: sessionSlug,
    capturedAt: new Date().toISOString(),
    totalQueries,
    foundQueries: foundRecords.length,
    emptyQueries,
    coverageRate:
      totalQueries > 0 ? Math.round((foundRecords.length / totalQueries) * 1000) / 1000 : 1.0,
    topTerms,
  };
}

function main(): number {
  let args: { sessionSlug: string };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const repoRoot = process.cwd();
  const telemetryPath = path.join(repoRoot, TELEMETRY_PATH);
  const outputDir = path.join(repoRoot, OUTPUT_DIR);

  const records = readTelemetry(telemetryPath);
  if (records.length === 0) {
    process.stdout.write(
      `search-telemetry-capture: no records in ${TELEMETRY_PATH} — nothing to commit.\n`,
    );
    return 0;
  }

  const summary = buildSummary(records, args.sessionSlug);

  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${args.sessionSlug}.json`);
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `search-telemetry-capture: wrote ${path.relative(repoRoot, outputPath)}\n` +
      `  total=${summary.totalQueries} found=${summary.foundQueries} ` +
      `coverage=${(summary.coverageRate * 100).toFixed(1)}%\n`,
  );
  if (summary.emptyQueries.length > 0) {
    process.stdout.write(
      `  empty queries (${summary.emptyQueries.length}) — candidate briefs:\n` +
        summary.emptyQueries.map((q) => `    - ${q}`).join('\n') +
        '\n',
    );
  }

  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(fileURLToPath(import.meta.url).replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  process.exit(main());
}
