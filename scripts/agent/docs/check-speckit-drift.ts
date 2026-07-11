#!/usr/bin/env node
/**
 * docs/check-speckit-drift.ts — Detect spec drift in `.specify/specs/`.
 *
 * For each spec file in `.specify/specs/` (excluding README.md):
 *  1. Verify required structural sections exist (Context, Requirements).
 *  2. Check `> **Status:**` is present and not a placeholder.
 *  3. Verify `**Code source-of-truth:**` path references resolve on disk.
 *  4. Verify backtick-quoted `src/` or `scripts/` or `tests/` paths resolve.
 *  5. Flag if any referenced ADR file (`docs/knowledge/adr/NNNN-*.md`) is missing.
 *  6. Warn if a spec's source-of-truth path was git-committed more recently
 *     than the spec itself (indicates the code moved on without a spec update).
 *
 * All findings surface as warnings (non-blocking) so the docs-update loop can
 * aggregate them without failing CI on the first drift. Bump to `error` only
 * when a structural invariant is violated (missing required section).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import { existsOnDisk, looksLikePath, pathExistsOnDisk } from '../shared/path-utils.js';

const SPECS_DIR = '.specify/specs';
const ADR_DIR = 'docs/knowledge/adr';

/** Sections every non-README spec must have. */
const REQUIRED_SECTIONS = ['## Context', '## Requirements'];

/** Last git commit timestamp (Unix seconds) for a repo-relative path. */
function lastCommitTs(rel: string): number | null {
  try {
    const out = execSync(`git log -1 --format=%ct -- "${rel}"`, {
      cwd: fromRepo(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!out) return null;
    return Number.parseInt(out, 10);
  } catch {
    return null;
  }
}

/** Extract `> **Code source-of-truth:** path1, path2` values from spec text. */
function extractSourceOfTruth(text: string): string[] {
  const paths: string[] = [];
  const match = text.match(/\*\*Code source-of-truth:\*\*\s*([^\n]+)/);
  if (!match || !match[1]) return paths;
  // Remove HTML comments using [\s\S]*? so multiline comments like
  // `<!-- intentionally omitted -->` are fully stripped before path parsing.
  const raw = match[1].replace(/<!--[\s\S]*?-->/g, '');
  // Split on commas or whitespace, strip markdown emphasis/backticks
  const parts = raw.split(/[,\s]+/).map((p) => p.replace(/[`*_]/g, '').trim());
  for (const p of parts) {
    if (p && looksLikePath(p)) paths.push(p);
  }
  return paths;
}

/** Extract ADR slugs referenced in the spec (e.g. `ADR 0017`, `ADR-0017`). */
function extractAdrRefs(text: string): string[] {
  const refs = new Set<string>();
  // Only match explicit "ADR NNNN" or "ADR-NNNN" patterns, not bare 4-digit numbers
  const re = /\bADR[- ](\d{4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = m[1];
    if (num) refs.add(num);
  }
  return [...refs];
}

/** Resolve a 4-digit ADR number to its file path under docs/knowledge/adr/. */
function adrFilePath(num: string): string | null {
  const adrAbsDir = fromRepo(ADR_DIR);
  if (!existsSync(adrAbsDir)) return null;
  try {
    const entries = readdirSync(adrAbsDir);
    const match = entries.find((e) => e.startsWith(num));
    return match ? `${ADR_DIR}/${match}` : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const report = new Report('docs-check-speckit-drift');

  const specsAbsDir = fromRepo(SPECS_DIR);
  if (!existsOnDisk(SPECS_DIR)) {
    report.warn(`Specs directory not found at ${SPECS_DIR}.`);
    report.finish();
  }

  const specFiles = readdirSync(specsAbsDir)
    .filter((e) => e.endsWith('.md') && e !== 'README.md')
    .map((e) => `${SPECS_DIR}/${e}`);

  if (specFiles.length === 0) {
    report.info(`No spec files found under ${SPECS_DIR} (only README.md).`);
    report.finish();
  }

  for (const specRel of specFiles) {
    const text = readFileSync(fromRepo(specRel), 'utf8');
    const lines = text.split('\n');

    // 1. Required structural sections
    for (const section of REQUIRED_SECTIONS) {
      if (!text.includes(section)) {
        report.error(`Spec is missing required section "${section}".`, {
          file: specRel,
          remediation: `Add a "${section}" section per .specify/templates/spec.md.`,
        });
      }
    }

    // 2. Status field must be present and not a placeholder
    if (!/\*\*Status:\*\*/.test(text)) {
      report.warn('Spec is missing a `**Status:**` field.', {
        file: specRel,
        remediation: 'Add `> **Status:** Proposed | Partial | Shipped | Obsolete` near the top.',
      });
    } else if (/\*\*Status:\*\*\s*Proposed \| Partial \| Shipped \| Obsolete/.test(text)) {
      report.warn('Spec `**Status:**` field is still the template placeholder.', {
        file: specRel,
        remediation: 'Replace with the actual status: Proposed, Partial, Shipped, or Obsolete.',
      });
    }

    // 3. Code source-of-truth paths
    const sourceOfTruthPaths = extractSourceOfTruth(text);
    const specTs = lastCommitTs(specRel);
    for (const codePath of sourceOfTruthPaths) {
      const ok = pathExistsOnDisk(codePath);
      if (!ok) {
        report.warn(`Spec source-of-truth path does not exist: \`${codePath}\``, {
          file: specRel,
          remediation: 'Update the spec or restore the missing path.',
        });
        continue;
      }
      // Check for staleness: if source code was modified after the spec
      const isGlob = codePath.includes('*') || codePath.includes('{');
      if (!isGlob && specTs !== null) {
        const resolved = codePath.startsWith('./') ? codePath.slice(2) : codePath;
        const codeTs = lastCommitTs(resolved);
        if (codeTs !== null && codeTs > specTs) {
          const daysDrift = Math.floor((codeTs - specTs) / 86400);
          report.warn(
            `Source-of-truth \`${codePath}\` committed ${daysDrift}d after spec — possible drift.`,
            {
              file: specRel,
              remediation:
                'Review whether the spec still matches the implementation and update if needed.',
            },
          );
        }
      }
    }

    // 4. Backtick-quoted code paths in the spec body
    lines.forEach((line, idx) => {
      if (line.trim().startsWith('```')) return;
      const re = /`([^`\n]+)`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        const candidate = raw.replace(/[.,;)\]]+$/, '');
        if (!looksLikePath(candidate)) continue;
        if (!pathExistsOnDisk(candidate)) {
          report.warn(`Spec references missing path: \`${candidate}\``, {
            file: specRel,
            line: idx + 1,
            remediation: 'Update the spec or restore the path it references.',
          });
        }
      }
    });

    // 5. ADR references
    const adrRefs = extractAdrRefs(text);
    for (const num of adrRefs) {
      const adrPath = adrFilePath(num);
      if (adrPath === null) {
        report.warn(`Spec references ADR ${num} which does not exist in ${ADR_DIR}/.`, {
          file: specRel,
          remediation: `Create the ADR file or remove the reference.`,
        });
      }
    }
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `check-speckit-drift crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});

