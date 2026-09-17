#!/usr/bin/env node
/**
 * Report the small, allowlisted set of checked-in documents that the root
 * agent contract makes part of startup. This deliberately does not discover
 * files: a repository walk would make both the cost and this report unstable.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CHARS_PER_TOKEN = 3;
export const MAX_CONTEXT_ITEMS = 6;
export const MAX_OUTPUT_CHARS = 4_096;

export interface ContextItem {
  readonly path: string;
  readonly bytes: number;
  /** Conservative UTF-8 character upper bound; content is never read. */
  readonly characters: number;
  readonly estimatedTokens: number;
  readonly included: boolean;
  readonly reason: string;
}

export interface StartupContextInventory {
  readonly items: readonly ContextItem[];
  readonly totals: {
    readonly bytes: number;
    readonly characters: number;
    readonly estimatedTokens: number;
  };
}

type Source = Readonly<{ path: string; reason: string; optional?: boolean }>;

// Keep this list in the same order-independent, explicit shape as AGENTS.md.
// Do not add task-selected personas or handoffs: those are selected after
// startup and would turn this into a repository scan rather than an inventory.
export const STARTUP_CONTEXT_SOURCES: readonly Source[] = [
  {
    path: '.github/copilot-instructions.md',
    reason: 'optional GitHub Copilot instruction pointer',
    optional: true,
  },
  { path: 'AGENTS.md', reason: 'canonical root agent startup contract' },
  {
    path: 'docs/agent-os/personas/README.md',
    reason: 'persona routing matrix explicitly required by the contract',
  },
  {
    path: 'docs/agent-os/policies/change-risk-policy.md',
    reason: 'risk policy explicitly required before implementation',
  },
  {
    path: 'docs/knowledge/handoffs/INDEX.md',
    reason: 'handoff index explicitly required before planning',
  },
  {
    path: 'docs/knowledge/memory/README.md',
    reason: 'memory entry point explicitly referenced by the contract',
  },
] as const;

function normalized(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

function tokens(characters: number): number {
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

export function collectStartupContextInventory(repoRoot: string): StartupContextInventory {
  const items = STARTUP_CONTEXT_SOURCES.map((source): ContextItem => {
    const filePath = path.join(repoRoot, source.path);
    if (!existsSync(filePath)) {
      return {
        path: normalized(source.path),
        bytes: 0,
        characters: 0,
        estimatedTokens: 0,
        included: false,
        reason: source.optional ? `${source.reason}; absent` : `${source.reason}; missing`,
      };
    }
    const bytes = statSync(filePath).size;
    // UTF-8 code units never outnumber bytes. Reporting this upper bound keeps
    // the estimate conservative without reading the handoff or memory bodies.
    const characters = bytes;
    return {
      path: normalized(source.path),
      bytes,
      characters,
      estimatedTokens: tokens(characters),
      included: true,
      reason: source.reason,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  if (items.length > MAX_CONTEXT_ITEMS)
    throw new Error('startup context inventory exceeds its fixed cap');
  const totals = items.reduce(
    (total, item) => ({
      bytes: total.bytes + item.bytes,
      characters: total.characters + item.characters,
      estimatedTokens: total.estimatedTokens + item.estimatedTokens,
    }),
    { bytes: 0, characters: 0, estimatedTokens: 0 },
  );
  return { items, totals };
}

export function formatStartupContextInventory(inventory: StartupContextInventory): string {
  const lines = ['Startup context inventory (allowlisted; estimate = ceil(characters / 3)):'];
  for (const item of inventory.items) {
    lines.push(
      `${item.path}\t${item.bytes} bytes\t≤${item.characters} chars\t~${item.estimatedTokens} tokens\t${item.included ? 'included' : 'absent'}\t${item.reason}`,
    );
  }
  lines.push(
    `TOTAL\t${inventory.totals.bytes} bytes\t≤${inventory.totals.characters} chars\t~${inventory.totals.estimatedTokens} tokens`,
  );
  const report = `${lines.join('\n')}\n`;
  if (report.length > MAX_OUTPUT_CHARS)
    throw new Error(`startup context report exceeds ${MAX_OUTPUT_CHARS} character cap`);
  return report;
}

export function main(args: readonly string[]): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const inventory = collectStartupContextInventory(repoRoot);
  if (args.length > 1 || (args[0] && args[0] !== '--json')) {
    throw new Error('usage: startup-context-inventory [--json]');
  }
  const output =
    args[0] === '--json'
      ? `${JSON.stringify(inventory)}\n`
      : formatStartupContextInventory(inventory);
  if (output.length > MAX_OUTPUT_CHARS)
    throw new Error(`startup context report exceeds ${MAX_OUTPUT_CHARS} character cap`);
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
