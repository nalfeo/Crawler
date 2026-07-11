#!/usr/bin/env node
/**
 * docs/check-context.ts — Flag stale or contradictory context fragments in
 * AGENTS.md and persona docs.
 *
 * Scans:
 *   - AGENTS.md
 *   - docs/agent-os/personas/*.md
 *   - docs/agent-os/policies/*.md
 *   - .github/copilot-instructions.md
 *
 * Checks:
 *  1. Path references in backticks resolve on disk.
 *  2. ADR cross-references (`ADR NNNN` or `0NNN-slug`) point to existing files.
 *  3. `npm run <script>` references exist in package.json.
 *  4. Persona docs each have required structural sections (Responsibilities,
 *     Constraints, Quality Criteria, Collaborates with).
 *  5. Personas listed in the routing table in README.md each have a
 *     corresponding persona file.
 *
 * Findings are surfaced as warnings (non-blocking) so the docs-update loop can
 * aggregate them without halting. This is a deterministic, LLM-free check.
 */

import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import { existsOnDisk, looksLikePath, pathExistsOnDisk } from '../shared/path-utils.js';

const CONTEXT_FILES = ['AGENTS.md', '.github/copilot-instructions.md'];
const CONTEXT_DIRS = ['docs/agent-os/personas', 'docs/agent-os/policies'];

const PERSONAS_DIR = 'docs/agent-os/personas';
const ADR_DIR = 'docs/knowledge/adr';

/** Sections every persona doc (non-README) should have. */
const PERSONA_REQUIRED_SECTIONS = [
  '## Responsibilities',
  '## Constraints',
  '## Quality Criteria',
  '## Collaborates with',
];

/** Path references we know are runtime-generated or intentional. */
const ALLOWLIST = new Set<string>([
  'files/guard-telemetry.jsonl',
  'files/worktree-server-status.json',
  'files/worktree-server-launch.log',
  'src/main',
  'src/lab-main',
  // Relative paths used in persona/policy cross-links (resolve under docs/agent-os/)
  'policies/review-harness-policy.md',
  // Template / placeholder patterns
  'docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md',
  'docs/knowledge/review-ledgers/<date>-<slug>.review-ledger.json',
]);

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

function loadPackageScripts(): Set<string> {
  try {
    const text = readFileSync(fromRepo('package.json'), 'utf8');
    const json = JSON.parse(text) as PackageJson;
    return new Set(Object.keys(json.scripts ?? {}));
  } catch {
    return new Set();
  }
}

/** Find the ADR file for a 4-digit ADR number. */
function adrFileExists(num: string): boolean {
  try {
    const entries = readdirSync(fromRepo(ADR_DIR));
    return entries.some((e) => e.startsWith(num));
  } catch {
    return false;
  }
}

/** Collect all context doc files. */
function listContextDocs(): string[] {
  const all = new Set<string>();
  for (const f of CONTEXT_FILES) {
    if (existsOnDisk(f)) all.add(f);
  }
  for (const dir of CONTEXT_DIRS) {
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

/** Check an individual doc file for stale references. */
function checkDocPaths(
  docRel: string,
  text: string,
  packageScripts: Set<string>,
  report: Report,
): void {
  const lines = text.split('\n');

  lines.forEach((line, idx) => {
    if (line.trim().startsWith('```')) return;
    const re = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      const candidate = raw.replace(/[.,;)\]]+$/, '');

      // Skip allowlisted entries
      if (ALLOWLIST.has(candidate)) continue;

      // npm run script check — match `npm run <script>` with optional `-- <flags>` suffix
      const npmRunMatch = candidate.match(/^npm run ([a-zA-Z0-9:_-]+)(?:\s.*)?$/);
      if (npmRunMatch) {
        const script = npmRunMatch[1];
        if (script && !packageScripts.has(script)) {
          report.warn(`Context doc references missing npm script: \`${candidate}\``, {
            file: docRel,
            line: idx + 1,
            remediation: 'Add the script to package.json or update the doc.',
          });
        }
        continue;
      }

      // Path reference check
      if (!looksLikePath(candidate)) continue;
      if (!pathExistsOnDisk(candidate)) {
        report.warn(`Context doc path does not exist: \`${candidate}\``, {
          file: docRel,
          line: idx + 1,
          remediation: 'Update the doc or restore the missing path.',
        });
      }
    }

    // ADR references: look for patterns like ADR 0042, ADR-0042, (ADR 0042), #0042
    const adrRe = /\bADR[- ](\d{4})\b/g;
    let adr: RegExpExecArray | null;
    while ((adr = adrRe.exec(line)) !== null) {
      const num = adr[1];
      if (num && !adrFileExists(num)) {
        report.warn(`Context doc references ADR ${num} which does not exist in ${ADR_DIR}/.`, {
          file: docRel,
          line: idx + 1,
          remediation: 'Create the ADR file or remove the stale reference.',
        });
      }
    }
  });
}

/** Verify each persona doc has required structural sections. */
function checkPersonaStructure(report: Report): void {
  let personaEntries: string[];
  try {
    personaEntries = readdirSync(fromRepo(PERSONAS_DIR)).filter(
      (e) => e.endsWith('.md') && e !== 'README.md',
    );
  } catch {
    return;
  }

  for (const entry of personaEntries) {
    const rel = `${PERSONAS_DIR}/${entry}`;
    const text = readFileSync(fromRepo(rel), 'utf8');
    for (const section of PERSONA_REQUIRED_SECTIONS) {
      if (!text.includes(section)) {
        report.warn(`Persona doc is missing required section "${section}".`, {
          file: rel,
          remediation: `Add a "${section}" section per the persona doc template.`,
        });
      }
    }
  }
}

/** Verify the personas listed in the routing README each have a file. */
function checkPersonaRoutingCompleteness(report: Report): void {
  const readmePath = `${PERSONAS_DIR}/README.md`;
  let readmeText: string;
  try {
    readmeText = readFileSync(fromRepo(readmePath), 'utf8');
  } catch {
    return;
  }

  // Extract linked persona filenames from markdown table rows like `[Producer](./producer.md)`
  const linkRe = /\[.*?\]\(\.\/([a-z-]+\.md)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(readmeText)) !== null) {
    const filename = m[1];
    if (!filename) continue;
    const rel = `${PERSONAS_DIR}/${filename}`;
    if (!existsOnDisk(rel)) {
      report.warn(`Routing README links to persona file that does not exist: \`${rel}\``, {
        file: readmePath,
        remediation: 'Create the persona file or update the routing README.',
      });
    }
  }
}

/** Check that copilot-instructions.md and AGENTS.md are not diverged structurally.
 *  Heuristic: both should reference the same key policy documents. */
function checkContextConsistency(report: Report): void {
  const agentsPath = 'AGENTS.md';
  const copilotPath = '.github/copilot-instructions.md';

  let agentsText: string | null = null;
  let copilotText: string | null = null;
  try {
    agentsText = readFileSync(fromRepo(agentsPath), 'utf8');
  } catch {
    /* not found */
  }
  try {
    copilotText = readFileSync(fromRepo(copilotPath), 'utf8');
  } catch {
    /* not found */
  }
  if (!agentsText || !copilotText) return;

  // Flag if the two disagree on the preflight script path
  const agentsPreflight = /bash ([^\s`]+preflight[^\s`]*)/
    .exec(agentsText)?.[1]
    ?.replace(/`/g, '');
  const copilotPreflight = /bash ([^\s`]+preflight[^\s`]*)/
    .exec(copilotText)?.[1]
    ?.replace(/`/g, '');
  if (agentsPreflight && copilotPreflight && agentsPreflight !== copilotPreflight) {
    report.warn(
      `AGENTS.md and copilot-instructions.md reference different preflight scripts: ` +
        `\`${agentsPreflight}\` vs \`${copilotPreflight}\`.`,
      {
        remediation: 'Reconcile so both docs point to the same preflight script.',
      },
    );
  }

  // Warn if one doc references a verify command the other doesn't
  const verifyRe = /`npm run (verify[a-z:_-]*)`/g;
  const agentsVerify = new Set<string>();
  const copilotVerify = new Set<string>();
  let mv: RegExpExecArray | null;
  const re1 = new RegExp(verifyRe.source, 'g');
  while ((mv = re1.exec(agentsText)) !== null) {
    if (mv[1]) agentsVerify.add(mv[1]);
  }
  const re2 = new RegExp(verifyRe.source, 'g');
  while ((mv = re2.exec(copilotText)) !== null) {
    if (mv[1]) copilotVerify.add(mv[1]);
  }
  for (const cmd of agentsVerify) {
    if (!copilotVerify.has(cmd)) {
      report.warn(
        `AGENTS.md references \`npm run ${cmd}\` but copilot-instructions.md does not.`,
        {
          remediation: 'Ensure both docs stay in sync on required verify commands.',
        },
      );
    }
  }
}

async function main(): Promise<void> {
  const report = new Report('docs-check-context');
  const packageScripts = loadPackageScripts();
  const docs = listContextDocs();

  if (docs.length === 0) {
    report.warn('No context doc files found for scanning.');
    report.finish();
  }

  for (const docRel of docs) {
    const text = readFileSync(fromRepo(docRel), 'utf8');
    checkDocPaths(docRel, text, packageScripts, report);
  }

  checkPersonaStructure(report);
  checkPersonaRoutingCompleteness(report);
  checkContextConsistency(report);

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-context crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
