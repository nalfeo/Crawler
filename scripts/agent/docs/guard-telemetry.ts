#!/usr/bin/env node
/**
 * docs/guard-telemetry.ts — summarize session-local guard telemetry JSONL into
 * a handoff-ready Markdown block, and analyse committed handoff telemetry
 * summaries across sessions.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Report, fromRepo } from '../shared/report.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const GUARD_CONFIG_PATH = '.github/extensions/copilot-guards/config.json';
const SESSION_ARTIFACT_PATH = 'files/guard-telemetry.jsonl';
const HANDOFF_SUMMARY_SCHEMA = 'agent-os-guard-telemetry-summary/v1';
const DAYS_WINDOW = 14;
const MIN_COVERED_SESSIONS_FOR_ANALYSIS = 3;
const MIN_COVERAGE_RATIO_FOR_DEAD_GUARD_ALERTS = 0.5;

export type GuardDecision = 'deny' | 'ask' | 'allow' | 'skip' | 'bypass' | 'crash';

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

export interface GuardTelemetrySummary {
  readonly schema: typeof HANDOFF_SUMMARY_SCHEMA;
  readonly artifact: string;
  readonly events: number;
  readonly guards: Record<string, Partial<Record<GuardDecision, number>>>;
  readonly tools: Record<string, number>;
}

interface HandoffTelemetryRecord {
  readonly file: string;
  readonly date: Date;
  readonly summary: GuardTelemetrySummary;
}

export function parseGuardTelemetryJsonl(text: string): GuardTelemetryEvent[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuardTelemetryEvent)
    .filter((event) => event.guard_id && event.tool_name && event.decision);
}

export function summarizeGuardTelemetry(
  events: ReadonlyArray<GuardTelemetryEvent>,
  artifact = SESSION_ARTIFACT_PATH,
): GuardTelemetrySummary {
  const guards: Record<string, Partial<Record<GuardDecision, number>>> = {};
  const tools: Record<string, number> = {};

  for (const event of events) {
    const guardBucket = (guards[event.guard_id] ??= {});
    guardBucket[event.decision] = (guardBucket[event.decision] ?? 0) + 1;
    tools[event.tool_name] = (tools[event.tool_name] ?? 0) + 1;
  }

  return {
    schema: HANDOFF_SUMMARY_SCHEMA,
    artifact,
    events: events.length,
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
  const parsed = JSON.parse(jsonMatch[1]) as GuardTelemetrySummary;
  if (parsed?.schema !== HANDOFF_SUMMARY_SCHEMA) return null;
  if (typeof parsed.events !== 'number' || !parsed.guards || !parsed.tools) return null;
  return parsed;
}

function sortObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseDateFromHandoffName(name: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-/.exec(name);
  if (!match) return null;
  const [, year, month, day] = match;
  const value = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function daysBetween(now: Date, then: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
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

function loadRecentHandoffTelemetry(now = new Date()): {
  totalRecentHandoffs: number;
  records: HandoffTelemetryRecord[];
} {
  const entries = readdirSync(fromRepo(HANDOFFS_DIR)).filter(
    (entry) => entry.endsWith('.md') && /^\d{4}-\d{2}-\d{2}-/.test(entry),
  );

  let totalRecentHandoffs = 0;
  const records: HandoffTelemetryRecord[] = [];

  for (const entry of entries) {
    const date = parseDateFromHandoffName(entry);
    if (!date || daysBetween(now, date) > DAYS_WINDOW) continue;
    totalRecentHandoffs += 1;
    const text = readFileSync(fromRepo(HANDOFFS_DIR, entry), 'utf8');
    const summary = parseGuardTelemetrySummaryFromHandoff(text);
    if (!summary) continue;
    records.push({ file: entry, date, summary });
  }

  return { totalRecentHandoffs, records };
}

function aggregateGuardCounts(
  records: ReadonlyArray<HandoffTelemetryRecord>,
): Record<string, Partial<Record<GuardDecision, number>>> {
  const aggregate: Record<string, Partial<Record<GuardDecision, number>>> = {};
  for (const record of records) {
    for (const [guardId, decisionCounts] of Object.entries(record.summary.guards)) {
      const bucket = (aggregate[guardId] ??= {});
      for (const [decision, count] of Object.entries(decisionCounts) as Array<
        [GuardDecision, number]
      >) {
        bucket[decision] = (bucket[decision] ?? 0) + count;
      }
    }
  }
  return sortObject(aggregate);
}

async function reportMode(): Promise<void> {
  const report = new Report('docs-guard-telemetry');
  const { totalRecentHandoffs, records } = loadRecentHandoffTelemetry();

  if (totalRecentHandoffs === 0) {
    report.skip(`No recent handoffs found in the last ${DAYS_WINDOW} days.`);
    report.finish();
  }

  const coverageRatio = records.length / totalRecentHandoffs;
  if (records.length === 0) {
    report.warn(`No recent handoffs include an Agent-OS telemetry summary.`, {
      remediation:
        'Run `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` near session end and paste the block into the handoff.',
    });
    report.finish();
  }

  report.info(
    `Telemetry coverage: ${records.length}/${totalRecentHandoffs} handoffs (${(coverageRatio * 100).toFixed(0)}%) include guard summaries in the last ${DAYS_WINDOW} days.`,
  );

  const totalEvents = records.reduce((sum, record) => sum + record.summary.events, 0);
  report.info(
    `Guard telemetry captured ${totalEvents} event(s) across ${records.length} handoff(s).`,
  );

  const aggregate = aggregateGuardCounts(records);
  for (const [guardId, counts] of Object.entries(aggregate)) {
    const detail = Object.entries(counts)
      .map(([decision, count]) => `${decision}:${count}`)
      .join(', ');
    report.info(`Guard ${guardId} — ${detail}`);
  }

  if (
    records.length >= MIN_COVERED_SESSIONS_FOR_ANALYSIS &&
    coverageRatio >= MIN_COVERAGE_RATIO_FOR_DEAD_GUARD_ALERTS
  ) {
    for (const guardId of loadActiveGuardIds()) {
      if (aggregate[guardId]) continue;
      report.warn(
        `Dead guard candidate: ${guardId} has 0 recorded events in recent handoff telemetry.`,
        {
          remediation:
            'Review whether the guard is niche-but-valid, under-adopted in telemetry handoffs, or a candidate for removal/tuning.',
        },
      );
    }
  } else {
    report.info(
      `Dead-guard analysis deferred until at least ${MIN_COVERED_SESSIONS_FOR_ANALYSIS} telemetry-bearing handoffs and ${(MIN_COVERAGE_RATIO_FOR_DEAD_GUARD_ALERTS * 100).toFixed(0)}% coverage exist.`,
    );
  }

  report.finish();
}

async function handoffSectionMode(): Promise<void> {
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
  const summary = summarizeGuardTelemetry(events, SESSION_ARTIFACT_PATH);
  process.stdout.write(`${renderGuardTelemetryHandoffSection(summary)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--handoff-section')) {
    await handoffSectionMode();
    return;
  }
  await reportMode();
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(
      `guard-telemetry crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(2);
  });
}
