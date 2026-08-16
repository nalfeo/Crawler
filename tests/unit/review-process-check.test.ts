import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateReviewProcess,
  REQUIRED_REVIEW_TOPICS,
} from '../../scripts/agent/docs/review-process-check-lib';

const REVIEW_INSTRUCTIONS = readFileSync('.github/instructions/review.instructions.md', 'utf8');
const COPILOT_INSTRUCTIONS = readFileSync('.github/copilot-instructions.md', 'utf8');

const VALID_REVIEW_INSTRUCTIONS = `\
Start from files changed by the PR; never perform a whole-codebase scan.
Gameplay correctness covers damage, XP, loot, and quest progression.
**Determinism:** Math.random() and Date.now() are forbidden.
**Runtime wiring:** use a real sim-side/shared pipeline.
**Layer boundaries:** core ECS stays separate from the engine.
**Performance:** inspect hot loops, per-frame allocation, and large data scans.
**Regression coverage:** use deterministic tests.
## Recurring Crawler failure patterns to hunt
**Lab-only success** and **Silent reverts** are risks.
**Automation deadlocks:** do not throw out of an item loop or skip remaining work.
**Sweep and benchmark misuse:** use the Sweep Results Viewer; avoid cherry-picked seeds.
`;

const TOPIC_LINES: Record<string, string> = {
  'changed-files scope discipline':
    'Start from files changed by the PR; never perform a whole-codebase scan.',
  'gameplay correctness': 'Gameplay correctness covers damage, XP, loot, and quest progression.',
  determinism: '**Determinism:** Math.random() and Date.now() are forbidden.',
  'runtime wiring': '**Runtime wiring:** use a real sim-side/shared pipeline.',
  'layer boundaries': '**Layer boundaries:** core ECS stays separate from the engine.',
  performance: '**Performance:** inspect hot loops, per-frame allocation, and large data scans.',
  'regression coverage': '**Regression coverage:** use deterministic tests.',
  'recurring failure patterns':
    '## Recurring Crawler failure patterns to hunt\n**Lab-only success** and **Silent reverts** are risks.',
  'automation deadlocks':
    '**Automation deadlocks:** do not throw out of an item loop or skip remaining work.',
  'sweep and benchmark misuse':
    '**Sweep and benchmark misuse:** use the Sweep Results Viewer; avoid cherry-picked seeds.',
};

describe('review-process-check', () => {
  it('accepts the checked-in review instructions and canonical Markdown link', () => {
    const evaluation = evaluateReviewProcess(REVIEW_INSTRUCTIONS, COPILOT_INSTRUCTIONS);

    expect(evaluation.missingTopics).toEqual([]);
    expect(evaluation.recurringFailurePatternsHeadingLine).toBeGreaterThan(0);
    expect(evaluation.hasCanonicalReviewContractLink).toBe(true);
  });

  it.each(REQUIRED_REVIEW_TOPICS)('detects a missing $label topic', (topic) => {
    const evaluation = evaluateReviewProcess(
      VALID_REVIEW_INSTRUCTIONS.replace(TOPIC_LINES[topic.label]!, ''),
      COPILOT_INSTRUCTIONS,
    );

    expect(evaluation.missingTopics.map(({ label }) => label)).toContain(topic.label);
  });

  it('does not accept a runtime signal from another section', () => {
    const evaluation = evaluateReviewProcess(
      VALID_REVIEW_INSTRUCTIONS.replace(
        '**Runtime wiring:** use a real sim-side/shared pipeline.',
        '**Runtime wiring:** systems must be connected.',
      ).concat('\n## Other section\nA headless pipeline is useful here.\n'),
      COPILOT_INSTRUCTIONS,
    );

    expect(evaluation.missingTopics.map(({ label }) => label)).toContain('runtime wiring');
  });

  it('requires the canonical contract to be a Markdown link target', () => {
    const evaluation = evaluateReviewProcess(
      VALID_REVIEW_INSTRUCTIONS,
      'The contract lives at `.github/instructions/review.instructions.md`.',
    );

    expect(evaluation.hasCanonicalReviewContractLink).toBe(false);
  });
});
