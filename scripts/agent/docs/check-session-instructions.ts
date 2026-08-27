#!/usr/bin/env node
/**
 * docs/check-session-instructions.ts — Keep the required session policy
 * bullets in exactly one canonical home, and keep the pointer file pointing.
 *
 * Deterministic, LLM-free.
 *
 * This check used to require the bullets to be *mirrored* verbatim in both
 * `AGENTS.md` and `.github/copilot-instructions.md`. That enforced the very
 * triplication it was meant to protect: every policy edit needed three
 * synchronized edits (here, `AGENTS.md`, and `docs/agent-os/policies/`), and
 * the copies drifted anyway. `AGENTS.md` is now the single canonical home for
 * session policy, and `.github/copilot-instructions.md` is a pointer file.
 *
 * So this now asserts two things:
 *   1. `AGENTS.md` still contains every required session policy bullet:
 *      - give an upfront recommendation verdict (recommended / risky /
 *        not recommended) with a short reason
 *      - write plans in session chat and preserve them in PR context unless the
 *        human explicitly asks for a file
 *      - detach from published PRs unless the human pre-declared local ownership
 *      - default broad sweeps (>10 runs) to GitHub workflow infrastructure
 *      - treat investigation-only sessions as lightweight and split landing fixes
 *      - cap tooling-only ceremony at 3 apples
 *   2. `.github/copilot-instructions.md` links to `AGENTS.md` and does NOT
 *      restate those bullets, so the duplication cannot creep back.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const CANONICAL_DOC = 'AGENTS.md';
const POINTER_DOC = '.github/copilot-instructions.md';

const REQUIRED_LINES = [
  '- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.',
  '- **Plans stay in session chat and PR context:** When giving a plan, write the full plan in session chat and preserve it in the PR description or a PR comment. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.',
  '- **Published PRs detach by default:** Unless the human explicitly states before PR publication that the session should remain local, an implementation session must publish a ready-for-review PR, leave complete handoff context, then end/release its ownership immediately. Do **not** wait locally for CI, reviews, or cloud confirmation; CI Recovery assigns cloud Copilot for blockers, with the 10-minute scheduled sweep as the takeover backstop.',
  '- **Broad sweeps default to GitHub:** For sweeps or batch evals with **more than 10 runs**, default to GitHub-backed `workflow_dispatch`/CI execution (for example `.github/workflows/weapon-sweep.yml` or `.github/workflows/ai-sweep.yml`) instead of local/session compute unless a human explicitly asks for local.',
  '- **Investigation sessions are process-light:** Investigation/repro/debug sessions with no merge-intent fix may stay lightweight (no review ledger/full PR paperwork). If a fix should land, spin a separate implementation child session/PR and run the normal full process there.',
  '- **Tooling-only ceremony is capped at 3🍎:** Work confined to developer/agent tooling, canvases, automation, or asset-pipeline tooling is estimated at no more than 3🍎 regardless of file count; the cap does not apply when runtime gameplay behavior or shipped game data changes.',
] as const;

async function main(): Promise<void> {
  const report = new Report('docs-check-session-instructions');

  const canonical = readFileSync(fromRepo(CANONICAL_DOC), 'utf8');
  for (const line of REQUIRED_LINES) {
    if (!canonical.includes(line)) {
      report.error(
        `Canonical session instructions are missing a required policy line: \`${line}\``,
        {
          file: CANONICAL_DOC,
          remediation: `Restore the policy bullet in ${CANONICAL_DOC}, its single canonical home.`,
        },
      );
    }
  }

  const pointer = readFileSync(fromRepo(POINTER_DOC), 'utf8');
  if (!pointer.includes('AGENTS.md')) {
    report.error(`Pointer file does not link to the canonical session instructions.`, {
      file: POINTER_DOC,
      remediation: `Link to ${CANONICAL_DOC} instead of restating session policy.`,
    });
  }
  for (const line of REQUIRED_LINES) {
    if (pointer.includes(line)) {
      report.error(`Session policy bullet is duplicated outside its canonical home: \`${line}\``, {
        file: POINTER_DOC,
        remediation: `Delete the copy and link to ${CANONICAL_DOC}; each rule has exactly one home.`,
      });
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
