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

const REVIEW_INSTRUCTIONS_PATH = '.github/instructions/review.instructions.md';
const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';

interface RequiredTopic {
  readonly label: string;
  readonly pattern: RegExp;
  readonly remediation: string;
}

const REQUIRED_REVIEW_TOPICS: readonly RequiredTopic[] = [
  {
    label: 'changed-files scope discipline',
    pattern: /whole-codebase scan|changed files|files changed by the PR/i,
    remediation: 'Tell Copilot to start from changed files/systems and avoid unbounded scans.',
  },
  {
    label: 'gameplay correctness',
    pattern: /gameplay correctness|damage, XP, loot|quest progression/i,
    remediation: 'Keep game-mechanics correctness as an explicit review category.',
  },
  {
    label: 'determinism',
    pattern: /Determinism:[\s\S]*Math\.random\(\)[\s\S]*Date\.now\(\)/i,
    remediation:
      'Call out deterministic simulation hazards, including Math.random() and Date.now().',
  },
  {
    label: 'runtime wiring',
    pattern: /Runtime wiring:[\s\S]*real sim-side|real simulation|headless pipeline/i,
    remediation: 'Require reviewers to distinguish lab-only success from real runtime wiring.',
  },
  {
    label: 'layer boundaries',
    pattern: /Layer boundaries:[\s\S]*core ECS[\s\S]*engine/i,
    remediation: 'Keep ECS/Phaser/lab import boundaries in the review checklist.',
  },
  {
    label: 'performance',
    pattern: /Performance:[\s\S]*hot loops|per-frame allocation|large data scans/i,
    remediation:
      'Retain explicit performance prompts for hot loops, allocation, and scaling hazards.',
  },
  {
    label: 'regression coverage',
    pattern: /Regression coverage:[\s\S]*deterministic/i,
    remediation: 'Require deterministic regression coverage for confirmed bugs.',
  },
  {
    label: 'recurring failure patterns',
    pattern: /Recurring Crawler failure patterns[\s\S]*Lab-only success[\s\S]*Silent reverts/i,
    remediation: 'Preserve the historical regression pattern checklist.',
  },
  {
    label: 'automation deadlocks',
    pattern: /Automation deadlocks[\s\S]*throw out of an item loop|skip remaining work/i,
    remediation: 'Keep CI/docs/merge-train loop failure patterns visible to reviewers.',
  },
  {
    label: 'sweep and benchmark misuse',
    pattern: /Sweep and benchmark misuse[\s\S]*Sweep Results Viewer|cherry-picked seeds/i,
    remediation: 'Keep sweep-result and seed-evidence review prompts explicit.',
  },
];

function lineOf(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  if (match.index === 0) return 1;
  return text.slice(0, match.index).split('\n').length;
}

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

  if (reviewInstructions) {
    for (const topic of REQUIRED_REVIEW_TOPICS) {
      if (!topic.pattern.test(reviewInstructions)) {
        report.error(`Review instructions are missing required topic: ${topic.label}.`, {
          file: REVIEW_INSTRUCTIONS_PATH,
          remediation: topic.remediation,
        });
      }
    }

    const headingLine = lineOf(reviewInstructions, /^## Recurring Crawler failure patterns$/m);
    if (headingLine) {
      report.finding({
        severity: 'info',
        message: 'Review process checklist includes recurring Crawler failure patterns.',
        file: REVIEW_INSTRUCTIONS_PATH,
        line: headingLine,
      });
    }
  }

  if (copilotInstructions) {
    const canonicalLink =
      /\.github\/instructions\/review\.instructions\.md|instructions\/review\.instructions\.md/.test(
        copilotInstructions,
      );
    if (!canonicalLink) {
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
