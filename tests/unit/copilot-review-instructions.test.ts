import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REVIEW_CONTRACT = readFileSync('.github/instructions/review.instructions.md', 'utf8');
const COPILOT_INSTRUCTIONS = readFileSync('.github/copilot-instructions.md', 'utf8');
const REVIEW_LOOP = readFileSync(
  '.github/skills/review-harness/references/code-review-loop.md',
  'utf8',
);

describe('Copilot review instructions', () => {
  it('applies one exhaustive Reviewer contract to every changed path', () => {
    expect(REVIEW_CONTRACT).toContain("applyTo: '**'");
    expect(REVIEW_CONTRACT).toContain('adopt the **Reviewer** persona');
    expect(REVIEW_CONTRACT).toContain('Read the complete diff before reporting any finding');
    expect(REVIEW_CONTRACT).toContain('Review every category below');
    expect(REVIEW_CONTRACT).toContain('correctness, edge cases, and failure handling');
    expect(REVIEW_CONTRACT).toContain(
      'data flow, state lifecycle, ordering, concurrency, and determinism',
    );
    expect(REVIEW_CONTRACT).toContain('API/contracts, compatibility, and cross-layer integration');
    expect(REVIEW_CONTRACT).toContain(
      'security, trust boundaries, secrets, and unsafe input/output handling',
    );
    expect(REVIEW_CONTRACT).toContain(
      'runtime wiring, cleanup, resource ownership, and performance regressions',
    );
    expect(REVIEW_CONTRACT).toContain(
      "regression coverage and compliance with Crawler's path-specific policies",
    );
    expect(REVIEW_CONTRACT).toContain('second pass over the complete diff');
    expect(REVIEW_CONTRACT).toContain('Report all validated findings together in one response');
    expect(REVIEW_CONTRACT).toContain('coverage statement');
    expect(REVIEW_CONTRACT).toContain('Do not stop after the first issue');
  });

  it('routes native Copilot review to the canonical contract', () => {
    expect(COPILOT_INSTRUCTIONS).toContain('.github/instructions/review.instructions.md');
    expect(COPILOT_INSTRUCTIONS).toMatch(/return all validated\s+findings in one pass/);
  });

  it('routes model-selectable harness reviews to the same contract', () => {
    expect(REVIEW_LOOP).toContain('.github/instructions/review.instructions.md');
    expect(REVIEW_LOOP).toContain('docs/agent-os/personas/reviewer.md');
    expect(REVIEW_LOOP).toContain("task` tool's `model` parameter");
    expect(REVIEW_LOOP).toContain('Native GitHub Copilot pull-request review uses GitHub');
    expect(REVIEW_LOOP).toContain('prompt="<canonical review prompt above>"');
    expect(REVIEW_LOOP).not.toMatch(
      /task\(agent_type="code-review"[^)\n]*prompt="<diff review prompt>"/,
    );
  });
});
