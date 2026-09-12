#!/usr/bin/env node
/**
 * Summarize a local Codex rollout JSONL and stop a session before its token
 * budget becomes an accidental cost or compaction problem. The rollout schema
 * is append-only, so malformed/in-progress trailing lines are deliberately
 * ignored rather than making a live-session read fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const DEFAULT_THRESHOLDS = {
  currentInput: 50_000,
  cumulativeInput: 500_000,
  responses: 12,
  currentContextEstimate: 80_000,
  toolOutputChars: 10_000,
} as const;

export interface TokenBudgetSummary {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly responses: number;
  readonly toolCalls: number;
  readonly compactions: number;
  readonly currentInputTokens: number | null;
  readonly firstRequestInputTokens: number | null;
  readonly currentContextEstimate: number | null;
  readonly largestToolOutputChars: number;
}

export interface BudgetThresholds {
  readonly currentInput: number | null;
  readonly cumulativeInput: number | null;
  readonly responses: number | null;
  readonly currentContextEstimate: number | null;
  readonly toolOutputChars: number | null;
}

type MutableBudgetThresholds = {
  -readonly [Key in keyof BudgetThresholds]: BudgetThresholds[Key];
};

export interface BudgetCheck {
  readonly failures: string[];
  readonly warnings: string[];
}

type JsonRecord = { type?: unknown; payload?: unknown };

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function outputChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return value == null ? 0 : JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Parse known rollout records without trusting an unfinished final line. */
export function parseRolloutJsonl(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JsonRecord);
    } catch {
      // A live JSONL log can end mid-write.
    }
  }
  return records;
}

/** Reduce a Codex rollout to deterministic, additive counters. */
export function summarizeRollout(records: readonly JsonRecord[]): TokenBudgetSummary {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let responses = 0;
  let toolCalls = 0;
  let compactions = 0;
  let currentInputTokens: number | null = null;
  let firstRequestInputTokens: number | null = null;
  let largestToolOutputChars = 0;

  for (const record of records) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type === 'token_usage_record') {
      const usage = payload?.['usage'] as Record<string, unknown> | undefined;
      if (!usage) continue;
      const input = numberValue(usage['input_tokens']);
      const cached = Math.min(input, numberValue(usage['cached_input_tokens']));
      inputTokens += input;
      cachedInputTokens += cached;
      outputTokens += numberValue(usage['output_tokens']);
      reasoningTokens += numberValue(usage['reasoning_output_tokens']);
      currentInputTokens = input;
      firstRequestInputTokens ??= input;
      responses += 1;
      continue;
    }

    if (record.type === 'compacted') {
      compactions += 1;
      continue;
    }

    if (record.type !== 'response_item' || !payload) continue;
    const itemType = payload['type'];
    if (itemType === 'function_call' || itemType === 'custom_tool_call') toolCalls += 1;
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      largestToolOutputChars = Math.max(largestToolOutputChars, outputChars(payload['output']));
    }
  }

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    reasoningTokens,
    responses,
    toolCalls,
    compactions,
    currentInputTokens,
    firstRequestInputTokens,
    // Rollouts do not carry a separate context gauge. Latest request input is
    // the closest observable estimate and remains explicitly labelled as one.
    currentContextEstimate: currentInputTokens,
    largestToolOutputChars,
  };
}

export function checkBudget(
  summary: TokenBudgetSummary,
  thresholds: BudgetThresholds,
): BudgetCheck {
  const failures: string[] = [];
  const warnings: string[] = [];
  const check = (label: string, actual: number | null, limit: number | null): void => {
    if (actual != null && limit != null && actual > limit)
      failures.push(`${label} ${actual} > ${limit}`);
  };
  check('current input', summary.currentInputTokens, thresholds.currentInput);
  check('cumulative input', summary.inputTokens, thresholds.cumulativeInput);
  check('responses', summary.responses, thresholds.responses);
  check(
    'current-context estimate',
    summary.currentContextEstimate,
    thresholds.currentContextEstimate,
  );
  if (
    thresholds.toolOutputChars != null &&
    summary.largestToolOutputChars > thresholds.toolOutputChars
  ) {
    warnings.push(
      `largest tool output ${summary.largestToolOutputChars} chars > ${thresholds.toolOutputChars} chars`,
    );
  }
  return { failures, warnings };
}

function rolloutDirectory(): string {
  return join(homedir(), '.codex', 'sessions');
}

function findRollouts(directory: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) found.push(path);
    }
  };
  visit(directory);
  return found;
}

export function latestRolloutPath(directory = rolloutDirectory()): string {
  const rollouts = findRollouts(directory);
  if (rollouts.length === 0) throw new Error(`No rollout JSONL files found under ${directory}.`);
  return rollouts.sort(
    (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b),
  )[0]!;
}

function parseLimit(value: string | undefined, option: string): number | null {
  if (value == null) throw new Error(`Missing value for ${option}.`);
  if (value === 'off') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${option} must be a non-negative integer or "off".`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): {
  file: string;
  thresholds: BudgetThresholds;
  json: boolean;
} {
  const thresholds: MutableBudgetThresholds = { ...DEFAULT_THRESHOLDS };
  let file: string | undefined;
  let json = false;
  const options: Record<string, keyof BudgetThresholds> = {
    '--max-current-input': 'currentInput',
    '--max-cumulative-input': 'cumulativeInput',
    '--max-responses': 'responses',
    '--max-context': 'currentContextEstimate',
    '--max-tool-output-chars': 'toolOutputChars',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--file') file = argv[++index];
    else if (arg in options) thresholds[options[arg]!] = parseLimit(argv[++index], arg);
    else if (arg === '--help' || arg === '-h') throw new Error('HELP');
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!file) file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { file: file ? resolve(file) : latestRolloutPath(), thresholds, json };
}

export function renderReport(
  file: string,
  summary: TokenBudgetSummary,
  check: BudgetCheck,
): string {
  return [
    `Token budget: ${basename(file)}`,
    `  cumulative input: ${summary.inputTokens} (cached ${summary.cachedInputTokens}, uncached ${summary.uncachedInputTokens})`,
    `  output: ${summary.outputTokens} (reasoning ${summary.reasoningTokens})`,
    `  responses: ${summary.responses}; tool calls: ${summary.toolCalls}; compactions: ${summary.compactions}`,
    `  current request input: ${summary.currentInputTokens ?? 'unavailable'}`,
    `  first request input: ${summary.firstRequestInputTokens ?? 'unavailable'}`,
    `  current-context estimate: ${summary.currentContextEstimate ?? 'unavailable'}`,
    `  largest tool output: ${summary.largestToolOutputChars} chars`,
    ...check.warnings.map((warning) => `WARN: ${warning}`),
    ...check.failures.map((failure) => `EXCEEDED: ${failure}`),
  ].join('\n');
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const { file, thresholds, json } = parseArgs(argv);
    const summary = summarizeRollout(parseRolloutJsonl(readFileSync(file, 'utf8')));
    const check = checkBudget(summary, thresholds);
    process.stdout.write(
      `${json ? JSON.stringify({ file, summary, thresholds, check }, null, 2) : renderReport(file, summary, check)}\n`,
    );
    return check.failures.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof Error && error.message === 'HELP') {
      process.stdout.write(
        'Usage: npm run telemetry:token-budget -- [rollout.jsonl] [--file rollout.jsonl] [--json] [--max-current-input N|off] [--max-cumulative-input N|off] [--max-responses N|off] [--max-context N|off] [--max-tool-output-chars N|off]\n',
      );
      return 0;
    }
    process.stderr.write(
      `token-budget: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (process.argv[1]?.endsWith('token-budget.ts')) process.exitCode = main();
