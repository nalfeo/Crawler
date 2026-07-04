#!/usr/bin/env node
/**
 * docs/promote-mistakes.ts — Promote `### Mistakes Made` blocks from handoffs
 * into the `Session_Mistakes` entity in `docs/knowledge/agent-memory.jsonl`.
 *
 * The 2026-07-03 audit found recurring mistakes (verify/prereq ordering,
 * Windows Git Bash slowness, etc.) recurring across sessions with no
 * cross-reference. Mistakes are written to handoffs but rarely re-read; this
 * script surfaces them in the memory graph the MCP memory server exposes at
 * session start, so the next agent catches them sooner.
 *
 * Behaviour:
 *  - Reads every `docs/knowledge/handoffs/YYYY-MM-DD-*.md` (skipping
 *    `TEMPLATE.md` and `archive/`).
 *  - Extracts the `### Mistakes Made` block from each.
 *  - If the block has any prose (same "substantive" rules as
 *    `lint-handoff.ts`), appends one observation to the `Session_Mistakes`
 *    entity keyed by the handoff filename, so re-runs are idempotent.
 *  - The entity is created if missing, matching the existing schema in
 *    `agent-memory.jsonl` (`type: entity`, `name`, `entityType`,
 *    `observations: string[]`).
 *  - Dry-run by default; `--apply` (or `AUTOMATION_APPLY=1`) writes the file.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import { findRetrospectiveSubsection, proseLinesOf } from './handoff-parse.js';
import {
  type Entity,
  DATE_PREFIX,
  ENTITY_NAME,
  ENTITY_TYPE,
  existingSlugs,
  observationForSlug,
  parseMemory,
  serializeMemory,
  slugFromFile,
  summarizeMistakes,
  upsertEntity,
} from './promote-mistakes-lib.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const MEMORY_FILE = 'docs/knowledge/agent-memory.jsonl';

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
  const report = new Report('docs-promote-mistakes');
  const apply = process.argv.includes('--apply') || process.env.AUTOMATION_APPLY === '1';
  const absHandoffs = fromRepo(HANDOFFS_DIR);
  const absMemory = fromRepo(MEMORY_FILE);

  const files = listHandoffs(absHandoffs);
  if (files.length === 0) {
    report.warn(`No dated handoffs found in ${HANDOFFS_DIR}; nothing to promote.`);
    report.finish();
  }

  let memoryRaw: string;
  try {
    memoryRaw = readFileSync(absMemory, 'utf8');
  } catch (err) {
    report.error(
      `Failed to read ${MEMORY_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      {
        file: MEMORY_FILE,
      },
    );
    report.finish();
  }

  const { records, malformedLines } = parseMemory(memoryRaw!);
  if (malformedLines.length > 0) {
    report.error(
      `${MEMORY_FILE} has ${malformedLines.length} malformed JSONL line(s) ` +
        `(first at line ${malformedLines[0]}). Refusing to process it: rewriting the ` +
        `file would silently delete those lines. Fix or remove them and re-run.`,
      {
        file: MEMORY_FILE,
        remediation: 'Repair the malformed line(s) so every non-empty line is valid JSON.',
      },
    );
    report.finish();
  }
  let entity = records.find((r): r is Entity => r.type === 'entity' && r.name === ENTITY_NAME);
  const entityExisted = Boolean(entity);
  if (!entity) {
    entity = {
      type: 'entity',
      name: ENTITY_NAME,
      entityType: ENTITY_TYPE,
      observations: [],
    };
  }

  const seenSlugs = existingSlugs(entity);

  let added = 0;
  let skippedEmpty = 0;
  let skippedDuplicate = 0;
  for (const file of files) {
    const slug = slugFromFile(file);
    if (seenSlugs.has(slug)) {
      skippedDuplicate += 1;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(path.join(absHandoffs, file), 'utf8');
    } catch {
      continue;
    }
    // Scope extraction to the `### Mistakes Made` subsection *under*
    // `## Retrospective`, matching lint-handoff's grandfathering: handoffs that
    // predate the retrospective section are skipped rather than scanned loosely.
    const sub = findRetrospectiveSubsection(content, 'Mistakes Made');
    if (!sub) {
      skippedEmpty += 1;
      continue;
    }
    const lines = proseLinesOf(sub);
    if (lines.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    const summary = summarizeMistakes(lines);
    entity.observations.push(observationForSlug(slug, summary));
    seenSlugs.add(slug);
    added += 1;
    report.info(`${apply ? 'Promoted' : '[dry-run] Would promote'} mistakes from ${file}.`);
  }

  report.info(
    `Total: ${added} added, ${skippedDuplicate} already promoted, ${skippedEmpty} with no substantive Mistakes block.`,
  );

  if (added > 0 && apply) {
    const next = upsertEntity(records, entity);
    writeFileSync(absMemory, serializeMemory(next), 'utf8');
    report.info(
      `Wrote ${MEMORY_FILE} (${entityExisted ? 'appended to' : 'created'} ${ENTITY_NAME}).`,
    );
  } else if (added > 0) {
    report.info(`Dry-run: re-run with --apply to write ${MEMORY_FILE}.`);
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`promote-mistakes crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
