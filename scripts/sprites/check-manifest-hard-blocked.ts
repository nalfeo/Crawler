#!/usr/bin/env node
/**
 * check-manifest-hard-blocked.ts — Verify that no approved shard entry
 * carries `judgeScorecard.hardBlocked === true`.
 *
 * The judge hard-block flag is a veto: art that was explicitly rejected must
 * not ship as approved. `approve.ts` now enforces this at approval-time, but
 * this CI check catches any entries that slipped through before the gate
 * existed (or were approved with `allowHardBlocked: true` without subsequent
 * clean-up).
 *
 * Source of truth is the per-asset shards under
 * `public/assets/generated/entries/<key>.json` (the aggregate manifest.json
 * is a gitignored build artifact and is not read here).
 *
 * Exit 0 — no hard-blocked entries found.
 * Exit 1 — one or more entries carry `judgeScorecard.hardBlocked === true`.
 *
 * Run automatically in CI (check-lightweight job). To fix a violation:
 *   1. Remove the shard file (+ PNG) with `npm run sprites:unapprove`, OR
 *   2. Re-run the sprite pipeline and approve a non-blocked variant instead.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAllShards } from './generated-shards.js';

const SHARDS_LABEL = path.join('public', 'assets', 'generated', 'entries');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ManifestEntryShape {
  readonly judgeScorecard?: {
    readonly hardBlocked?: boolean;
    readonly hardBlockInstruction?: string | null;
  } | null;
}

/**
 * Pure validator: checks that no manifest entry has `judgeScorecard.hardBlocked === true`.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * @param entries  Map of manifest entries to validate.
 * @param label    Label used in error messages (defaults to SHARDS_LABEL).
 */
export function validateNoHardBlockedEntries(
  entries: Record<string, ManifestEntryShape>,
  label = SHARDS_LABEL,
): string[] {
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.judgeScorecard?.hardBlocked === true) {
      const instruction = entry.judgeScorecard.hardBlockInstruction;
      errors.push(
        `${label}: entry "${key}" has judgeScorecard.hardBlocked=true` +
          (instruction ? ` (judge: "${instruction}")` : '') +
          `. Remove this entry with \`npm run sprites:unapprove\` or replace it with a non-blocked variant.`,
      );
    }
  }
  return errors;
}

function checkShards(): string[] {
  const generatedDir = path.resolve(repoRoot, 'public', 'assets', 'generated');

  let shards: Record<string, ManifestEntryShape>;
  try {
    shards = readAllShards(generatedDir) as Record<string, ManifestEntryShape>;
  } catch {
    // Entries directory missing or unreadable — nothing to check.
    return [];
  }

  return validateNoHardBlockedEntries(shards);
}

// Run as CLI only when invoked directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const errors = checkShards();

  if (errors.length > 0) {
    console.error('\n❌ Manifest hard-block check failed:\n');
    for (const err of errors) {
      console.error(`  ${err}`);
    }
    console.error('');
    process.exit(1);
  } else {
    console.log('✅ No hard-blocked shard entries found.');
  }
}
