import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci-pr-disposition.yml');

function loadWorkflowSource(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('ci-pr-disposition workflow', () => {
  it('provisions disposition labels before mutating lifecycle/disposition state', () => {
    const raw = loadWorkflowSource();
    expect(raw).toContain('REQUIRED_DISPOSITION_LABELS');
    expect(raw).toContain("const ABANDON_CANDIDATE_LABEL = 'abandon-candidate'");
    expect(raw).toContain('const QUARANTINED_LABEL = PHASE_LABELS[PHASE.QUARANTINED]');
    expect(raw).toContain('const ABANDONED_LABEL = PHASE_LABELS[PHASE.ABANDONED]');
    expect(raw).toContain('await ensureDispositionLabels();');
  });

  it('keeps label helpers at script scope so the provisioning call can resolve them', () => {
    const raw = loadWorkflowSource();
    const upsertStart = raw.indexOf('async function upsertLifecycleComment');
    const labelHelperStart = raw.indexOf('async function ensureLabel');
    const closingIssuesStart = raw.indexOf('async function getClosingIssues');

    expect(upsertStart).toBeGreaterThanOrEqual(0);
    expect(labelHelperStart).toBeGreaterThan(upsertStart);
    expect(closingIssuesStart).toBeGreaterThan(labelHelperStart);
    expect(raw.slice(upsertStart, labelHelperStart)).toContain(
      'await github.rest.issues.createComment',
    );
    expect(raw.slice(upsertStart, labelHelperStart)).not.toContain(
      'async function ensureLabel',
    );
  });

  it('uses issue-scoped merged closers without a global recency cap', () => {
    const raw = loadWorkflowSource();
    expect(raw).toContain('closedByPullRequestsReferences(first: 100, after: $after)');
    expect(raw).not.toContain('maxMerged = 60');
  });

  it('revalidates duplicate proof against live PR state before close', () => {
    const raw = loadWorkflowSource();
    expect(raw).toContain('pulls.get live-proof-check');
    expect(raw).toContain('skip-close-drift');
    expect(raw).toContain('skip-close-proof-drift');
    expect(raw).toContain('const liveProof = detectDuplicateProof(');
  });

  it('hydrates current lifecycle phase/head from trusted lifecycle comment for quarantine', () => {
    const raw = loadWorkflowSource();
    expect(raw).toContain('function parseCurrentLifecycleRecord(comments, prNumber)');
    expect(raw).toContain('currentPhase: lifecycle?.phase ?? null');
    expect(raw).toContain('currentHeadSha: lifecycle?.headSha ?? null');
  });

  it('only removes shared human-approval label on KEEP when disposition added it', () => {
    const raw = loadWorkflowSource();
    expect(raw).toContain("const DISPOSITION_APPROVAL_LABEL = 'ci-disposition-approval-gate'");
    expect(raw).toContain('if (labelNames.includes(DISPOSITION_APPROVAL_LABEL)) {');
    expect(raw).toContain('labelsToRemove.push(HUMAN_APPROVAL_LABEL);');
  });
});
