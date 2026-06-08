#!/usr/bin/env node
/**
 * docs/archive-handoffs.ts — Move handoff files older than 30 days into
 * `docs/knowledge/handoffs/archive/`.
 *
 * Age is determined by the leading `YYYY-MM-DD-` prefix in the filename, NOT
 * by filesystem mtime — handoff filenames are the canonical source of truth
 * and survive git clones / worktree copies.
 *
 * Dry-run by default. Pass `--apply` (or set `AUTOMATION_APPLY=1`) to actually
 * move files. Workflow uses `--apply` then opens a PR with the moves.
 *
 * Exit code is always 0; "did anything change" is reported via stdout summary
 * + the file count, which the workflow uses to decide whether to open a PR.
 */

import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const ARCHIVE_DIR = 'docs/knowledge/handoffs/archive';
const MAX_AGE_DAYS = 30;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})-/;

function parseDateFromName(name: string): Date | null {
  const m = DATE_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (!y || !mo || !d) return null;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

async function main(): Promise<void> {
  const report = new Report('docs-archive-handoffs');
  const apply = process.argv.includes('--apply') || process.env.AUTOMATION_APPLY === '1';
  const today = new Date();
  const absHandoffs = fromRepo(HANDOFFS_DIR);
  const absArchive = fromRepo(ARCHIVE_DIR);

  let entries: string[];
  try {
    entries = readdirSync(absHandoffs);
  } catch {
    report.warn(`No handoffs directory at ${HANDOFFS_DIR}; nothing to do.`);
    report.finish();
  }

  mkdirSync(absArchive, { recursive: true });

  let moved = 0;
  let wouldMove = 0;

  for (const entry of entries!) {
    if (entry === 'archive' || entry === 'TEMPLATE.md') continue;
    const abs = path.join(absHandoffs, entry);
    const stat = statSync(abs);
    if (!stat.isFile()) continue;
    const date = parseDateFromName(entry);
    if (!date) {
      report.warn(`Handoff filename missing YYYY-MM-DD- prefix; skipping.`, {
        file: `${HANDOFFS_DIR}/${entry}`,
      });
      continue;
    }
    const age = daysBetween(today, date);
    if (age <= MAX_AGE_DAYS) continue;
    const dest = path.join(absArchive, entry);
    if (apply) {
      renameSync(abs, dest);
      moved += 1;
      report.info(`Archived ${entry} (age ${age}d).`);
    } else {
      wouldMove += 1;
      report.info(`[dry-run] Would archive ${entry} (age ${age}d).`);
    }
  }

  if (apply) {
    process.stdout.write(`Archived ${moved} handoff file(s).\n`);
  } else {
    process.stdout.write(
      `Dry-run: ${wouldMove} handoff file(s) over ${MAX_AGE_DAYS}d. Re-run with --apply to move.\n`,
    );
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`archive-handoffs crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
