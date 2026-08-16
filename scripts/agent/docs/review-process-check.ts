#!/usr/bin/env node
/**
 * docs/review-process-check.ts — deterministic nightly check for the Copilot
 * PR-review instruction pipeline.
 *
 * This is intentionally not an LLM judge. It verifies that the instruction file
 * GitHub Copilot reviews are routed through still contains the high-yield
 * review anchors Crawler has learned from prior regressions, and that the
 * GitHub-facing Copilot instructions point reviewers at that canonical contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Report, fromRepo } from '../shared/report.js';
import { evaluateReviewProcess } from './review-process-check-lib.js';

const REVIEW_INSTRUCTIONS_PATH = '.github/instructions/review.instructions.md';
const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';

function readRequiredFile(report: Report, file: string): string | null {
  const path = fromRepo(file);
  if (!existsSync(path)) {
    report.error(`${file} is missing.`, {
      file,
      remediation: 'Restore the GitHub Copilot review instruction pipeline file.',
    });
    return null;
  }
  return readFileSync(path, 'utf8');
}

async function main(): Promise<void> {
  const report = new Report('docs-review-process-check');
  const reviewInstructions = readRequiredFile(report, REVIEW_INSTRUCTIONS_PATH);
  const copilotInstructions = readRequiredFile(report, COPILOT_INSTRUCTIONS_PATH);

  const evaluation = evaluateReviewProcess(reviewInstructions ?? '', copilotInstructions ?? '');

  if (reviewInstructions) {
    for (const topic of evaluation.missingTopics) {
      report.error(`Review instructions are missing required topic: ${topic.label}.`, {
        file: REVIEW_INSTRUCTIONS_PATH,
        remediation: topic.remediation,
      });
    }

    if (evaluation.recurringFailurePatternsHeadingLine) {
      report.finding({
        severity: 'info',
        message: 'Review process checklist includes recurring Crawler failure patterns.',
        file: REVIEW_INSTRUCTIONS_PATH,
        line: evaluation.recurringFailurePatternsHeadingLine,
      });
    }
  }

  if (copilotInstructions) {
    if (!evaluation.hasCanonicalReviewContractLink) {
      report.error(
        'GitHub-facing Copilot instructions do not link the canonical review contract.',
        {
          file: COPILOT_INSTRUCTIONS_PATH,
          remediation: `Link ${REVIEW_INSTRUCTIONS_PATH} from ${COPILOT_INSTRUCTIONS_PATH}.`,
        },
      );
    }
  }

  if (report.blockingCount() === 0) {
    report.info('Review-process instruction coverage is healthy.');
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `review-process-check crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
});
