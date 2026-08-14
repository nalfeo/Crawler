#!/usr/bin/env node
/**
 * Validate the provenance boundary around the canonical Lore Bible.
 *
 * This is deliberately deterministic: it checks repository paths, required
 * canon-maintenance sections, and unresolved escalation records. It does not
 * infer narrative truth or silently select a source when claims conflict.
 */

import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

export const LORE_BIBLE_PATH = 'docs/knowledge/game-design/lore-bible.md';
export const CONTRADICTIONS_PATH = 'docs/knowledge/game-design/lore-contradictions.md';

export interface LoreCanonValidation {
  readonly missingSections: string[];
  readonly missingSources: string[];
  readonly missingSourceDeclarations: string[];
  readonly unresolvedContradictions: boolean;
}

const REQUIRED_SECTIONS = [
  '## Canon maintenance contract',
  '## Official source register',
  '## The Gradient',
  '## The Director',
  '## The Dungeon',
  '## Season Quirks (Procedural Personality Modifiers)',
  '## Sponsor Companies (Procedural)',
  '## Timeline',
  '## Tone Guide',
];

/**
 * Strip fenced code blocks (```...```) so the record template's example
 * (which must literally read `Status: unresolved` to match the syntax this
 * checker enforces) does not itself trip the hard gate before any real
 * escalation record is copied out of the fence.
 */
function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate a required heading as a complete line (e.g. `## The Director`),
 * not merely as a substring. A substring match would accept a demoted
 * heading such as `### The Director` or an incidental mention elsewhere.
 */
function findHeadingIndex(text: string, heading: string): number {
  const match = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm').exec(text);
  return match ? match.index : -1;
}

function pathExists(relativePath: string): boolean {
  try {
    statSync(fromRepo(relativePath));
    return true;
  } catch {
    return false;
  }
}

function sourcePaths(text: string): string[] {
  return [...text.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)].flatMap((match) =>
    match[1] && !match[1].startsWith('http') ? [match[1]] : [],
  );
}

function resolveMarkdownPath(source: string): string {
  return path.normalize(path.join(path.dirname(LORE_BIBLE_PATH), source)).replaceAll(path.sep, '/');
}

export function validateLoreCanon(
  loreText: string,
  contradictionText: string,
): LoreCanonValidation {
  const missingSections = REQUIRED_SECTIONS.filter(
    (section) => findHeadingIndex(loreText, section) === -1,
  );
  const citedSources = sourcePaths(loreText);
  const missingSources = citedSources
    .map(resolveMarkdownPath)
    .filter((source) => !pathExists(source));
  const missingSourceDeclarations = REQUIRED_SECTIONS.filter((section) => {
    const start = findHeadingIndex(loreText, section);
    if (start === -1) return false;
    const next = loreText.indexOf('\n## ', start + section.length);
    const body = loreText.slice(start, next === -1 ? loreText.length : next);
    return (
      !/\*\*Sources:\*\*/i.test(body) &&
      section !== '## Canon maintenance contract' &&
      section !== '## Official source register'
    );
  });
  const unresolvedContradictions = /^Status:\s*unresolved\s*$/im.test(
    stripFencedCodeBlocks(contradictionText),
  );

  return {
    missingSections,
    missingSources,
    missingSourceDeclarations,
    unresolvedContradictions,
  };
}

/**
 * Recursively discover brief files under `briefs/`. The brief contract is
 * `briefs/**\/*.yaml` (with sibling `.yml`/`.json`/`.md` variants), including
 * nested families such as `briefs/icons/abilities` and
 * `briefs/icons/achievements` — a partial one-level directory list would skip
 * those and let an unresolved marker there escape the hard gate.
 */
function officialSourceFiles(): string[] {
  const root = 'briefs';
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(fromRepo(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (/\.(yaml|yml|json|md)$/.test(entry.name)) {
        results.push(relativePath);
      }
    }
  }

  walk(root);
  return results;
}

export function findContradictionMarkers(loreText?: string): string[] {
  const registeredSources = loreText ? sourcePaths(loreText).map(resolveMarkdownPath) : [];
  const candidates = [...new Set([...registeredSources, ...officialSourceFiles()])];
  return candidates.filter((relativePath) => {
    if (!pathExists(relativePath)) return false;
    const text = readFileSync(fromRepo(relativePath), 'utf8');
    return /\[LORE-CONTRADICTION\]|LORE_CONTRADICTION/.test(text);
  });
}

async function main(): Promise<void> {
  const report = new Report('docs-check-lore-canon');
  let loreText: string;
  let contradictionText: string;
  try {
    loreText = readFileSync(fromRepo(LORE_BIBLE_PATH), 'utf8');
    contradictionText = readFileSync(fromRepo(CONTRADICTIONS_PATH), 'utf8');
  } catch {
    report.error('Canonical lore files could not be read.', {
      remediation:
        'Restore docs/knowledge/game-design/lore-bible.md and lore-contradictions.md, then run npm run docs:check.',
    });
    report.finish();
  }

  const result = validateLoreCanon(loreText!, contradictionText!);
  for (const section of result.missingSections) {
    report.error(`Lore Bible is missing required section: ${section}`, {
      file: LORE_BIBLE_PATH,
      remediation: 'Restore the canonical section or update the lore contract deliberately.',
    });
  }
  for (const source of result.missingSources) {
    report.error(`Lore source citation points to a missing path: ${source}`, {
      file: LORE_BIBLE_PATH,
      remediation: 'Correct the citation or restore the cited source before authoring content.',
    });
  }
  for (const section of result.missingSourceDeclarations) {
    report.error(`Lore canon section is missing a Sources declaration: ${section}`, {
      file: LORE_BIBLE_PATH,
      remediation:
        'Add a **Sources:** declaration naming the official repository references for the section.',
    });
  }
  if (result.unresolvedContradictions) {
    report.error('Unresolved lore contradiction blocks content canonization.', {
      file: CONTRADICTIONS_PATH,
      remediation:
        'Resolve the record with the Content Designer and maintainer, then update lore-bible.md; do not choose a source silently.',
    });
  }
  for (const source of findContradictionMarkers(loreText!)) {
    report.error('Source contains an unresolved [LORE-CONTRADICTION] marker.', {
      file: source,
      remediation: `Copy the claim and provenance into ${CONTRADICTIONS_PATH}, resolve it, and remove the marker.`,
    });
  }
  report.info(
    `Canonical lore validated from ${sourcePaths(loreText!).length} registered references.`,
  );
  report.finish();
}

if (process.argv[1]?.endsWith('check-lore-canon.ts')) {
  main().catch((error) => {
    process.stderr.write(
      `check-lore-canon crashed: ${error instanceof Error ? error.stack : error}\n`,
    );
    process.exit(2);
  });
}
