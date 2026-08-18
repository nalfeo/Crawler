/**
 * One-shot codemod: repoint live references from lineage-tagged brief ids to
 * their canonical bare names, driven by the SAME taxonomy the migration uses.
 *
 * Scope is deliberately narrow — runtime source, shipped data, tests, and
 * agent scripts. Historical records (docs/knowledge/handoffs, adr, metrics,
 * review-ledgers, agent-memory) are NOT rewritten: they describe what was true
 * at the time, and rewriting them would falsify the project's own history.
 *
 * Usage: tsx scripts/sprites/repoint-sprite-name-refs.ts [--dry-run|--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { bareConcept } from './sprite-name-taxonomy.js';

/** Directories whose contents are live and must be repointed. */
const INCLUDE_PREFIXES = ['src/', 'tests/', 'scripts/', '.github/'];

/**
 * Paths that are historical records or the taxonomy's own fixtures, and must
 * keep their literal pre-migration names.
 */
const EXCLUDE_PATTERNS = [
  /^docs\//,
  /^scripts\/sprites\/sprite-name-taxonomy\.ts$/,
  /^scripts\/sprites\/normalize-sprite-names\.ts$/,
  /^scripts\/sprites\/normalize-item-art-names\.ts$/,
  /^tests\/unit\/sprites\/sprite-name-taxonomy\.test\.ts$/,
  /^tests\/unit\/sprites\/normalize-sprite-names\.test\.ts$/,
  /^tests\/unit\/sprites\/normalize-item-art-names\.test\.ts$/,
];

export interface RefRewrite {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

/** Build `old -> new` for every brief id that the migration renamed. */
export function buildNameMap(oldBriefIds: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const oldId of oldBriefIds) {
    const canonical = bareConcept(oldId);
    if (canonical !== oldId) {
      map.set(oldId, canonical);
    }
  }
  return map;
}

function isEligible(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  if (!INCLUDE_PREFIXES.some((p) => posix.startsWith(p))) return false;
  return !EXCLUDE_PATTERNS.some((re) => re.test(posix));
}

/**
 * Rewrite occurrences of each old id in `text`.
 *
 * Uses a word-ish boundary so `rat-v1` never matches inside `rat-v10`, and
 * longest-first ordering so `angry-roomba-v2-v1` is consumed before the shorter
 * `angry-roomba-v1` can partially match it.
 */
export function rewriteText(
  text: string,
  nameMap: ReadonlyMap<string, string>,
): { text: string; hits: Map<string, number> } {
  const ordered = [...nameMap.keys()].sort((a, b) => b.length - a.length);
  const hits = new Map<string, number>();
  let out = text;
  for (const oldId of ordered) {
    const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not preceded by a name char, and not followed by a digit or `-v<digit>`
    // (so `-var-N` suffixes still match, but a longer sibling id does not).
    const re = new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![0-9])`, 'g');
    const matches = out.match(re);
    if (matches !== null) {
      hits.set(oldId, matches.length);
      out = out.replace(re, nameMap.get(oldId)!);
    }
  }
  return { text: out, hits };
}

function trackedFiles(repoRoot: string): string[] {
  const raw = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  return raw.split('\n').filter((line) => line.trim() !== '');
}

export function run(
  repoRoot: string,
  oldBriefIds: readonly string[],
  apply: boolean,
): RefRewrite[] {
  const nameMap = buildNameMap(oldBriefIds);
  const rewrites: RefRewrite[] = [];

  for (const file of trackedFiles(repoRoot)) {
    if (!isEligible(file)) continue;
    const abs = path.join(repoRoot, file);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    if (text.includes('\u0000')) continue;

    const result = rewriteText(text, nameMap);
    if (result.hits.size === 0) continue;

    for (const [from, count] of result.hits) {
      rewrites.push({ file, from, to: nameMap.get(from)!, count });
    }
    if (apply) {
      writeFileSync(abs, result.text);
    }
  }
  return rewrites;
}

export function main(argv: readonly string[]): number {
  const apply = argv.includes('--apply');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  const listIndex = argv.indexOf('--old-ids');
  if (listIndex < 0) {
    console.error('--old-ids <file> is required (newline-separated pre-migration brief ids)');
    return 1;
  }
  const oldBriefIds = readFileSync(argv[listIndex + 1]!, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const rewrites = run(repoRoot, oldBriefIds, apply);
  const byFile = new Map<string, RefRewrite[]>();
  for (const rewrite of rewrites) {
    const list = byFile.get(rewrite.file) ?? [];
    list.push(rewrite);
    byFile.set(rewrite.file, list);
  }

  console.log(
    `${apply ? 'applied' : 'dry-run'}: ${byFile.size} file(s), ${rewrites.length} rewrite(s)`,
  );
  for (const [file, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${file}`);
    for (const rewrite of list) {
      console.log(`    ${rewrite.from} -> ${rewrite.to} (${rewrite.count})`);
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
