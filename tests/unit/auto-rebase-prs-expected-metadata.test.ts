import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/auto-rebase-prs.yml');

interface WorkflowDoc {
  on: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        { description?: string; required?: boolean; default?: string; type?: string }
      >;
    };
  };
}

function loadWorkflow(): { doc: WorkflowDoc; raw: string } {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return { doc: parse(raw) as WorkflowDoc, raw };
}

describe('auto-rebase workflow expected metadata wiring', () => {
  it('accepts an expected base ref alongside the expected head sha', () => {
    const { doc } = loadWorkflow();
    expect(doc.on.workflow_dispatch?.inputs?.expected_head_sha).toMatchObject({
      default: '',
      type: 'string',
    });
    expect(doc.on.workflow_dispatch?.inputs?.expected_base_ref).toMatchObject({
      default: '',
      type: 'string',
    });
  });

  it('filters targeted dispatches by exact base ref and forwards both metadata fields to nested recovery', () => {
    const { doc, raw } = loadWorkflow();
    const rebaseJob = (
      doc as { jobs?: { 'rebase-prs'?: { steps?: Array<{ env?: Record<string, string> }> } } }
    ).jobs?.['rebase-prs'];
    const rebaseStep = rebaseJob?.steps?.find((step) => step.env?.GH_TOKEN);
    expect(rebaseStep?.env?.EXPECTED_BASE_REF_INPUT).toBe('${{ inputs.expected_base_ref }}');
    expect(raw).toContain('expected_base="${EXPECTED_BASE_REF_INPUT}"');
    expect(raw).toContain('if [ -z "$expected_base" ]; then');
    expect(raw).toContain('expected_base=main');
    expect(raw).toContain('.baseRefName == $expectedBase');
    expect(raw).toContain(
      '--json number,isDraft,baseRefName,headRefOid,headRefName,headRepository,headRepositoryOwner,labels',
    );
    expect(raw).toContain(`expected_base=$(echo "$pr" | jq -r '.baseRefName // "main"')`);
    expect((raw.match(/-f expected_head_sha=/g) ?? []).length).toBe(2);
    expect((raw.match(/-f expected_base_ref=/g) ?? []).length).toBe(2);
  });
});
