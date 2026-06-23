#!/usr/bin/env node
/**
 * docs/check-paths.ts — Verify backtick-quoted paths/globs in core docs
 * actually resolve on disk.
 *
 * Scans:
 *   - AGENTS.md
 *   - README.md
 *   - .github/copilot-instructions.md
 *   - .github/instructions/*.md
 *   - docs/agent-os/policies/*.md
 *
 * Recognized as a "path" inside backticks:
 *   - Starts with `./`, `/`, `src/`, `scripts/`, `tests/`, `docs/`, `.github/`,
 *     `.specify/`, `public/`, `briefs/`, `data/`, `tools/`
 *   - Or ends with a common file extension (`.ts`, `.md`, `.json`, `.yml`,
 *     `.yaml`, `.sh`)
 *
 * For globs ending in `*`, `**`, or containing `{a,b}` we only require the
 * parent directory to exist (the glob is a contract, not a single artifact).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const DOC_FILES = ['AGENTS.md', 'README.md', '.github/copilot-instructions.md'];
const DOC_DIRS = ['.github/instructions', 'docs/agent-os/policies'];

const PATH_PREFIXES = [
  './',
  '/',
  'src/',
  'scripts/',
  'tests/',
  'docs/',
  '.github/',
  '.specify/',
  'public/',
  'briefs/',
  'data/',
  'tools/',
];

const PATH_EXTS = ['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.sh'];

const ALLOWLIST = new Set<string>([
  // External URLs / fragments that look path-y
  'src/main',
  'src/lab-main',
  // Runtime-generated session artifacts (written under the session `files/`
  // dir at launch time, not committed repo files) — referenced by AGENTS.md
  // "Server Launch Diagnostics".
  'files/guard-telemetry.jsonl',
  'files/worktree-server-status.json',
  'files/worktree-server-launch.log',
]);

const BACKTICK = /`([^`\n]+)`/g;

function looksLikePath(s: string): boolean {
  if (s.includes(' ')) return false;
  if (s.startsWith('http') || s.startsWith('npm ') || s.startsWith('bash ')) return false;
  // Template placeholders like `<slug>` or `YYYY-MM-DD-` — these are
  // documentation patterns, not real paths.
  if (s.includes('<') || s.includes('>')) return false;
  if (/\bYYYY\b/.test(s) || /<[^>]+>/.test(s)) return false;
  if (PATH_PREFIXES.some((p) => s.startsWith(p))) return true;
  // Extension-only matches must also contain a separator so bare filenames
  // mentioned in prose (e.g. `ci.yml`, `package.json`) aren't flagged.
  if (PATH_EXTS.some((ext) => s.endsWith(ext)) && s.includes('/')) return true;
  return false;
}

function existsOnDisk(rel: string): boolean {
  // Trim trailing slashes for stat
  const normalized = rel.replace(/\/+$/, '');
  try {
    statSync(fromRepo(normalized));
    return true;
  } catch {
    return false;
  }
}

function parentDirExists(globPath: string): boolean {
  // For `foo/bar/*` or `foo/bar/**/*.ts`, check that `foo/bar` exists.
  const firstWildcard = globPath.search(/[*?{]/);
  if (firstWildcard < 0) return existsOnDisk(globPath);
  const parent = globPath.slice(0, firstWildcard).replace(/\/+$/, '');
  if (!parent) return true;
  return existsOnDisk(parent);
}

async function listDocs(): Promise<string[]> {
  const all = new Set<string>();
  for (const f of DOC_FILES) {
    try {
      statSync(fromRepo(f));
      all.add(f);
    } catch {
      // skip missing
    }
  }
  for (const dir of DOC_DIRS) {
    try {
      for (const entry of readdirSync(fromRepo(dir))) {
        if (entry.endsWith('.md')) all.add(`${dir}/${entry}`);
      }
    } catch {
      // skip missing dir
    }
  }
  return [...all];
}

async function main(): Promise<void> {
  const report = new Report('docs-check-paths');
  const docs = await listDocs();
  if (docs.length === 0) {
    report.warn('No doc files matched scan globs.');
    report.finish();
  }

  for (const doc of docs) {
    const abs = fromRepo(doc);
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      // Skip code fences and obvious shell command lines
      if (line.trim().startsWith('```')) return;
      let match: RegExpExecArray | null;
      const re = new RegExp(BACKTICK.source, 'g');
      while ((match = re.exec(line)) !== null) {
        const raw = match[1];
        if (!raw) continue;
        // Strip a trailing punctuation if it crept in (`.`, `,`, `;`, `)`)
        const candidate = raw.replace(/[.,;)\]]+$/, '');
        if (!looksLikePath(candidate)) continue;
        if (ALLOWLIST.has(candidate)) continue;
        // Resolve relative `./` to repo root
        const resolved = candidate.startsWith('./') ? candidate.slice(2) : candidate;
        const ok =
          candidate.includes('*') || candidate.includes('{')
            ? parentDirExists(resolved)
            : existsOnDisk(resolved);
        if (!ok) {
          report.error(`Doc path does not exist on disk: \`${candidate}\``, {
            file: doc,
            line: idx + 1,
            remediation:
              'Update the doc to point at the new path, delete the stale reference, or add the file.',
          });
        }
      }
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`docs-check-paths crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
