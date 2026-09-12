#!/usr/bin/env node
/** Create the compact, deterministic state transfer for a fresh agent thread. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseRolloutJsonl, summarizeRollout } from '../velocity/token-budget.js';

export const MAX_WORDS = 1_500;
const REQUIRED = [
  'objective',
  'successGate',
  'completed',
  'validation',
  'blockers',
  'nextStep',
] as const;

export type ContinuationInput = Record<(typeof REQUIRED)[number], string> & {
  branch: string;
  base: string;
  changedFiles: readonly string[];
  telemetry?: { firstRequestInputTokens: number | null; inputTokens: number };
};

function words(value: string): number {
  return value.trim().match(/\S+/gu)?.length ?? 0;
}

function required(input: ContinuationInput): void {
  for (const key of REQUIRED)
    if (!input[key].trim())
      throw new Error(
        `Missing required --${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} value.`,
      );
}

export function buildContinuationHandoff(input: ContinuationInput): string {
  required(input);
  const files =
    input.changedFiles.length === 0
      ? '(none)'
      : input.changedFiles.map((file) => `- \`${file}\``).join('\n');
  const telemetry = input.telemetry
    ? `\n## Rollout Telemetry\n\n- First request input: ${input.telemetry.firstRequestInputTokens ?? 'unavailable'} tokens\n- Cumulative input: ${input.telemetry.inputTokens} tokens\n`
    : '';
  const output = `# Continuation Handoff\n\n## Objective / Success Gate\n\n${input.objective}\n\nSuccess gate: ${input.successGate}\n\n## Git State\n\n- Branch: \`${input.branch}\`\n- Base: \`${input.base}\`\n- Changed files:\n${files}\n\n## Completed Decisions\n\n${input.completed}\n\n## Validation Evidence\n\n${input.validation}\n\n## Unresolved Blockers\n\n${input.blockers}\n\n## Next Concrete Step\n\n${input.nextStep}\n${telemetry}`;
  if (words(output) > MAX_WORDS)
    throw new Error(
      `Continuation handoff is ${words(output)} words; maximum is ${MAX_WORDS}. Shorten a supplied field.`,
    );
  return output;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function args(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === '--help' || key === '-h') throw new Error('HELP');
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    result[key.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return result;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const options = args(argv);
    const base = options.base ?? 'main';
    const input: ContinuationInput = {
      objective: options.objective ?? '',
      successGate: options.successGate ?? '',
      completed: options.completed ?? '',
      validation: options.validation ?? '',
      blockers: options.blockers ?? '',
      nextStep: options.nextStep ?? '',
      branch: options.branch ?? git('branch', '--show-current'),
      base,
      changedFiles: (options.changedFiles ?? git('diff', '--name-only', `${base}...HEAD`))
        .split(/\r?\n/u)
        .filter(Boolean),
    };
    if (options.rollout) {
      const summary = summarizeRollout(parseRolloutJsonl(readFileSync(options.rollout, 'utf8')));
      input.telemetry = {
        firstRequestInputTokens: summary.firstRequestInputTokens,
        inputTokens: summary.inputTokens,
      };
    }
    process.stdout.write(`${buildContinuationHandoff(input)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === 'HELP') {
      process.stdout.write(
        'Usage: npm run handoff:continue -- --objective TEXT --success-gate TEXT --completed TEXT --validation TEXT --blockers TEXT --next-step TEXT [--base main] [--branch NAME] [--changed-files FILES] [--rollout rollout.jsonl]\n',
      );
      return 0;
    }
    process.stderr.write(
      `continuation-handoff: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (process.argv[1]?.endsWith('continuation-handoff.ts')) process.exitCode = main();
