#!/usr/bin/env node
/**
 * security/check-codeowners.ts — Ensure critical paths are covered by
 * CODEOWNERS.
 *
 * "Critical" paths (must each have an explicit CODEOWNERS line):
 *   - .github/workflows/
 *   - .github/copilot-instructions.md
 *   - .github/copilot-setup-steps.yml
 *   - AGENTS.md
 *   - .specify/
 *   - docs/agent-os/policies/
 *
 * Also flags any owner pattern in CODEOWNERS that has no listed reviewer.
 */

import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

interface OwnerLine {
  readonly raw: string;
  readonly pattern: string;
  readonly owners: ReadonlyArray<string>;
  readonly line: number;
}

const CRITICAL = [
  '/.github/workflows/',
  '/.github/copilot-instructions.md',
  '/.github/copilot-setup-steps.yml',
  '/AGENTS.md',
  '/.specify/',
  '/docs/agent-os/policies/',
];

function parseCodeowners(text: string): OwnerLine[] {
  const out: OwnerLine[] = [];
  text.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s+/);
    const [pattern, ...owners] = parts;
    if (!pattern) return;
    out.push({ raw: trimmed, pattern, owners, line: idx + 1 });
  });
  return out;
}

async function main(): Promise<void> {
  const report = new Report('security-check-codeowners');
  let text: string;
  try {
    text = readFileSync(fromRepo('CODEOWNERS'), 'utf8');
  } catch {
    report.error('CODEOWNERS file missing.', {
      remediation: 'Create one at repo root listing owners for critical paths.',
    });
    report.finish();
  }
  const entries = parseCodeowners(text!);
  const declared = new Set(entries.map((e) => e.pattern));

  for (const e of entries) {
    if (e.owners.length === 0) {
      report.error(`CODEOWNERS pattern has no owners: ${e.pattern}`, {
        file: 'CODEOWNERS',
        line: e.line,
        remediation: 'Add at least one @user or @org/team after the pattern.',
      });
    }
  }

  for (const required of CRITICAL) {
    // Must be present on disk to be enforceable.
    const onDisk = required.replace(/^\//, '');
    try {
      statSync(fromRepo(onDisk.replace(/\/+$/, '')));
    } catch {
      report.warn(`Critical path missing on disk; CODEOWNERS rule moot: ${required}`);
      continue;
    }
    if (!declared.has(required)) {
      report.error(`CODEOWNERS missing required pattern: ${required}`, {
        file: 'CODEOWNERS',
        remediation: `Add a line like \`${required} @nalfeo\` to CODEOWNERS.`,
      });
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-codeowners crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
