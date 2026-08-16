export interface RequiredTopic {
  readonly label: string;
  readonly pattern: RegExp;
  readonly remediation: string;
}

export const REQUIRED_REVIEW_TOPICS: readonly RequiredTopic[] = [
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
    pattern:
      /\*\*Determinism:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*Math\.random\(\)(?:(?!\n- \*\*|\n##)[\s\S])*Date\.now\(\)/i,
    remediation:
      'Call out deterministic simulation hazards, including Math.random() and Date.now().',
  },
  {
    label: 'runtime wiring',
    pattern:
      /\*\*Runtime wiring:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*(?:real sim-side|real simulation|headless pipeline)/i,
    remediation: 'Require reviewers to distinguish lab-only success from real runtime wiring.',
  },
  {
    label: 'layer boundaries',
    pattern:
      /\*\*Layer boundaries:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*core ECS(?:(?!\n- \*\*|\n##)[\s\S])*engine/i,
    remediation: 'Keep ECS/Phaser/lab import boundaries in the review checklist.',
  },
  {
    label: 'performance',
    pattern:
      /\*\*Performance:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*(?:hot loops|per-frame allocation|large data scans)/i,
    remediation:
      'Retain explicit performance prompts for hot loops, allocation, and scaling hazards.',
  },
  {
    label: 'regression coverage',
    pattern: /\*\*Regression coverage:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*deterministic/i,
    remediation: 'Require deterministic regression coverage for confirmed bugs.',
  },
  {
    label: 'recurring failure patterns',
    pattern: /Recurring Crawler failure patterns[\s\S]*Lab-only success[\s\S]*Silent reverts/i,
    remediation: 'Preserve the historical regression pattern checklist.',
  },
  {
    label: 'automation deadlocks',
    pattern:
      /\*\*Automation deadlocks:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*(?:throw out of an item loop|skip remaining work)/i,
    remediation: 'Keep CI/docs/merge-train loop failure patterns visible to reviewers.',
  },
  {
    label: 'sweep and benchmark misuse',
    pattern:
      /\*\*Sweep and benchmark misuse:\*\*(?:(?!\n- \*\*|\n##)[\s\S])*(?:Sweep Results Viewer|cherry-picked seeds)/i,
    remediation: 'Keep sweep-result and seed-evidence review prompts explicit.',
  },
];

const RECURRING_FAILURE_PATTERNS_HEADING = /^## Recurring Crawler failure patterns to hunt$/m;
const CANONICAL_REVIEW_CONTRACT_LINK =
  /\[[^\]]+\]\(\s*(?:\.\.\/)*(?:\.github\/)?instructions\/review\.instructions\.md(?:#[^)\s]+)?\s*\)/;

function lineOf(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  if (match.index === 0) return 1;
  return text.slice(0, match.index).split('\n').length;
}

export interface ReviewProcessEvaluation {
  readonly missingTopics: readonly RequiredTopic[];
  readonly recurringFailurePatternsHeadingLine: number | undefined;
  readonly hasCanonicalReviewContractLink: boolean;
}

export function evaluateReviewProcess(
  reviewInstructions: string,
  copilotInstructions: string,
): ReviewProcessEvaluation {
  return {
    missingTopics: REQUIRED_REVIEW_TOPICS.filter(
      (topic) => !topic.pattern.test(reviewInstructions),
    ),
    recurringFailurePatternsHeadingLine: lineOf(
      reviewInstructions,
      RECURRING_FAILURE_PATTERNS_HEADING,
    ),
    hasCanonicalReviewContractLink: CANONICAL_REVIEW_CONTRACT_LINK.test(copilotInstructions),
  };
}
