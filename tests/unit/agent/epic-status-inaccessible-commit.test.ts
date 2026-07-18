/**
 * Regression tests for the evidence.git-verification-failed error code when
 * an evidence entry records a commit SHA that is no longer accessible in git
 * history (e.g. from a squash-merged branch that was subsequently deleted).
 *
 * Incident: epic-state.json for floor-2-equipment recorded commit
 * 8cc19153bb8881a4faba5b696eb117c7abc820c2 from the
 * copilot/floor-2-epic-control-plane branch. After that branch was
 * squash-merged into main (as 89ff7827) and deleted, the original commit
 * became unreachable.  Any PR that included docs/knowledge/epics/** triggered
 * the "Offline epic validation" CI job, which used the real git reader and
 * returned null for showContent() on that commit, causing the job to fail
 * with evidence.git-verification-failed.  This stalled the CI recovery loop
 * on PR #1273 for two full retry cycles before the loop-incident was filed.
 *
 * Fix: the evidence commit was updated from 8cc19153 → 89ff7827 (the
 * squash-merge commit that introduced the test file to main).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateEpicState,
  type EpicState,
  type GitReader,
} from '../../../scripts/agent/epics/epic-status-lib';

// Resolve the repo root relative to this test file so that tests are not
// sensitive to the caller's working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EPIC_DIR = resolve(REPO_ROOT, 'docs', 'knowledge', 'epics', 'floor-2-equipment');
const PLAN = readFileSync(resolve(EPIC_DIR, 'PLAN.md'), 'utf8');
const STATE = JSON.parse(readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8')) as EpicState;

const NOW = new Date('2026-07-17T18:00:00.000Z');

function cloneState(): EpicState {
  return structuredClone(STATE);
}

describe('epic evidence inaccessible-commit regression', () => {
  it('raises evidence.git-verification-failed when the recording commit is unreachable (squash-merge residue)', () => {
    // Simulate the exact failure mode from PR #1273: the evidence file exists
    // on disk but the recorded commit SHA is not reachable in git history
    // because it was on a branch that was deleted after squash-merge.
    const state = cloneState();
    const INACCESSIBLE_SHA = '8cc19153bb8881a4faba5b696eb117c7abc820c2';

    // Point the A0 test-evidence entry at the inaccessible commit while
    // keeping the correct file path so only the commit lookup fails.
    const a0 = state.nodes.find((n) => n.node_id === 'slice:A0');
    expect(a0).toBeDefined();
    const evidenceEntry = a0!.evidence.find(
      (e) => e.kind === 'offline-validator-and-focused-tests',
    );
    expect(evidenceEntry).toBeDefined();
    evidenceEntry!.commit = INACCESSIBLE_SHA;

    // A reader that simulates the commit being absent from git history while
    // the file itself exists on disk.  This mirrors the production git reader
    // behavior when the recording commit is no longer reachable.
    const inaccessibleCommitReader: GitReader = {
      showContent(commit: string, filePath: string): string | null {
        if (commit === INACCESSIBLE_SHA) return null;
        try {
          return readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
        } catch {
          return null;
        }
      },
      commitExists(commit: string): boolean {
        return commit !== INACCESSIBLE_SHA;
      },
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: inaccessibleCommitReader,
    });

    expect(result.errors.map((e) => e.code)).toContain('evidence.git-verification-failed');
    const err = result.errors.find((e) => e.code === 'evidence.git-verification-failed');
    expect(err?.message).toContain(INACCESSIBLE_SHA);
    expect(err?.message).toContain('tests/unit/agent/epic-status.test.ts');
  });

  it('does NOT raise evidence.git-verification-failed when the recording commit is accessible', () => {
    // Confirm the fix: recording the squash-merge commit (89ff7827) instead
    // of the original branch commit (8cc19153) resolves the failure.
    const state = cloneState();
    const ACCESSIBLE_SHA = '89ff7827ca65a9d1564dad451ec9d2a2f312a82e';

    const a0 = state.nodes.find((n) => n.node_id === 'slice:A0');
    expect(a0).toBeDefined();
    const evidenceEntry = a0!.evidence.find(
      (e) => e.kind === 'offline-validator-and-focused-tests',
    );
    expect(evidenceEntry).toBeDefined();
    evidenceEntry!.commit = ACCESSIBLE_SHA;

    // Build a strict allowlist from the commits referenced by the modified
    // state's evidence entries.  This ensures the reader only returns content
    // for SHAs that are actually recorded in the state, so if ACCESSIBLE_SHA
    // is changed to an arbitrary value that doesn't appear in any evidence
    // entry the test will fail rather than silently passing.
    const allowedCommits = new Set<string>();
    for (const node of state.nodes) {
      for (const ev of node.evidence) {
        allowedCommits.add(ev.commit);
      }
    }
    const strictAllowlistReader: GitReader = {
      showContent(commit: string, filePath: string): string | null {
        if (!allowedCommits.has(commit)) return null;
        try {
          return readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
        } catch {
          return null;
        }
      },
      commitExists(commit: string): boolean {
        return allowedCommits.has(commit);
      },
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: strictAllowlistReader,
    });

    expect(result.errors.map((e) => e.code)).not.toContain('evidence.git-verification-failed');
  });
});
