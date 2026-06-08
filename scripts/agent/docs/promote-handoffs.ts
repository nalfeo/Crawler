#!/usr/bin/env node
/**
 * docs/promote-handoffs.ts — Surface handoffs that are heavily referenced by
 * newer handoffs/ADRs as candidates to promote into a proper ADR.
 *
 * Heuristic: a handoff with ≥3 incoming references from files newer than
 * itself is likely capturing durable knowledge that deserves a permanent home.
 *
 * Emits informational findings only (no blocking exit).
 */

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const PROMOTION_THRESHOLD = 3;
const SEARCH_ROOTS = ['docs/knowledge/adr', 'docs/knowledge/handoffs'];

function countReferences(filename: string, sinceDate: string): number {
  try {
    // git log --name-only since the handoff was written, then grep files for
    // a literal mention of the slug.
    const slug = filename.replace(/\.md$/, '');
    const matches = execSync(
      `git --no-pager grep -l -F "${slug}" -- ${SEARCH_ROOTS.map((r) => `"${r}"`).join(' ')}`,
      { cwd: fromRepo(), stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((p) => !p.endsWith(`/${filename}`));
    // Filter to files modified after sinceDate.
    let count = 0;
    for (const ref of matches) {
      try {
        const ts = execSync(`git log -1 --format=%cI -- "${ref}"`, {
          cwd: fromRepo(),
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (ts && ts > sinceDate) count += 1;
      } catch {
        // ignore
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const report = new Report('docs-promote-handoffs');
  let entries: string[];
  try {
    entries = readdirSync(fromRepo(HANDOFFS_DIR)).filter(
      (e) => e.endsWith('.md') && /^\d{4}-\d{2}-\d{2}-/.test(e),
    );
  } catch {
    report.warn(`No handoffs dir at ${HANDOFFS_DIR}.`);
    report.finish();
  }

  for (const entry of entries!) {
    const m = /^(\d{4}-\d{2}-\d{2})-/.exec(entry);
    if (!m) continue;
    const since = `${m[1]}T00:00:00+00:00`;
    const refCount = countReferences(entry, since);
    if (refCount >= PROMOTION_THRESHOLD) {
      report.info(
        `Promotion candidate: ${path.posix.join(HANDOFFS_DIR, entry)} (${refCount} newer references) — consider promoting to ADR.`,
      );
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`promote-handoffs crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
