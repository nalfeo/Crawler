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
 *   - .github/agents/*.md
 *   - docs/agent-os/policies/*.md
 *   - docs/agent-os/personas/*.md
 *
 * Two kinds of reference are validated:
 *   1. Backtick-quoted repo paths/globs (resolved from the repo root).
 *   2. Relative Markdown link targets `[text](../foo/bar.md)` (resolved
 *      against the linking document's own directory).
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
import { globParentDir, looksLikePath, nextFenceState, resolveLinkTarget } from './doc-refs-lib.js';

const DOC_FILES = ['AGENTS.md', 'README.md', '.github/copilot-instructions.md'];
const DOC_DIRS = [
  '.github/instructions',
  '.github/agents',
  'docs/agent-os/policies',
  'docs/agent-os/personas',
];

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
const MD_LINK = /\[[^\]\n]*\]\(([^)\s]+)\)/g;

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
  const parent = globParentDir(globPath);
  return parent === null ? true : existsOnDisk(parent);
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
    let fence: string | null = null;
    lines.forEach((line, idx) => {
      // Track fenced code blocks: content inside a fence is illustrative, not a
      // claim about the repo, so neither backticked paths nor links are checked.
      // A fence closes only on a matching marker, so a ``` line inside a ~~~
      // block does not prematurely resume validation.
      const wasInFence = fence !== null;
      fence = nextFenceState(fence, line);
      if (wasInFence || fence !== null) return;
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

      // Relative Markdown link targets resolve against the linking doc's dir.
      const linkRe = new RegExp(MD_LINK.source, 'g');
      while ((match = linkRe.exec(line)) !== null) {
        const target = match[1];
        if (!target) continue;
        const relTarget = resolveLinkTarget(doc, target);
        if (relTarget === null) continue;
        if (ALLOWLIST.has(relTarget)) continue;
        if (existsOnDisk(relTarget)) continue;
        report.error(`Markdown link target does not exist: \`${target}\``, {
          file: doc,
          line: idx + 1,
          remediation: `Point the link at an existing file (resolved to \`${relTarget}\`) or remove it.`,
        });
      }
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`docs-check-paths crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
