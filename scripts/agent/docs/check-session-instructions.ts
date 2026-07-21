#!/usr/bin/env node
/**
 * docs/check-session-instructions.ts — Keep the two top-level session
 * instruction files aligned on required session policy bullets.
 *
 * Deterministic, LLM-free. Asserts that both `AGENTS.md` and
 * `.github/copilot-instructions.md` contain the same explicit required rules:
 *   1. give an upfront recommendation verdict (recommended / risky /
 *      not recommended) with a short reason
 *   2. write plans in session chat unless the human explicitly asks for a file
 *   3. default broad sweeps (>10 runs) to GitHub workflow infrastructure
 *   4. treat investigation-only sessions as lightweight and split landing fixes
 *   5. cap tooling-only ceremony at 3 apples
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const DOCS = ['AGENTS.md', '.github/copilot-instructions.md'] as const;

const REQUIRED_LINES = [
  '- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.',
  '- **Plans stay in session chat:** When giving a plan, write the full plan in session chat. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.',
  '- **Broad sweeps default to GitHub:** For sweeps or batch evals with **more than 10 runs**, default to GitHub-backed `workflow_dispatch`/CI execution (for example `.github/workflows/weapon-sweep.yml` or `.github/workflows/ai-sweep.yml`) instead of local/session compute unless a human explicitly asks for local.',
  '- **Investigation sessions are process-light:** Investigation/repro/debug sessions with no merge-intent fix may stay lightweight (no review ledger/full PR paperwork). If a fix should land, spin a separate implementation child session/PR and run the normal full process there.',
  '- **Tooling-only ceremony is capped at 3🍎:** Work confined to developer/agent tooling, canvases, automation, or asset-pipeline tooling is estimated at no more than 3🍎 regardless of file count; the cap does not apply when runtime gameplay behavior or shipped game data changes.',
] as const;

async function main(): Promise<void> {
  const report = new Report('docs-check-session-instructions');

  for (const file of DOCS) {
    const text = readFileSync(fromRepo(file), 'utf8');
    for (const line of REQUIRED_LINES) {
      if (!text.includes(line)) {
        report.error(
          `Top-level session instruction is missing the mirrored required policy line: \`${line}\``,
          {
            file,
            remediation:
              'Copy the exact mirrored policy bullet into both AGENTS.md and .github/copilot-instructions.md.',
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
