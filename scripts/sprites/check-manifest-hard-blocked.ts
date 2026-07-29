#!/usr/bin/env node
/**
 * check-manifest-hard-blocked.ts — Verify that no approved manifest entry
 * carries `judgeScorecard.hardBlocked === true`.
 *
 * The judge hard-block flag is a veto: art that was explicitly rejected must
 * not ship as approved. `approve.ts` now enforces this at approval-time, but
 * this CI check catches any entries that slipped through before the gate
 * existed (or were approved with `allowHardBlocked: true` without subsequent
 * clean-up).
 *
 * Exit 0 — no hard-blocked entries found.
 * Exit 1 — one or more entries carry `judgeScorecard.hardBlocked === true`.
 *
 * Run automatically in CI (check-lightweight job). To fix a violation:
 *   1. Remove the entry with `npm run sprites:unapprove` (or manually delete
 *      the key from manifest.json + the corresponding asset PNG), OR
 *   2. Re-run the sprite pipeline and approve a non-blocked variant instead.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ManifestEntryShape {
  readonly judgeScorecard?: {
    readonly hardBlocked?: boolean;
    readonly hardBlockInstruction?: string | null;
  } | null;
}

export interface ManifestShape {
  readonly version?: number;
  readonly entries?: Record<string, ManifestEntryShape>;
}

/**
 * Pure validator: checks that no manifest entry has `judgeScorecard.hardBlocked === true`.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * @param entries  Map of manifest entries to validate.
 * @param label    File label used in error messages (defaults to MANIFEST_PATH).
 */
export function validateNoHardBlockedEntries(
  entries: Record<string, ManifestEntryShape>,
  label = MANIFEST_PATH,
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

function checkManifest(): string[] {
  const absPath = path.resolve(repoRoot, MANIFEST_PATH);

  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(readFileSync(absPath, 'utf8')) as ManifestShape;
  } catch {
    return [`Cannot parse ${MANIFEST_PATH}`];
  }

  if (!manifest.entries || typeof manifest.entries !== 'object') {
    return [`${MANIFEST_PATH}: missing "entries" object`];
  }

  return validateNoHardBlockedEntries(manifest.entries);
}

// Run as CLI only when invoked directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const errors = checkManifest();

  if (errors.length > 0) {
    console.error('\n❌ Manifest hard-block check failed:\n');
    for (const err of errors) {
      console.error(`  ${err}`);
    }
    console.error('');
    process.exit(1);
  } else {
    console.log('✅ No hard-blocked entries found in manifest.json.');
  }
}
