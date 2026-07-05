#!/usr/bin/env node
/**
 * docs/lint-handoff.ts — Guard the trimmed handoff format.
 *
 * The trimmed template (see docs/knowledge/handoffs/TEMPLATE.md) treats the
 * `## Retrospective` block as the highest-signal, must-fill part of a handoff.
 * A 2026-07-03 audit found the three retrospective subsections were being
 * skipped in ~85% of files, so this script blocks handoffs that leave them
 * empty or filled with placeholder text.
 *
 * Scope:
 *  - Runs against every file matching `docs/knowledge/handoffs/*.md` whose
 *    basename starts with `YYYY-MM-DD-`.
 *  - Skips `TEMPLATE.md` and anything under `archive/`.
 *  - Also skips legacy handoffs that predate the `## Retrospective` section
 *    (they were written before the retrospective requirement existed). The
 *    new template makes the section mandatory; the lint enforces its
 *    subsections only once a file has adopted the section.
 *
 * Rule:
 *  - Each of `### Lessons Learned`, `### Mistakes Made`, and
 *    `### Opportunities for Future Improvement` under `## Retrospective` must
 *    have at least one non-boilerplate line of prose. Empty subsections emit
 *    a blocking finding.
 *
 * "Empty" means any of:
 *  - blank (no non-whitespace lines)
 *  - all lines are HTML comments (`<!-- ... -->`)
 *  - the only prose is a single-word placeholder like `None`, `n/a`, `N/A`,
 *    `TBD`, `-`, `—`, `tbd`, `todo`, etc.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  extractRetrospectiveSubsections,
  hasRetrospectiveSection,
  subsectionIsEmpty,
} from './handoff-parse.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

const REQUIRED_SUBSECTIONS = [
  'Lessons Learned',
  'Mistakes Made',
  'Opportunities for Future Improvement',
] as const;

function listHandoffs(absDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e !== 'TEMPLATE.md' && e !== 'archive')
    .filter((e) => DATE_PREFIX.test(e) && e.endsWith('.md'))
    .filter((e) => {
      try {
        return statSync(path.join(absDir, e)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

async function main(): Promise<void> {
  const report = new Report('docs-lint-handoff');
  const absDir = fromRepo(HANDOFFS_DIR);
  const files = listHandoffs(absDir);
  if (files.length === 0) {
    report.warn(`No dated handoffs found in ${HANDOFFS_DIR}; nothing to lint.`);
    report.finish();
  }

  let checked = 0;
  let skipped = 0;
  for (const file of files) {
    const rel = `${HANDOFFS_DIR}/${file}`;
    let content: string;
    try {
      content = readFileSync(path.join(absDir, file), 'utf8');
    } catch (err) {
      report.error(`Failed to read ${rel}: ${err instanceof Error ? err.message : String(err)}`, {
        file: rel,
      });
      continue;
    }
    // Grandfather legacy handoffs that predate the ## Retrospective section.
    // The trimmed template makes it mandatory going forward; the lint enforces
    // its subsections only on files that have adopted the section. Uses the
    // shared, case-insensitive predicate so a lowercase `## retrospective`
    // heading is treated identically here and by the parser below (and by
    // promote-mistakes.ts) — otherwise it would slip past this skip while the
    // parser still recognised the section.
    if (!hasRetrospectiveSection(content)) {
      skipped += 1;
      continue;
    }
    checked += 1;
    const subs = extractRetrospectiveSubsections(content);
    const byTitle = new Map(subs.map((s) => [s.title.toLowerCase(), s]));
    for (const required of REQUIRED_SUBSECTIONS) {
      const sub = byTitle.get(required.toLowerCase());
      if (!sub) {
        report.error(`Missing "### ${required}" subsection under ## Retrospective.`, {
          file: rel,
          remediation: `Add a "### ${required}" subsection with at least one line of prose.`,
        });
        continue;
      }
      if (subsectionIsEmpty(sub)) {
        report.error(
          `"### ${required}" is empty or only contains placeholders (None / N/A / TBD / HTML comments).`,
          {
            file: rel,
            remediation:
              'Fill in at least one specific, non-boilerplate line so the next agent can compound on this session.',
          },
        );
      }
    }
  }
  report.info(
    `Linted ${checked} handoff file(s); skipped ${skipped} pre-retrospective legacy file(s).`,
  );
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`lint-handoff crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
