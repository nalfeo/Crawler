#!/usr/bin/env node
/**
 * health/untested-systems.ts — For each ECS system under `src/core/systems/`,
 * verify a corresponding test file exists somewhere under `tests/`.
 *
 * Match heuristic:
 *   `src/core/systems/fooSystem.ts` matches any test file whose path contains
 *   `foo` (case-insensitive) AND ends in `.test.ts` or `.spec.ts`.
 *
 * Shared-lab systems (see scripts/agent/lab-gate-check.sh) are excluded only
 * if their shared lab itself has a test file mentioning them.
 *
 * Exits 1 on any missing system → blocking.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const SYSTEMS_DIR = 'src/core/systems';
const TESTS_DIR = 'tests';

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else if (e.endsWith('.test.ts') || e.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function systemSlug(file: string): string {
  return path
    .basename(file, '.ts')
    .replace(/System$/, '')
    .toLowerCase();
}

async function main(): Promise<void> {
  const report = new Report('health-untested-systems');
  const absSystems = fromRepo(SYSTEMS_DIR);
  let systemFiles: string[];
  try {
    systemFiles = readdirSync(absSystems)
      .filter((e) => e.endsWith('.ts') && e !== 'index.ts')
      .map((e) => path.join(absSystems, e));
  } catch {
    report.warn(`No systems directory at ${SYSTEMS_DIR}.`);
    report.finish();
  }

  const testFiles = walk(fromRepo(TESTS_DIR));
  const haystack = testFiles.map((t) => t.toLowerCase());

  for (const sys of systemFiles!) {
    const slug = systemSlug(sys);
    if (slug.length < 3) continue; // avoid trivial matches
    const matched = haystack.some((t) => t.includes(slug));
    const rel = path.relative(fromRepo(), sys).replace(/\\/g, '/');
    if (!matched) {
      report.error(`No test file found for system: ${rel} (looked for "${slug}")`, {
        file: rel,
        remediation: `Add tests under tests/ whose path includes "${slug}".`,
      });
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`untested-systems crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
