#!/usr/bin/env node
/**
 * docs/check-adr-consistency.ts — Verify each ADR's referenced paths exist.
 *
 * Same heuristic as check-paths.ts but scoped to `docs/knowledge/adr/*.md`.
 * Also flags ADRs missing a `## Status` heading (sanity check that the file
 * follows the template).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const PATH_PREFIXES = ['src/', 'scripts/', 'tests/', 'docs/', '.github/', '.specify/', 'public/'];
const PATH_EXTS = ['.ts', '.md', '.json', '.yml', '.yaml', '.sh'];
const ALLOWLIST = new Set<string>([
  // Runtime-generated coverage artifact produced by the Governor sweep.
  'coverage/balance-metrics.json',
]);

function looksLikePath(s: string): boolean {
  if (s.includes(' ')) return false;
  if (s.startsWith('http')) return false;
  if (s.includes('<') || s.includes('>')) return false;
  if (/\bYYYY\b/.test(s)) return false;
  if (PATH_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (PATH_EXTS.some((ext) => s.endsWith(ext)) && s.includes('/')) return true;
  return false;
}

function exists(rel: string): boolean {
  try {
    statSync(fromRepo(rel.replace(/\/+$/, '')));
    return true;
  } catch {
    return false;
  }
}

function parentExists(g: string): boolean {
  const i = g.search(/[*?{]/);
  if (i < 0) return exists(g);
  const parent = g.slice(0, i).replace(/\/+$/, '');
  return parent === '' || exists(parent);
}

async function main(): Promise<void> {
  const report = new Report('docs-check-adr-consistency');
  const adrDir = 'docs/knowledge/adr';
  let adrs: string[] = [];
  try {
    adrs = readdirSync(fromRepo(adrDir))
      .filter((e) => e.endsWith('.md') && e !== 'TEMPLATE.md' && e !== 'README.md')
      .map((e) => `${adrDir}/${e}`);
  } catch {
    // dir missing
  }
  if (adrs.length === 0) {
    report.warn('No ADR files found.');
    report.finish();
  }

  for (const doc of adrs) {
    const text = readFileSync(fromRepo(doc), 'utf8');
    if (!/^##\s+Status/m.test(text)) {
      report.warn('ADR is missing a "## Status" section.', {
        file: doc,
        remediation: 'Add a Status section per docs/knowledge/adr/TEMPLATE.md.',
      });
    }
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (line.trim().startsWith('```')) return;
      const re = /`([^`\n]+)`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const candidate = raw.replace(/[.,;)\]]+$/, '');
        if (!looksLikePath(candidate)) continue;
        if (ALLOWLIST.has(candidate)) continue;
        const ok =
          candidate.includes('*') || candidate.includes('{')
            ? parentExists(candidate)
            : exists(candidate);
        if (!ok) {
          report.error(`ADR references missing path: \`${candidate}\``, {
            file: doc,
            line: idx + 1,
            remediation: 'Update the ADR or restore the path it documents.',
          });
        }
      }
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `check-adr-consistency crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});
