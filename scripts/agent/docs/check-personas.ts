#!/usr/bin/env node
/**
 * docs/check-personas.ts — Keep the agent persona system internally consistent
 * so the routing matrix can't silently drift.
 *
 * Deterministic, LLM-free. Asserts that every persona doc under
 * `docs/agent-os/personas/` (excluding the README index itself):
 *   1. Contains each required `##` section heading
 *      (Responsibilities, Constraints, Tools & Workflows, Quality Criteria,
 *      Collaborates with).
 *   2. Is listed in the README's "Persona Index" table by filename.
 *
 * It also flags the reverse: a persona file referenced by the README index
 * that does not exist on disk.
 *
 * Exit code is non-zero (blocking) when any persona file is missing a required
 * section or is absent from the README index.
 */

import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const PERSONA_DIR = 'docs/agent-os/personas';
const README = `${PERSONA_DIR}/README.md`;

const REQUIRED_SECTIONS = [
  'Responsibilities',
  'Constraints',
  'Tools & Workflows',
  'Quality Criteria',
  'Collaborates with',
] as const;

function listPersonaFiles(): ReadonlyArray<string> {
  return readdirSync(fromRepo(PERSONA_DIR))
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .sort();
}

function headingSet(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && match[1]) headings.add(match[1]);
  }
  return headings;
}

async function main(): Promise<void> {
  const report = new Report('docs-check-personas');

  let readmeText: string;
  try {
    readmeText = readFileSync(fromRepo(README), 'utf8');
  } catch {
    report.error(`Persona index is missing: \`${README}\``, {
      file: README,
      remediation: 'Restore the persona routing README that indexes every persona doc.',
    });
    report.finish();
    return;
  }

  const personaFiles = listPersonaFiles();
  if (personaFiles.length === 0) {
    report.warn('No persona docs found under the personas directory.', { file: PERSONA_DIR });
    report.finish();
    return;
  }

  // 1. Section completeness.
  for (const file of personaFiles) {
    const rel = `${PERSONA_DIR}/${file}`;
    const headings = headingSet(readFileSync(fromRepo(rel), 'utf8'));
    for (const section of REQUIRED_SECTIONS) {
      if (!headings.has(section)) {
        report.error(`Persona doc is missing required section "## ${section}".`, {
          file: rel,
          remediation: `Add a "## ${section}" section so every persona has a consistent shape.`,
        });
      }
    }
  }

  // 2. Index coverage (each persona file is referenced by the README).
  for (const file of personaFiles) {
    if (!readmeText.includes(file)) {
      report.error(`Persona doc is not listed in the README persona index: \`${file}\`.`, {
        file: README,
        remediation: `Add \`${file}\` to the "Persona Index" table in ${README}.`,
      });
    }
  }

  // 3. Reverse check: README must not reference a persona file that is absent.
  const known = new Set(personaFiles);
  const referenced = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /`([a-z0-9-]+\.md)`/g;
  while ((m = re.exec(readmeText)) !== null) {
    if (m[1] && m[1] !== 'README.md') referenced.add(m[1]);
  }
  for (const ref of referenced) {
    if (!known.has(ref)) {
      report.error(`README persona index references a missing persona file: \`${ref}\`.`, {
        file: README,
        remediation: `Create ${PERSONA_DIR}/${ref} or remove the stale reference from the index.`,
      });
    }
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-personas crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
