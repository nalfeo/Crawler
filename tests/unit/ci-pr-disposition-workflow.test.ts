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
    const dispositionBlocks = raw
      .split('uses: actions/github-script@')
      .slice(1)
      .filter((block) => block.includes('await ensureDispositionLabels();'));

    expect(dispositionBlocks).toHaveLength(3);
    for (const block of dispositionBlocks) {
      const upsert = block.match(/^([ \t]*)async function upsertLifecycleComment/m);
      const ensureLabels = block.match(/^([ \t]*)async function ensureDispositionLabels/m);
      const provisioningCall = block.match(/^([ \t]*)await ensureDispositionLabels\(\);/m);

      if (!upsert || !ensureLabels || !provisioningCall) {
        throw new Error('disposition script is missing lifecycle provisioning functions');
      }

      for (const helperName of [
        'ensureLabel',
        'ensureDispositionLabels',
        'addLabelStrict',
        'removeLabelBestEffort',
      ]) {
        const helper = block.match(
          new RegExp(`^([ \\t]*)async function ${helperName}(?:\\(|$)`, 'm'),
        );
        expect(helper?.[1]).toBe(upsert[1]);
      }
      expect(ensureLabels[1]).toBe(upsert[1]);
      expect(provisioningCall[1]).toBe(upsert[1]);
      expect(block.indexOf(ensureLabels[0])).toBeLessThan(block.indexOf(provisioningCall[0]));
    }

    const quarantineBlocks = dispositionBlocks.filter((block) =>
      block.includes('function isTrustedLifecycleComment'),
    );
    expect(quarantineBlocks).toHaveLength(1);
    const quarantineBlock = quarantineBlocks[0];
    const quarantineUpsert = quarantineBlock?.match(
      /^([ \t]*)async function upsertLifecycleComment/m,
    );
    if (!quarantineBlock || !quarantineUpsert) {
      throw new Error('quarantine script is missing lifecycle helper functions');
    }
    for (const helperName of ['isTrustedLifecycleComment', 'parseCurrentLifecycleRecord']) {
      const helper = quarantineBlock.match(
        new RegExp(`^([ \\t]*)function ${helperName}(?:\\(|$)`, 'm'),
      );
      expect(helper?.[1]).toBe(quarantineUpsert[1]);
    }
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

  it('applies the close-grace window to every close path, using live PR timestamps', () => {
    const raw = loadWorkflowSource();
    // Shared, fail-closed grace evaluation (PR #2948) instead of ad-hoc timestamp math.
    expect(raw).toContain('evaluateCloseGrace');
    expect(raw).not.toMatch(/const tooFresh\s*=/);
    // Loop-level guard on the pulls.list snapshot.
    expect(raw).toContain('const grace = evaluateCloseGrace(');
    // The legacy coordinator-superseded close re-fetches the PR and re-evaluates
    // freshness on live timestamps, so activity after the list snapshot is seen.
    expect(raw).toContain('pulls.get coordinator-close');
    expect(raw).toContain('const liveGrace = evaluateCloseGrace(');
    expect(raw).toContain('createdAt: liveCoordPr.created_at, updatedAt: liveCoordPr.updated_at');
    expect(raw).toContain('path=coordinator-superseded');

    // The live re-check must precede the coordinator close mutation.
    const coordFetchIndex = raw.indexOf('pulls.get coordinator-close');
    const coordCloseIndex = raw.indexOf(
      'closed-duplicate pr=#${pull.number} rule=coordinator-superseded',
    );
    expect(coordFetchIndex).toBeGreaterThan(-1);
    expect(coordCloseIndex).toBeGreaterThan(coordFetchIndex);
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
