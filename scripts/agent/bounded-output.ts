/**
 * Run an agent-facing command while keeping its durable result bounded. This is
 * intentionally an opt-in wrapper: CI and normal developer commands retain
 * their native streams, while broad inspection/test/log commands can be made
 * safe to place in an agent conversation.
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_MAX_CHARS = 8_000;
export const DEFAULT_MAX_LINES = 200;
export const MAX_OPT_IN_CHARS = 64_000;
export const MAX_OPT_IN_LINES = 2_000;

export interface OutputLimits {
  readonly maxChars: number;
  readonly maxLines: number;
}

function clip(value: string, length: number, fromEnd: boolean): string {
  if (value.length <= length) return value;
  return fromEnd ? value.slice(-length) : value.slice(0, length);
}

/** Keep both the opening context and the final diagnostic tail within hard caps. */
export function boundOutput(value: string, limits: OutputLimits): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/u);
  if (value.length <= limits.maxChars && lines.length <= limits.maxLines)
    return { text: value, truncated: false };

  // Keep this deliberately short so it remains visible even in a small,
  // explicitly requested cap. The CLI help documents the expansion knobs.
  const marker = '[agent-output truncated]';
  const availableLines = Math.max(0, limits.maxLines - 1);
  const headLineCount = Math.ceil(availableLines / 2);
  const tailLineCount = availableLines - headLineCount;
  const head = lines.slice(0, headLineCount).join('\n');
  const tail = tailLineCount === 0 ? '' : lines.slice(-tailLineCount).join('\n');
  const availableChars = Math.max(0, limits.maxChars - marker.length - (head && tail ? 2 : 1));
  const headChars = Math.ceil(availableChars / 2);
  const tailChars = availableChars - headChars;
  const parts = [clip(head, headChars, false), marker];
  if (tail) parts.push(clip(tail, tailChars, true));
  return { text: parts.join('\n'), truncated: true };
}

export function formatCommandOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  limits: OutputLimits,
): string {
  const streams = [stdout, stderr ? `--- stderr ---\n${stderr}` : ''].filter(Boolean).join('\n');
  const footer = `Exit status: ${exitCode}`;
  const bounded = boundOutput(streams, {
    maxChars: Math.max(0, limits.maxChars - footer.length - 1),
    maxLines: Math.max(1, limits.maxLines - 1),
  });
  return `${bounded.text}${bounded.text && !bounded.text.endsWith('\n') ? '\n' : ''}${footer}`;
}

function parseLimit(
  value: string | undefined,
  option: string,
  minimum: number,
  ceiling: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > ceiling)
    throw new Error(`${option} must be an integer from ${minimum} to ${ceiling}.`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): { limits: OutputLimits; command: string; args: string[] } {
  let maxChars = DEFAULT_MAX_CHARS;
  let maxLines = DEFAULT_MAX_LINES;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--max-chars') maxChars = parseLimit(argv[++index], arg, 64, MAX_OPT_IN_CHARS);
    else if (arg === '--max-lines') maxLines = parseLimit(argv[++index], arg, 2, MAX_OPT_IN_LINES);
    else if (arg === '--help' || arg === '-h') throw new Error('HELP');
    else throw new Error(`Unknown option: ${arg}. Put the command after --.`);
  }
  const command = argv[index];
  if (!command) throw new Error('Missing command. Usage: npm run agent:run -- [limits] -- <command> [args...]');
  return { limits: { maxChars, maxLines }, command, args: argv.slice(index + 1) };
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const { limits, command, args } = parseArgs(argv);
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
    if (result.error) throw result.error;
    const exitCode = result.status ?? 1;
    process.stdout.write(`${formatCommandOutput(result.stdout ?? '', result.stderr ?? '', exitCode, limits)}\n`);
    return exitCode;
  } catch (error) {
    if (error instanceof Error && error.message === 'HELP') {
      process.stdout.write('Usage: npm run agent:run -- [--max-chars 64..64000] [--max-lines 2..2000] -- <command> [args...]\n');
      return 0;
    }
    process.stderr.write(`agent:run: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1]?.endsWith('bounded-output.ts')) process.exitCode = main();
