import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-recovery-router.yml');

interface WorkflowDoc {
  name: string;
  'run-name'?: string;
}

function loadWorkflow(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

/**
 * The review-wake bridge reads the source PR number back from the run's
 * `display_title`, which GitHub derives from this `run-name`. These assertions
 * pin the exact wiring the bridge depends on: the trusted event PR number is
 * encoded for review/review-comment events, and every other event falls back to
 * GitHub's native event-specific title.
 */
describe('CI Recovery Router run-name source-PR binding', () => {
  it('keeps the workflow name stable so the bridge run.name gate still matches', () => {
    const { doc } = loadWorkflow();
    expect(doc.name).toBe('CI Recovery Router');
  });

  it('encodes the trusted event PR number into run-name for review events only', () => {
    const { doc, raw } = loadWorkflow();
    const runName = doc['run-name'];
    expect(runName, 'router must define run-name').toBeTruthy();
    const collapsed = String(runName).replace(/\s+/g, ' ').trim();

    // Only review / review-comment events opt into the encoded title.
    expect(collapsed).toContain("github.event_name == 'pull_request_review'");
    expect(collapsed).toContain("github.event_name == 'pull_request_review_comment'");

    // The PR number comes from the trusted webhook field, not from any
    // attacker-influenceable association, and uses the exact marker the bridge
    // parses (REVIEW_RUN_NAME_PR_PREFIX in review-wake-bridge.mjs).
    expect(collapsed).toContain(
      "format('CI Recovery Router: review-wake pr-{0}', github.event.pull_request.number)",
    );

    // Whitespace tells GitHub to retain its native event-specific run title.
    expect(raw).toMatch(/\|\|\s*' '\s*\}\}/);
  });

  it('marker prefix matches the bridge parser exactly', () => {
    // Mirror the bridge's REVIEW_RUN_NAME_PR_PREFIX / format template so a rename
    // on either side fails this test.
    const { doc } = loadWorkflow();
    const collapsed = String(doc['run-name']).replace(/\s+/g, ' ').trim();
    const bridge = readFileSync(
      path.join(REPO_ROOT, '.github/scripts/ci-recovery/review-wake-bridge.mjs'),
      'utf8',
    );
    expect(bridge).toContain(
      'const REVIEW_RUN_NAME_PR_PREFIX = `${ROUTER_WORKFLOW_NAME}: review-wake pr-`;',
    );
    // The router's format() output, with {0} filled by a PR number, must begin
    // with that prefix.
    expect(collapsed).toContain("format('CI Recovery Router: review-wake pr-{0}'");
  });
});
