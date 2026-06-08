#!/usr/bin/env node
/**
 * docs/stale-game-design.ts — Flag game-design docs not touched and not
 * referenced anywhere else in the repo for the past 90 days.
 *
 * "Touched" = last git commit affecting the file.
 * "Referenced" = grep across handoffs + ADRs + src/ for the filename.
 *
 * Exits 0 on findings (informational) so the workflow can aggregate them
 * without failing the run; bumps severity to `warn` for visibility.
 */

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const GD_DIR = 'docs/knowledge/game-design';
const MAX_AGE_DAYS = 90;
const SEARCH_ROOTS = ['docs/knowledge/adr', 'docs/knowledge/handoffs', 'src'];

function lastCommitDays(rel: string): number | null {
  try {
    const out = execSync(`git log -1 --format=%ct -- "${rel}"`, {
      cwd: fromRepo(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!out) return null;
    const ts = Number.parseInt(out, 10) * 1000;
    return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

function isReferencedRecently(filename: string): boolean {
  // Use git grep for speed; ignore errors (e.g. no match -> exit 1).
  try {
    const stripped = filename.replace(/\.md$/, '');
    execSync(
      `git --no-pager grep -l -F "${stripped}" -- ${SEARCH_ROOTS.map((r) => `"${r}"`).join(' ')}`,
      { cwd: fromRepo(), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const report = new Report('docs-stale-game-design');
  let entries: string[];
  try {
    entries = readdirSync(fromRepo(GD_DIR)).filter((e) => e.endsWith('.md'));
  } catch {
    report.warn(`No game-design dir at ${GD_DIR}.`);
    report.finish();
  }

  for (const entry of entries!) {
    const rel = path.posix.join(GD_DIR, entry);
    const age = lastCommitDays(rel);
    if (age === null) {
      report.info(`${rel}: no git history (untracked or new file).`);
      continue;
    }
    if (age <= MAX_AGE_DAYS) continue;
    if (isReferencedRecently(entry)) {
      report.info(`${rel}: ${age}d old but still referenced.`);
      continue;
    }
    report.warn(`Stale game-design doc: ${rel} (${age}d, no references).`, {
      file: rel,
      remediation:
        'Confirm the doc is still source-of-truth, fold it into a current doc, or move to docs/knowledge/archive/.',
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`stale-game-design crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
