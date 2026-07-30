#!/usr/bin/env tsx
/**
 * check-knip-suppressions.ts — Blocking guard that validates every entry in
 * the KNIP_SUPPRESSIONS list:
 *
 * 1. No suppression may be expired (fail: "fix the deadness, don't extend the date").
 * 2. No suppression may have had its `expiresOn` bumped without also changing
 *    `reason` (reason-restatement rule — same as the npm-audit guard).
 *
 * exit 0 → all suppressions are valid.
 * exit 1 → at least one expired suppression or reason-restatement violation.
 * exit 2 → the guard itself crashed.
 *
 * Pure logic lives in `knip-suppressions.ts` for unit testing.
 */

import process from 'node:process';
import { Report } from '../shared/report.js';
import {
  KNIP_SUPPRESSIONS,
  findExpiredSuppressions,
  getReasonRestatementViolationsForCurrentBranch,
} from './knip-suppressions.js';

type ReasonViolation = {
  file: string;
  previousExpiresOn: string;
  currentExpiresOn: string;
};

function getReasonViolationsOrReport(report: Report): ReasonViolation[] | null {
  try {
    return getReasonRestatementViolationsForCurrentBranch();
  } catch (err) {
    report.error(
      `Could not resolve base ref for reason-restatement check: ${err instanceof Error ? err.message : String(err)}`,
      {
        remediation: 'Ensure the repository checkout includes the base commit (fetch-depth: 0).',
      },
    );
    report.finish();
    return null;
  }
}

function main(): void {
  const report = new Report('health-knip-suppressions');

  // ── 1. Reason-restatement check ──────────────────────────────────────────
  // Must run first (same as npm-audit.mjs) so an agent that only bumps the
  // date without changing the reason sees the violation immediately.
  const reasonViolations = getReasonViolationsOrReport(report);
  if (!reasonViolations) {
    return;
  }

  for (const v of reasonViolations) {
    report.error(
      `KNIP_SUPPRESSIONS entry for "${v.file}" changed expiresOn ` +
        `(${v.previousExpiresOn} → ${v.currentExpiresOn}) without changing reason. ` +
        `Extending a suppression requires a restated, current justification.`,
      {
        file: 'scripts/agent/health/knip-suppressions.ts',
        remediation:
          `Update the "reason" field to reflect the CURRENT status of why this ` +
          `file still has no production callers, then set a new expiresOn.`,
      },
    );
  }

  // ── 2. Expiry check ──────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const expired = findExpiredSuppressions(KNIP_SUPPRESSIONS, today);

  for (const s of expired) {
    report.error(
      `KNIP_SUPPRESSIONS entry for "${s.file}" expired on ${s.expiresOn}. ` +
        `Fix the deadness — don't extend the date.`,
      {
        file: s.file,
        remediation:
          `The suppressed exports in "${s.file}" have had no production callers since ` +
          `${s.expiresOn}. Options:\n` +
          `  (a) Wire the export into real production code and remove the suppression.\n` +
          `  (b) Delete the export (and any tests that exist only to validate dead code).\n` +
          `  (c) If there is a genuine, time-bounded reason to keep it pending, update ` +
          `"reason" with a current justification and set a new "expiresOn".`,
      },
    );
  }

  if (reasonViolations.length === 0 && expired.length === 0) {
    report.info(
      `${KNIP_SUPPRESSIONS.length} KNIP_SUPPRESSIONS entries checked; ` +
        `none expired and no reason-restatement violations.`,
    );
  }

  report.finish();
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `check-knip-suppressions crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
}
