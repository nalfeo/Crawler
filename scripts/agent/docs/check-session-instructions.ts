#!/usr/bin/env node
/**
 * docs/check-session-instructions.ts — Keep the two top-level session
 * instruction files aligned on kickoff behavior.
 *
 * Deterministic, LLM-free. Asserts that both `AGENTS.md` and
 * `.github/copilot-instructions.md` contain the same explicit kickoff rules:
 *   1. give an upfront recommendation verdict (recommended / risky /
 *      not recommended) with a short reason
 *   2. write plans in session chat unless the human explicitly asks for a file
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const DOCS = ['AGENTS.md', '.github/copilot-instructions.md'] as const;

const REQUIRED_LINES = [
  '- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.',
  '- **Plans stay in session chat:** When giving a plan, write the full plan in session chat. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.',
] as const;

async function main(): Promise<void> {
  const report = new Report('docs-check-session-instructions');

  for (const file of DOCS) {
    const text = readFileSync(fromRepo(file), 'utf8');
    for (const line of REQUIRED_LINES) {
      if (!text.includes(line)) {
        report.error(
          `Top-level session instruction is missing the mirrored kickoff rule: \`${line}\``,
          {
            file,
            remediation:
              'Copy the exact mirrored kickoff bullet into both AGENTS.md and .github/copilot-instructions.md.',
          },
        );
      }
    }
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `check-session-instructions crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});
