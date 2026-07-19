import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/auto-rebase-prs.yml');

interface WorkflowInput {
  default?: string;
  required?: boolean;
  type?: string;
}

interface WorkflowDoc {
  on: {
    workflow_dispatch: {
      inputs: Record<string, WorkflowInput>;
    };
  };
}

describe('CI recovery auto-rebase callback fencing', () => {
  it('propagates paired head/base metadata through both targeted callbacks only', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = parse(raw) as WorkflowDoc;
    expect(doc.on.workflow_dispatch.inputs.expected_head_sha).toEqual({
      description: 'Expected PR head SHA for conflict-only rebase',
      required: false,
      default: '',
      type: 'string',
    });
    expect(doc.on.workflow_dispatch.inputs.expected_base_ref).toEqual({
      description: 'Expected PR base ref for conflict-only recovery callbacks',
      required: false,
      default: '',
      type: 'string',
    });
    expect(raw.match(/-f expected_head_sha="\$expected_head"/g)).toHaveLength(2);
    expect(raw.match(/-f expected_base_ref="\$expected_base"/g)).toHaveLength(2);
    expect(raw).toContain('if [ "$train_enabled" = "true" ]; then');
  });

  it('passes workflow inputs through env and rechecks live PR metadata before push', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toContain('TARGET_PR: ${{ inputs.pr_number }}');
    expect(raw).toContain('EXPECTED_HEAD_INPUT: ${{ inputs.expected_head_sha }}');
    expect(raw).toContain('EXPECTED_BASE_INPUT: ${{ inputs.expected_base_ref }}');
    expect(raw).toContain('target_pr="$TARGET_PR"');
    expect(raw).toContain('expected_head="$EXPECTED_HEAD_INPUT"');
    expect(raw).toContain('expected_base="$EXPECTED_BASE_INPUT"');
    expect(raw).toContain('targeted rebase dispatch requires expected head/base metadata');
    expect(raw).toContain('gh pr view "$number"');
    expect(raw).toContain('metadata drifted after rebase');
    expect(raw).toContain('.baseRefName == $base');
    expect(raw).toContain('.headRefOid == $expected');
  });
});
