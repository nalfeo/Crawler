#!/usr/bin/env node
/**
 * health/orphaned-systems.ts — Deterministic guard against "orphaned" ECS
 * systems: a `*System` exported from `src/core/**` or `src/game/**` that is
 * never referenced by a REAL runtime pipeline entry point (and is not on the
 * documented allowlist).
 *
 * This is the process backstop for the class of bug where `spawnerSystem`
 * shipped fully inert because it was only ever force-called by its lab
 * (`src/labs/spawner-lab/index.ts`), never by the visual game
 * (`src/bootstrap/floor-main-scene-options.ts`) or the headless win-rate gate
 * (`src/game/ai/simulation-step.ts`). See ADR 0039; fix landed in PR #665 /
 * ADR 0036.
 *
 * Deterministic script + exit code (AGENTS.md rule #2 — no LLM-as-judge):
 *   exit 0 → every system is wired or allowlisted.
 *   exit 1 → at least one orphaned system (or a stale allowlist entry).
 *   exit 2 → the guard itself crashed.
 *
 * Pure parsing/set logic lives in `orphaned-systems-lib.ts` for unit testing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  ALLOWLIST,
  MIN_EXPECTED_SYSTEMS,
  SYSTEM_SOURCE_ROOTS,
  WIRING_SITES,
  collectOpenRequiredTrackedIssues,
  collectExportedSystems,
  collectWiredRefs,
  findClosedTrackedIssueEntries,
  findInvalidAllowlistPolicyEntries,
  findDuplicateSystemDeclarations,
  findMalformedAllowlistEntries,
  findOrphanedSystems,
  findStaleAllowlistEntries,
  type SourceFile,
} from './orphaned-systems-lib.js';

function resolveRepo(): { owner: string; repo: string } {
  const slug = process.env.GITHUB_REPOSITORY?.trim();
  if (slug) {
    const [owner, repo] = slug.split('/');
    if (owner && repo) return { owner, repo };
  }
  return { owner: 'nalfeo', repo: 'Crawler' };
}

async function loadTrackedIssueStates(
  entries: ReadonlyArray<{ issueNumber: number }>,
): Promise<Map<number, 'open' | 'closed'>> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const { owner, repo } = resolveRepo();
  const states = new Map<number, 'open' | 'closed'>();
  await Promise.all(
    entries.map(async ({ issueNumber }) => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: ['Bearer', token].join(' '),
            'User-Agent': 'crawler-orphaned-systems-guard',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status} for issue #${issueNumber}`);
      }
      const payload = (await response.json()) as { state?: unknown };
      if (payload.state !== 'open' && payload.state !== 'closed') {
        throw new Error(
          `Issue #${issueNumber} returned unexpected state: ${String(payload.state)}`,
        );
      }
      states.set(issueNumber, payload.state);
    }),
  );
  return states;
}

/** Recursively collect `.ts` files under a directory (skipping declaration files). */
function walkTsFiles(absDir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walkTsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Read a repo-relative file into a `SourceFile` (POSIX path + content). */
function readSourceFile(relPath: string): SourceFile {
  const content = readFileSync(fromRepo(relPath), 'utf8');
  return { path: relPath.replace(/\\/g, '/'), content };
}

function loadSystemSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const root of SYSTEM_SOURCE_ROOTS) {
    for (const abs of walkTsFiles(fromRepo(root))) {
      const rel = path.relative(fromRepo(), abs).replace(/\\/g, '/');
      files.push({ path: rel, content: readFileSync(abs, 'utf8') });
    }
  }
  return files;
}

async function main(): Promise<void> {
  const report = new Report('health-orphaned-systems');

  const sourceFiles = loadSystemSourceFiles();
  const systems = collectExportedSystems(sourceFiles);
  if (systems.length === 0) {
    // Fail CLOSED: if discovery returns nothing the guard has effectively been
    // disabled (source layout drift, a bad refactor, an extension change). A
    // silent exit 0 here would let real orphans merge green — the exact class
    // of failure this guard exists to prevent.
    report.error('No exported *System functions found — the guard is not scanning anything.', {
      remediation:
        `Check SYSTEM_SOURCE_ROOTS (${SYSTEM_SOURCE_ROOTS.join(', ')}) and the file ` +
        `walker in orphaned-systems.ts. The guard fails closed rather than pass vacuously.`,
    });
    report.finish();
  } else if (systems.length < MIN_EXPECTED_SYSTEMS) {
    // Defense-in-depth against a PARTIAL scan regression: a walker that returns
    // only a few files could pass vacuously if those happen to be wired. The
    // repo has far more than MIN_EXPECTED_SYSTEMS systems, so a count this low
    // means the scan is broken, not that the game shrank.
    report.error(
      `Only ${systems.length} system(s) discovered (< MIN_EXPECTED_SYSTEMS=${MIN_EXPECTED_SYSTEMS}) — ` +
        `the scan is almost certainly partial.`,
      {
        remediation:
          `Investigate the file walker / SYSTEM_SOURCE_ROOTS. If the repo legitimately ` +
          `shrank below the floor, lower MIN_EXPECTED_SYSTEMS in orphaned-systems-lib.ts ` +
          `in the same change that removes the systems.`,
      },
    );
    report.finish();
  }

  // Name-based wiring detection is ambiguous if a `*System` name is declared in
  // two files (one wired, one not, would both read as wired). Fail on duplicates.
  for (const dup of findDuplicateSystemDeclarations(sourceFiles)) {
    report.error(
      `Duplicate system name "${dup.name}" is declared in multiple files: ${dup.files.join(', ')}.`,
      {
        remediation:
          `Rename one so each *System name is unique — name-based wiring detection ` +
          `cannot otherwise tell which declaration a pipeline reference points at.`,
      },
    );
  }

  const wiringFiles = WIRING_SITES.map(readSourceFile);
  const wiredRefs = collectWiredRefs(wiringFiles);

  const orphans = findOrphanedSystems({ systems, wiredRefs, allowlist: ALLOWLIST });
  for (const orphan of orphans) {
    report.error(
      `Orphaned system "${orphan.name}" is defined but never referenced by any real pipeline.`,
      {
        file: orphan.file,
        remediation:
          `Wire ${orphan.name} into a real pipeline entry point (one of: ` +
          `${WIRING_SITES.join(', ')}) — a lab that force-calls it does NOT count. ` +
          `If it is intentionally not wired, add a structured entry to ALLOWLIST in ` +
          `scripts/agent/health/orphaned-systems-lib.ts (reason + trackedIssue + owner).`,
      },
    );
  }

  // The allowlist is a tracked-debt list, not a mute button: every entry must
  // carry reason + trackedIssue + owner, or the guard fails (rule #12).
  for (const bad of findMalformedAllowlistEntries(ALLOWLIST)) {
    report.error(
      `ALLOWLIST entry "${bad.name}" is missing required field(s): ${bad.missing.join(', ')}.`,
      {
        file: 'scripts/agent/health/orphaned-systems-lib.ts',
        remediation: `Add ${bad.missing.join(' + ')} to the "${bad.name}" allowlist entry.`,
      },
    );
  }

  for (const bad of findInvalidAllowlistPolicyEntries(ALLOWLIST)) {
    report.error(
      `ALLOWLIST entry "${bad.name}" has invalid tracking metadata: ${bad.invalid.join(', ')}.`,
      {
        file: 'scripts/agent/health/orphaned-systems-lib.ts',
        remediation:
          `Use trackedIssuePolicy="reference-only" for provenance refs, or ` +
          `trackedIssuePolicy="open-required" with a repo-local "#123" issue ref ` +
          `for live allowlist debt.`,
      },
    );
  }

  for (const stale of findStaleAllowlistEntries(systems, wiredRefs, ALLOWLIST)) {
    if (stale.kind === 'missing') {
      report.error(`Stale ALLOWLIST entry "${stale.name}" — no such exported system exists.`, {
        file: 'scripts/agent/health/orphaned-systems-lib.ts',
        remediation: `Remove "${stale.name}" from ALLOWLIST; the system it excused is gone.`,
      });
    } else {
      report.error(
        `Redundant ALLOWLIST entry "${stale.name}" — it is now wired into a real pipeline.`,
        {
          file: 'scripts/agent/health/orphaned-systems-lib.ts',
          remediation: `Remove "${stale.name}" from ALLOWLIST; it no longer needs an exemption.`,
        },
      );
    }
  }

  const openRequiredIssues = collectOpenRequiredTrackedIssues(ALLOWLIST);
  if (openRequiredIssues.length > 0) {
    if (!process.env.GITHUB_TOKEN?.trim()) {
      report.info(
        `Skipping allowlist tracking-issue state audit for ${openRequiredIssues.length} open-required entr` +
          `${openRequiredIssues.length === 1 ? 'y' : 'ies'} (no GITHUB_TOKEN in environment).`,
      );
    } else {
      const issueStates = await loadTrackedIssueStates(openRequiredIssues);
      for (const closed of findClosedTrackedIssueEntries(openRequiredIssues, issueStates)) {
        report.error(
          `ALLOWLIST entry "${closed.name}" still remains, but its tracking issue ${closed.trackedIssue} is closed.`,
          {
            file: 'scripts/agent/health/orphaned-systems-lib.ts',
            remediation:
              `Remove "${closed.name}" from ALLOWLIST, reopen/file a fresh tracking issue, ` +
              `or reclassify the entry as trackedIssuePolicy="reference-only" if the ref is ` +
              `provenance rather than live debt.`,
          },
        );
      }
    }
  }

  if (orphans.length === 0) {
    report.info(
      `${systems.length} system(s) checked; all wired into a real pipeline or documented on the allowlist.`,
    );
  }

  report.finish();
}

try {
  await main();
} catch (err) {
  process.stderr.write(
    `orphaned-systems crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
}
