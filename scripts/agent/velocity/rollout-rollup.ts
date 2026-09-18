#!/usr/bin/env node
/** Deterministic, bounded rollup for explicitly supplied rollout JSONL files. */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const MAX_FILES = 10;
export const MAX_LINES_PER_FILE = 100_000;
export const MAX_DIAGNOSTICS = 5;
export const MAX_PATH_LENGTH = 160;

type JsonRecord = Record<string, unknown>;
type Metric = number | null;

export interface RolloutStats {
  readonly path: string;
  readonly responseCount: Metric;
  readonly cumulativeInputTokens: Metric;
  readonly cachedInputTokens: Metric;
  readonly uncachedInputTokens: Metric;
  readonly outputTokens: Metric;
  readonly reasoningTokens: Metric;
  readonly cacheHitPercentage: Metric;
  readonly compactionCount: Metric;
  readonly toolCallCount: Metric;
  readonly medianInputTokens: Metric;
  readonly maxInputTokens: Metric;
  readonly malformedLineCount: number;
  readonly unknownEventCount: number;
  readonly truncated: boolean;
}

export interface RollupReport {
  readonly files: readonly RolloutStats[];
  readonly aggregate: RolloutStats;
  readonly diagnostics: readonly string[];
  readonly capped: boolean;
}

const inputSamplesByStats = new WeakMap<RolloutStats, readonly number[]>();

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function metricSum(values: readonly Metric[]): Metric {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function compactPath(path: string): string {
  return path.length <= MAX_PATH_LENGTH ? path : `…${path.slice(-(MAX_PATH_LENGTH - 1))}`;
}

function emptyStats(path: string): RolloutStats {
  return {
    path,
    responseCount: null,
    cumulativeInputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheHitPercentage: null,
    compactionCount: null,
    toolCallCount: null,
    medianInputTokens: null,
    maxInputTokens: null,
    malformedLineCount: 0,
    unknownEventCount: 0,
    truncated: false,
  };
  };
}

export function parseRolloutFile(text: string, path: string): RolloutStats {
  const inputValues: number[] = [];
  let responseCount = 0;
  let cumulativeInput = 0;
  let cachedInput = 0;
  let output = 0;
  let reasoning = 0;
  let compactions = 0;
  let tools = 0;
  let hasUsage = false;
  let hasCompactions = false;
  let hasTools = false;
  let malformed = 0;
  let unknown = 0;
  let truncated = false;

  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (index >= MAX_LINES_PER_FILE) {
      truncated = lines.slice(index).some((line) => line.trim().length > 0);
      break;
    }
    const line = lines[index]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const event = record(parsed);
    const type = event?.type;
    const payload = record(event?.payload) ?? record(event?.data) ?? event;
    const usage = record(payload?.usage) ?? record(event?.usage);
    const input = finiteNonNegative(usage?.input_tokens ?? usage?.inputTokens);
    const isUsage =
      type === 'token_usage_record' || type === 'response.completed' || type === 'response';
    if (isUsage && input !== null) {
      const cached = finiteNonNegative(usage?.cached_input_tokens ?? usage?.cachedInputTokens);
      responseCount += 1;
      inputValues.push(input);
      cumulativeInput += input;
      cachedInput += Math.min(input, cached ?? 0);
      output += finiteNonNegative(usage?.output_tokens ?? usage?.outputTokens) ?? 0;
      reasoning += finiteNonNegative(usage?.reasoning_output_tokens ?? usage?.reasoningTokens) ?? 0;
      hasUsage = true;
      continue;
    }
    const itemType = payload?.type;
    if (type === 'compacted' || type === 'session.compaction_complete') {
      compactions += 1;
      hasCompactions = true;
      continue;
    }
    if (
      (type === 'response_item' &&
        (itemType === 'function_call' || itemType === 'custom_tool_call')) ||
      type === 'tool.execution_start' ||
      type === 'tool_call'
    ) {
      tools += 1;
      hasTools = true;
      continue;
    }
    if (
      ![
        'response_item',
        'token_usage_record',
        'response.completed',
        'response',
        'compacted',
        'session.compaction_complete',
      ].includes(String(type))
    ) {
      unknown += 1;
    }
  }
  const stats: RolloutStats = {
    ...emptyStats(path),
    responseCount: hasUsage ? responseCount : null,
    cumulativeInputTokens: hasUsage ? cumulativeInput : null,
    cachedInputTokens: hasUsage ? cachedInput : null,
    uncachedInputTokens: hasUsage ? cumulativeInput - cachedInput : null,
    outputTokens: hasUsage ? output : null,
    reasoningTokens: hasUsage ? reasoning : null,
    cacheHitPercentage:
      hasUsage && cumulativeInput > 0
        ? (cachedInput / cumulativeInput) * 100
        : hasUsage
          ? 0
          : null,
    compactionCount: hasCompactions ? compactions : null,
    toolCallCount: hasTools ? tools : null,
    medianInputTokens: median(inputValues),
    maxInputTokens: inputValues.length > 0 ? Math.max(...inputValues) : null,
    malformedLineCount: malformed,
    unknownEventCount: unknown,
    truncated,
  };
  inputSamplesByStats.set(stats, inputValues);
  return stats;
}

function aggregate(files: readonly RolloutStats[]): RolloutStats {
  const stats = emptyStats('aggregate');
  const sums = (key: keyof RolloutStats): Metric[] => files.map((file) => file[key] as Metric);
  const response = metricSum(sums('responseCount'));
  const totalInput = metricSum(sums('cumulativeInputTokens'));
  const cached = metricSum(sums('cachedInputTokens'));
  const allInputs = files.flatMap((file) => inputSamplesByStats.get(file) ?? []);
  const maxInputs = files.map((file) => file.maxInputTokens).filter((value): value is number => value !== null);
  return {
    ...stats,
    responseCount: response,
    cumulativeInputTokens: totalInput,
    cachedInputTokens: cached,
    uncachedInputTokens: metricSum(sums('uncachedInputTokens')),
    outputTokens: metricSum(sums('outputTokens')),
    reasoningTokens: metricSum(sums('reasoningTokens')),
    cacheHitPercentage:
      totalInput !== null && totalInput > 0 && cached !== null
        ? (cached / totalInput) * 100
        : totalInput === 0
          ? 0
          : null,
    compactionCount: metricSum(sums('compactionCount')),
    toolCallCount: metricSum(sums('toolCallCount')),
    medianInputTokens: median(allInputs),
    maxInputTokens: maxInputs.length > 0 ? Math.max(...maxInputs) : null,
    malformedLineCount: files.reduce((sum, file) => sum + file.malformedLineCount, 0),
    unknownEventCount: files.reduce((sum, file) => sum + file.unknownEventCount, 0),
    truncated: files.some((file) => file.truncated),
  };
}

export function rollup(paths: readonly string[]): RollupReport {
  if (paths.length === 0) throw new Error('Supply at least one rollout JSONL path.');
  if (paths.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} rollout paths are supported.`);
  const files: RolloutStats[] = [];
  const diagnostics: string[] = [];
  for (const path of [...paths].map(resolve).sort((a, b) => a.localeCompare(b))) {
    try {
      const stats = parseRolloutFile(readFileSync(path, 'utf8'), compactPath(path));
      files.push(stats);
      if (stats.malformedLineCount > 0) diagnostics.push(`${basename(path)}: ${stats.malformedLineCount} malformed line(s)`);
      if (stats.unknownEventCount > 0) diagnostics.push(`${basename(path)}: ${stats.unknownEventCount} unknown event(s)`);
      if (stats.truncated) diagnostics.push(`${basename(path)}: input capped at ${MAX_LINES_PER_FILE} lines`);
    } catch (error) {
      files.push(emptyStats(compactPath(path)));
      diagnostics.push(
        `${compactPath(path)}: unreadable (${error instanceof Error ? error.message.slice(0, 80) : 'unknown error'})`,
      );
    }
  }
  return {
    files,
    aggregate: aggregate(files),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    capped: diagnostics.length > MAX_DIAGNOSTICS,
  };
}

function display(value: Metric): string {
  return value === null ? 'unavailable' : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function renderReport(report: RollupReport): string {
  const lines = (stats: RolloutStats): string[] => [
    `responses=${display(stats.responseCount)} input=${display(stats.cumulativeInputTokens)} cached=${display(stats.cachedInputTokens)} uncached=${display(stats.uncachedInputTokens)} output=${display(stats.outputTokens)} reasoning=${display(stats.reasoningTokens)} cache-hit=${display(stats.cacheHitPercentage)}% compactions=${display(stats.compactionCount)} tools=${display(stats.toolCallCount)} median-input=${display(stats.medianInputTokens)} max-input=${display(stats.maxInputTokens)}`,
  ];
  return [
    ...report.files.map((file) => `${basename(file.path)}: ${lines(file)[0]}`),
    `aggregate: ${lines(report.aggregate)[0]}`,
    ...report.diagnostics.map((diagnostic) => `WARN: ${diagnostic}`),
  ].join('\n');
}

export function main(argv = process.argv.slice(2)): number {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(
        'Usage: npm run telemetry:rollup -- [--json] rollout-a.jsonl [rollout-b.jsonl ...]\\n',
      );
      return 0;
    }
    const json = argv.includes('--json');
    const paths = argv.filter((arg) => arg !== '--json');
    const report = rollup(paths);
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `rollout-rollup: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (process.argv[1]?.endsWith('rollout-rollup.ts')) process.exitCode = main();
