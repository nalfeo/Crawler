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

  it('forces head movement for ci-recovery-validation no-op rebases', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toContain('DISPATCH_TRIGGER_INPUT: ${{ inputs.trigger }}');
    expect(raw).toContain('[ "$DISPATCH_TRIGGER_INPUT" = "ci-recovery-validation" ]');
    expect(raw).toContain('[ "$rebased_head" = "$expected_head" ]');
    expect(raw).toContain(
      'git commit --allow-empty -m "chore(ci-recovery): retrigger validation recovery for PR #$number"',
    );
  });

  it('D2 fix: non-train mode uses update-branch API for clean-BEHIND PRs, not git force-push', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    // D2: include mergeStateStatus in the non-train prs_json fetch
    expect(raw).toContain('mergeStateStatus');
    // D2: use GitHub update-branch API; prefer CRAWLER_CI_PAT so push events re-trigger CI
    expect(raw).toContain('gh api');
    expect(raw).toContain('-X PUT "repos/$GITHUB_REPOSITORY/pulls/$number/update-branch"');
    expect(raw).toContain('-F expected_head_sha="$expected_head"');
    // D2: use CRAWLER_CI_PAT when available so CI is triggered on the updated branch
    expect(raw).toContain('CRAWLER_CI_PAT');
    expect(raw).toContain('update_branch_token');
    // D2: route BEHIND → update-branch, DIRTY → ci-recovery dispatch
    expect(raw).toContain('BEHIND)');
    expect(raw).toContain('DIRTY)');
    // D2: non-train blanket sweep no longer runs git rebase for all PRs
    // (git rebase still runs in train mode for targeted conflict recovery only)
    expect(raw).toContain('if [ "$train_enabled" != "true" ]; then');
    // summary counter tracks update-branch successes separately from rebases
    expect(raw).toContain('updated=0');
    expect(raw).toContain('updated=$((updated + 1))');
    expect(raw).toContain('updated=$updated');
    // D2: non-422 failures must be counted as hard failures, not silently skipped
    expect(raw).toContain('failed=$((failed + 1))');
  });

  it('honors merge-automation opt-out labels before any branch mutation', () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    // Mirrors the exclusion labels enforced by .github/scripts/ci-recovery/router.mjs.
    expect(raw).toContain('. == "ci-recovery-opt-out" or . == "human-approval-required"');
    expect(raw).toContain('opt_out_label=$(');
    expect(raw).toContain('if [ -n "$opt_out_label" ]; then');
    expect(raw).toContain('label opts out of merge automation');

    // The guard must precede every mutating action, otherwise an opted-out PR is
    // still rebased, force-pushed, or given an empty retrigger commit.
    const guardIdx = raw.indexOf('opt_out_label=$(');
    expect(guardIdx).toBeGreaterThan(-1);
    for (const mutation of [
      '-X PUT "repos/$GITHUB_REPOSITORY/pulls/$number/update-branch"',
      'if git rebase origin/main; then',
      'git commit --allow-empty -m "chore(ci-recovery): retrigger validation recovery for PR #$number"',
      'git push --force-with-lease=',
    ]) {
      const mutationIdx = raw.indexOf(mutation);
      expect(mutationIdx, `missing mutation anchor: ${mutation}`).toBeGreaterThan(-1);
      expect(guardIdx, `opt-out guard must precede: ${mutation}`).toBeLessThan(mutationIdx);
    }
  });
});
