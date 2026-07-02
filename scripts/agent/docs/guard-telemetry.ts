#!/usr/bin/env node
/**
 * docs/guard-telemetry.ts — collect and analyse copilot-guards telemetry.
 *
 * Three modes:
 *   (default)            — analyse committed telemetry (handoff blocks + the
 *                          `docs/knowledge/metrics/guard-telemetry/` capture
 *                          files) and flag dead-guard candidates.
 *   --handoff-section    — render a handoff-ready Markdown block from the
 *                          session-local `files/guard-telemetry.jsonl`.
 *   --capture-session    — write a durable, committed per-session capture file
 *                          (the preferred, structured collection path).
 *
 * Contamination handling: guard-dev sessions run the guard test-suite, whose
 * dispatcher fixtures (see `KNOWN_TEST_FIXTURE_GUARD_IDS`) historically leaked
 * into `files/guard-telemetry.jsonl` and, from there, into pasted handoff
 * blocks. Any record carrying a fixture id is provably test output and is
 * quarantined whole (its real-id counts — e.g. `edit-guard-self-protection` —
 * are synthetic too). Non-configured ids that are *not* known fixtures (a typo
 * or renamed guard) are dropped individually with a warning so a legit session
 * is never discarded wholesale.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Report, fromRepo } from '../shared/report.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const METRICS_DIR = 'docs/knowledge/metrics/guard-telemetry';
const GUARD_CONFIG_PATH = '.github/extensions/copilot-guards/config.json';
const SESSION_ARTIFACT_PATH = 'files/guard-telemetry.jsonl';
const HANDOFF_SUMMARY_SCHEMA = 'agent-os-guard-telemetry-summary/v1';
const CAPTURE_SCHEMA = 'agent-os-guard-telemetry-capture/v1';
const DAYS_WINDOW = 14;

// A guard is only flagged dead when there is enough evidence to trust a zero:
// at least this many clean sessions AND this many observed events in the
// guard's own tool-family (heavy `edit` traffic says nothing about `pr` guards).
const MIN_CLEAN_SESSIONS_FOR_ANALYSIS = 3;
const FAMILY_MIN_EVENTS_FOR_DEAD_ALERT = 10;

/**
 * Guard ids that exist only as dispatcher/test fixtures. Any committed
 * telemetry record containing one of these is guard test-suite output that
 * leaked into the real artifact; the entire record is discarded. Keep this in
 * sync with the fixtures in
 * `.github/extensions/copilot-guards/tests/dispatcher.test.mjs`.
 */
export const KNOWN_TEST_FIXTURE_GUARD_IDS: ReadonlySet<string> = new Set([
  'boom',
  'ctx',
  'ctx-a',
  'ctx-b',
  'edit-bad',
  'pr-a',
  'pr-b',
  'pr-hard',
  'pr-warn',
  'shell-a',
  'shell-bad',
]);

export type GuardDecision = 'deny' | 'ask' | 'allow' | 'skip' | 'bypass' | 'crash';
export type GuardFamily = 'shell' | 'edit' | 'pr' | 'other';

export interface GuardTelemetryEvent {
  readonly schema?: string;
  readonly _type?: string;
  readonly ts: string;
  readonly guard_id: string;
  readonly tool_name: string;
  readonly decision: GuardDecision;
  readonly reason?: string;
  readonly bypass_used?: boolean;
  readonly bypass_reason?: string;
}

export type GuardCounts = Record<string, Partial<Record<GuardDecision, number>>>;

export interface GuardTelemetrySummary {
  readonly schema: typeof HANDOFF_SUMMARY_SCHEMA;
  readonly artifact: string;
  readonly session?: string;
  readonly events: number;
  readonly guards: GuardCounts;
  readonly tools: Record<string, number>;
}

export interface GuardTelemetryCaptureRecord {
  readonly schema: typeof CAPTURE_SCHEMA;
  readonly session: string;
  readonly date: string;
  readonly artifact: string;
  readonly events: number;
  readonly guards: GuardCounts;
  readonly tools: Record<string, number>;
  readonly ignored_events: number;
  readonly unexpected_guard_ids: string[];
}

interface SummarizeOptions {
  readonly session?: string;
  readonly allowedGuardIds?: ReadonlySet<string>;
}

/** Map a guard id to its tool-family by id prefix (all configured guards obey this). */
export function guardFamily(guardId: string): GuardFamily {
  if (guardId.startsWith('shell-')) return 'shell';
  if (guardId.startsWith('edit-')) return 'edit';
  if (guardId.startsWith('pr-')) return 'pr';
  return 'other';
}

export function parseGuardTelemetryJsonl(text: string): GuardTelemetryEvent[] {
  const events: GuardTelemetryEvent[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as GuardTelemetryEvent;
      if (event.guard_id && event.tool_name && event.decision) {
        events.push(event);
      }
    } catch {
      continue;
    }
  }
  return events;
}

export function summarizeGuardTelemetry(
  events: ReadonlyArray<GuardTelemetryEvent>,
  artifact = SESSION_ARTIFACT_PATH,
  options: SummarizeOptions = {},
): GuardTelemetrySummary {
  const { session, allowedGuardIds } = options;
  const guards: GuardCounts = {};
  const tools: Record<string, number> = {};

  let counted = 0;
  for (const event of events) {
    if (allowedGuardIds && !allowedGuardIds.has(event.guard_id)) continue;
    const guardBucket = (guards[event.guard_id] ??= {});
    guardBucket[event.decision] = (guardBucket[event.decision] ?? 0) + 1;
    tools[event.tool_name] = (tools[event.tool_name] ?? 0) + 1;
    counted += 1;
  }

  return {
    schema: HANDOFF_SUMMARY_SCHEMA,
    artifact,
    ...(session ? { session } : {}),
    events: counted,
    guards: sortObject(guards),
    tools: sortObject(tools),
  };
}

export function renderGuardTelemetryHandoffSection(summary: GuardTelemetrySummary): string {
  return [
    '## Agent-OS Telemetry',
    '',
    `Guard telemetry artifact: \`${summary.artifact}\``,
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
  ].join('\n');
}

export function parseGuardTelemetrySummaryFromHandoff(
  markdown: string,
): GuardTelemetrySummary | null {
  const sectionMatch = /## Agent-OS Telemetry\b([\s\S]*?)(?:\n## |\n# |$)/.exec(markdown);
  if (!sectionMatch?.[1]) return null;
  const jsonMatch = /```json\s*([\s\S]*?)```/.exec(sectionMatch[1]);
  if (!jsonMatch?.[1]) return null;
  let parsed: GuardTelemetrySummary;
  try {
    parsed = JSON.parse(jsonMatch[1]) as GuardTelemetrySummary;
  } catch {
    return null;
  }
  if (parsed?.schema !== HANDOFF_SUMMARY_SCHEMA) return null;
  if (typeof parsed.events !== 'number' || !parsed.guards || !parsed.tools) return null;
  return parsed;
}

export interface CleanRecordResult {
  /** Configured-only guard counts (empty when the record is quarantined). */
  readonly guards: GuardCounts;
  /** True when the record carried a known test-fixture id and was discarded whole. */
  readonly quarantined: boolean;
  /** Known-fixture ids that triggered the quarantine. */
  readonly fixtureIds: string[];
  /** Non-configured, non-fixture ids dropped individually (typo / renamed guard). */
  readonly unexpectedIds: string[];
}

/**
 * Validate a single telemetry record's guard counts against the configured
 * guard ids. See the file header for the quarantine-vs-drop policy.
 */
export function cleanTelemetryRecord(
  guards: GuardCounts,
  configuredIds: ReadonlySet<string>,
): CleanRecordResult {
  const fixtureIds: string[] = [];
  const unexpectedIds: string[] = [];
  const cleaned: GuardCounts = {};

  for (const [guardId, counts] of Object.entries(guards)) {
    if (configuredIds.has(guardId)) {
      cleaned[guardId] = counts;
    } else if (KNOWN_TEST_FIXTURE_GUARD_IDS.has(guardId)) {
      fixtureIds.push(guardId);
    } else {
      unexpectedIds.push(guardId);
    }
  }

  const quarantined = fixtureIds.length > 0;
  return {
    guards: quarantined ? {} : sortObject(cleaned),
    quarantined,
    fixtureIds: fixtureIds.sort(),
    unexpectedIds: unexpectedIds.sort(),
  };
}

export interface SourceRecord {
  readonly origin: 'handoff' | 'metrics';
  readonly file: string;
  readonly session?: string;
  readonly date: Date | null;
  readonly guards: GuardCounts;
  readonly tools: Record<string, number>;
}

export interface AggregateResult {
  readonly guards: GuardCounts;
  readonly tools: Record<string, number>;
  readonly totalEvents: number;
  readonly cleanSessionCount: number;
  readonly quarantinedCount: number;
  readonly unexpectedByFile: Array<{ file: string; ids: string[] }>;
}

function decisionTotal(counts: Partial<Record<GuardDecision, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

/**
 * Dedupe (metrics win over handoffs for the same session), clean, and aggregate
 * a set of source records into per-guard totals. Input order is irrelevant:
 * dedupe is resolved by origin precedence, not array position.
 */
export function aggregateSources(
  sources: ReadonlyArray<SourceRecord>,
  configuredIds: ReadonlySet<string>,
): AggregateResult {
  const guards: GuardCounts = {};
  const tools: Record<string, number> = {};
  let totalEvents = 0;
  let cleanSessionCount = 0;
  let quarantinedCount = 0;
  const unexpectedByFile: Array<{ file: string; ids: string[] }> = [];

  const deduped = dedupeSources(
    sources.filter((record) => record.origin === 'handoff'),
    sources.filter((record) => record.origin === 'metrics'),
  );

  for (const record of deduped) {
    const cleaned = cleanTelemetryRecord(record.guards, configuredIds);
    if (cleaned.quarantined) {
      quarantinedCount += 1;
      continue;
    }
    if (cleaned.unexpectedIds.length > 0) {
      unexpectedByFile.push({ file: record.file, ids: cleaned.unexpectedIds });
    }
    cleanSessionCount += 1;
    for (const [guardId, counts] of Object.entries(cleaned.guards)) {
      const bucket = (guards[guardId] ??= {});
      for (const [decision, count] of Object.entries(counts) as Array<[GuardDecision, number]>) {
        bucket[decision] = (bucket[decision] ?? 0) + count;
        totalEvents += count;
      }
    }
    for (const [tool, count] of Object.entries(record.tools)) {
      tools[tool] = (tools[tool] ?? 0) + count;
    }
  }

  return {
    guards: sortObject(guards),
    tools: sortObject(tools),
    totalEvents,
    cleanSessionCount,
    quarantinedCount,
    unexpectedByFile,
  };
}

export interface GuardVerdict {
  readonly guardId: string;
  readonly family: GuardFamily;
  readonly status: 'alive' | 'dead' | 'unobserved';
  readonly events: number;
  readonly familyEvents: number;
}

/**
 * Classify every configured guard. A 0-event guard is only "dead" when its
 * family has enough observed volume across enough clean sessions to trust the
 * zero; otherwise it is "unobserved" (likely under-collected, not proven dead).
 */
export function analyzeGuards(
  aggregate: AggregateResult,
  configuredIds: ReadonlyArray<string>,
): GuardVerdict[] {
  const familyEvents: Record<GuardFamily, number> = { shell: 0, edit: 0, pr: 0, other: 0 };
  for (const [guardId, counts] of Object.entries(aggregate.guards)) {
    familyEvents[guardFamily(guardId)] += decisionTotal(counts);
  }

  const enoughSessions = aggregate.cleanSessionCount >= MIN_CLEAN_SESSIONS_FOR_ANALYSIS;

  return [...configuredIds].sort().map((guardId) => {
    const family = guardFamily(guardId);
    const events = aggregate.guards[guardId] ? decisionTotal(aggregate.guards[guardId]) : 0;
    let status: GuardVerdict['status'];
    if (events > 0) {
      status = 'alive';
    } else if (enoughSessions && familyEvents[family] >= FAMILY_MIN_EVENTS_FOR_DEAD_ALERT) {
      status = 'dead';
    } else {
      status = 'unobserved';
    }
    return { guardId, family, status, events, familyEvents: familyEvents[family] };
  });
}

function sortObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(now: Date, then: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadActiveGuardIds(): string[] {
  const raw = readFileSync(fromRepo(GUARD_CONFIG_PATH), 'utf8');
  const parsed = JSON.parse(raw) as {
    guards?: Record<string, { disabled?: boolean }>;
  };
  return Object.entries(parsed.guards ?? {})
    .filter(([, config]) => !config?.disabled)
    .map(([guardId]) => guardId)
    .sort();
}

function loadHandoffSources(now: Date): {
  totalRecentHandoffs: number;
  sources: SourceRecord[];
} {
  const entries = readdirSync(fromRepo(HANDOFFS_DIR))
    .filter((entry) => entry.endsWith('.md') && /^\d{4}-\d{2}-\d{2}-/.test(entry))
    .sort();

  let totalRecentHandoffs = 0;
  const sources: SourceRecord[] = [];

  for (const entry of entries) {
    const date = parseIsoDate(entry);
    if (!date || daysBetween(now, date) > DAYS_WINDOW) continue;
    totalRecentHandoffs += 1;
    const text = readFileSync(fromRepo(HANDOFFS_DIR, entry), 'utf8');
    const summary = parseGuardTelemetrySummaryFromHandoff(text);
    if (!summary) continue;
    sources.push({
      origin: 'handoff',
      file: `${HANDOFFS_DIR}/${entry}`,
      session: summary.session,
      date,
      guards: summary.guards,
      tools: summary.tools,
    });
  }

  return { totalRecentHandoffs, sources };
}

function loadMetricsSources(now: Date): SourceRecord[] {
  const dir = fromRepo(METRICS_DIR);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();

  const sources: SourceRecord[] = [];
  for (const entry of entries) {
    let record: GuardTelemetryCaptureRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as GuardTelemetryCaptureRecord;
    } catch {
      continue;
    }
    if (record?.schema !== CAPTURE_SCHEMA || !record.guards || !record.tools) continue;
    const date = parseIsoDate(record.date ?? entry);
    if (!date || daysBetween(now, date) > DAYS_WINDOW) continue;
    sources.push({
      origin: 'metrics',
      file: `${METRICS_DIR}/${entry}`,
      session: record.session,
      date,
      guards: record.guards,
      tools: record.tools,
    });
  }
  return sources;
}

/**
 * Dedupe by session identity. Legacy handoffs with no session key are keyed by
 * file so distinct sessions are never collapsed. Metrics are inserted last, so
 * for a session present in both a handoff block and a capture file, the
 * structured metrics record wins.
 */
function dedupeSources(handoffs: SourceRecord[], metrics: SourceRecord[]): SourceRecord[] {
  const byKey = new Map<string, SourceRecord>();
  const keyFor = (record: SourceRecord): string =>
    record.session && record.session.trim()
      ? `session:${record.session.trim()}`
      : `${record.origin}:${record.file}`;
  for (const record of handoffs) byKey.set(keyFor(record), record);
  for (const record of metrics) byKey.set(keyFor(record), record);
  return [...byKey.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function reportMode(): void {
  const report = new Report('docs-guard-telemetry');
  const now = new Date();
  const configuredIds = loadActiveGuardIds();
  const configuredSet = new Set(configuredIds);

  const { totalRecentHandoffs, sources: handoffSources } = loadHandoffSources(now);
  const metricsSources = loadMetricsSources(now);

  if (totalRecentHandoffs === 0 && metricsSources.length === 0) {
    report.skip(`No recent telemetry found in the last ${DAYS_WINDOW} days.`);
    report.finish();
  }

  const aggregate = aggregateSources([...handoffSources, ...metricsSources], configuredSet);

  report.info(
    `Telemetry sources: ${handoffSources.length} handoff block(s) + ${metricsSources.length} capture file(s) → ${aggregate.cleanSessionCount} clean session(s) after dedupe/quarantine (of ${totalRecentHandoffs} handoffs in the last ${DAYS_WINDOW} days).`,
  );
  if (aggregate.quarantinedCount > 0) {
    report.info(
      `Quarantined ${aggregate.quarantinedCount} record(s) carrying known test-fixture guard ids (guard test-suite leakage).`,
    );
  }
  if (aggregate.cleanSessionCount === 0) {
    report.warn('No clean telemetry sessions after dedupe/quarantine.', {
      remediation:
        'Run `npm run telemetry:capture` near session end so each session contributes a committed capture file.',
    });
  }
  for (const { file, ids } of aggregate.unexpectedByFile) {
    report.warn(`Unexpected guard id(s) dropped from ${file}: ${ids.join(', ')}.`, {
      remediation:
        'A renamed/typo guard id — update the config or the emitter so real telemetry is not silently discarded.',
    });
  }

  report.info(
    `Guard telemetry captured ${aggregate.totalEvents} configured event(s) across ${aggregate.cleanSessionCount} clean session(s).`,
  );
  for (const [guardId, counts] of Object.entries(aggregate.guards)) {
    const detail = Object.entries(counts)
      .map(([decision, count]) => `${decision}:${count}`)
      .join(', ');
    report.info(`Guard ${guardId} — ${detail}`);
  }

  const verdicts = analyzeGuards(aggregate, configuredIds);
  const enoughSessions = aggregate.cleanSessionCount >= MIN_CLEAN_SESSIONS_FOR_ANALYSIS;
  if (!enoughSessions) {
    report.info(
      `Dead-guard analysis needs ≥ ${MIN_CLEAN_SESSIONS_FOR_ANALYSIS} clean sessions (have ${aggregate.cleanSessionCount}); reporting unobserved guards as low-confidence only.`,
    );
  }
  for (const verdict of verdicts) {
    if (verdict.status === 'dead') {
      report.warn(
        `Dead guard candidate: ${verdict.guardId} — 0 events despite ${verdict.familyEvents} '${verdict.family}'-family event(s) across ≥ ${MIN_CLEAN_SESSIONS_FOR_ANALYSIS} clean sessions.`,
        {
          remediation:
            'Review whether the guard is niche-but-valid, under-adopted in telemetry, or a candidate for removal/tuning.',
        },
      );
    } else if (verdict.status === 'unobserved') {
      report.info(
        `Unobserved guard: ${verdict.guardId} — 0 events, but its '${verdict.family}' family has only ${verdict.familyEvents} event(s); likely under-collected, not proven dead.`,
      );
    }
  }

  report.finish();
}

function handoffSectionMode(): void {
  const artifactPath = fromRepo(SESSION_ARTIFACT_PATH);
  if (!existsSync(artifactPath)) {
    process.stdout.write(
      [
        '## Agent-OS Telemetry',
        '',
        `Guard telemetry artifact: \`${SESSION_ARTIFACT_PATH}\``,
        '',
        '_No guard telemetry artifact was captured in this session._',
        '',
      ].join('\n'),
    );
    return;
  }

  const events = parseGuardTelemetryJsonl(readFileSync(artifactPath, 'utf8'));
  const summary = summarizeGuardTelemetry(events, SESSION_ARTIFACT_PATH, {
    allowedGuardIds: new Set(loadActiveGuardIds()),
    session: resolveSessionSlug(),
  });
  process.stdout.write(`${renderGuardTelemetryHandoffSection(summary)}\n`);
}

export function buildCaptureRecord(
  events: ReadonlyArray<GuardTelemetryEvent>,
  options: { session: string; date: string; configuredIds: ReadonlySet<string> },
): GuardTelemetryCaptureRecord {
  const { session, date, configuredIds } = options;
  const guards: GuardCounts = {};
  const tools: Record<string, number> = {};
  const unexpected = new Set<string>();
  let counted = 0;
  let ignored = 0;

  for (const event of events) {
    if (configuredIds.has(event.guard_id)) {
      const bucket = (guards[event.guard_id] ??= {});
      bucket[event.decision] = (bucket[event.decision] ?? 0) + 1;
      tools[event.tool_name] = (tools[event.tool_name] ?? 0) + 1;
      counted += 1;
    } else {
      ignored += 1;
      if (!KNOWN_TEST_FIXTURE_GUARD_IDS.has(event.guard_id)) unexpected.add(event.guard_id);
    }
  }

  return {
    schema: CAPTURE_SCHEMA,
    session,
    date,
    artifact: SESSION_ARTIFACT_PATH,
    events: counted,
    guards: sortObject(guards),
    tools: sortObject(tools),
    ignored_events: ignored,
    unexpected_guard_ids: [...unexpected].sort(),
  };
}

function captureSessionMode(slug: string): void {
  const report = new Report('docs-guard-telemetry-capture');
  const artifactPath = fromRepo(SESSION_ARTIFACT_PATH);
  if (!existsSync(artifactPath)) {
    report.info(`No ${SESSION_ARTIFACT_PATH} in this worktree; nothing to capture.`);
    report.finish();
  }

  const events = parseGuardTelemetryJsonl(readFileSync(artifactPath, 'utf8'));
  const record = buildCaptureRecord(events, {
    session: slug,
    date: today(),
    configuredIds: new Set(loadActiveGuardIds()),
  });

  const dir = fromRepo(METRICS_DIR);
  mkdirSync(dir, { recursive: true });
  const outFile = join(dir, `${record.date}-${slug}.json`);
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  report.info(
    `Captured ${record.events} configured event(s) for session "${slug}" → ${METRICS_DIR}/${record.date}-${slug}.json`,
  );
  if (record.ignored_events > 0) {
    report.info(`Ignored ${record.ignored_events} non-configured event(s) during capture.`);
  }
  if (record.unexpected_guard_ids.length > 0) {
    report.warn(
      `Unexpected guard id(s) seen and ignored: ${record.unexpected_guard_ids.join(', ')}.`,
    );
  }
  report.finish();
}

/** Resolve a stable, kebab session id: explicit arg → env → git branch → fallback. */
export function resolveSessionSlug(explicit?: string): string {
  const raw = explicit ?? process.env.GUARD_TELEMETRY_SESSION ?? gitBranch() ?? 'session';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'session';
}

function gitBranch(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function captureSlugFromArgv(argv: string[]): string {
  const idx = argv.indexOf('--capture-session');
  const next = idx >= 0 ? argv[idx + 1] : undefined;
  const explicit = next && !next.startsWith('--') ? next : undefined;
  return resolveSessionSlug(explicit);
}

export function main(argv = process.argv.slice(2)): void {
  if (argv.includes('--handoff-section')) {
    handoffSectionMode();
    return;
  }
  if (argv.includes('--capture-session')) {
    captureSessionMode(captureSlugFromArgv(argv));
    return;
  }
  reportMode();
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `guard-telemetry crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(2);
  }
}
