#!/usr/bin/env node
/**
 * Keep the root agent startup contract compact and free of known prompt-bloat
 * regressions. This reads only the checked-in contract, never session logs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MAX_STARTUP_CONTRACT_CHARS = 12_000;

export const PROHIBITED_PATTERNS = [
  {
    label: 'exhaustive command catalog',
    pattern: /(?:^|\n)#+\s*(?:full |exhaustive )?command catalog\b/im,
  },
  {
    label: 'mandatory bulk-reading instruction',
    pattern:
      /(?:must|required to|always)\s+(?:bulk[- ]read|read)\s+(?:all|every)\s+(?:memory|handoff|knowledge)/i,
  },
] as const;

export interface StartupContractResult {
  readonly characterCount: number;
  readonly failures: readonly string[];
}

export function checkStartupContract(source: string): StartupContractResult {
  const failures: string[] = [];
  if (source.length > MAX_STARTUP_CONTRACT_CHARS) {
    failures.push(
      `root startup contract is ${source.length} characters; maximum is ${MAX_STARTUP_CONTRACT_CHARS}.`,
    );
  }
  for (const { label, pattern } of PROHIBITED_PATTERNS) {
    if (pattern.test(source)) failures.push(`root startup contract contains prohibited ${label}.`);
  }
  return { characterCount: source.length, failures };
}

export function formatStartupContractReport(result: StartupContractResult): string {
  const headroom = MAX_STARTUP_CONTRACT_CHARS - result.characterCount;
  return `AGENTS.md startup contract: ${result.characterCount}/${MAX_STARTUP_CONTRACT_CHARS} characters (${headroom} headroom).`;
}

export function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const source = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const result = checkStartupContract(source);
  process.stdout.write(`${formatStartupContractReport(result)}\n`);
  if (result.failures.length > 0) {
    for (const failure of result.failures) process.stderr.write(`ERROR: ${failure}\n`);
    process.stderr.write(
      'Keep AGENTS.md compact; link to detailed docs instead of copying them.\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
