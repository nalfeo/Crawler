import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECONCILE_PATH = path.join(REPO_ROOT, '.github/scripts/merge-train/reconcile.mjs');

describe('merge-train D2 fix: auto-update clean-BEHIND admitted PRs', () => {
  it('fetches authoritative per-PR state to read mergeable_state before update-branch', () => {
    const raw = readFileSync(RECONCILE_PATH, 'utf8');
    // D2: fetch the per-PR endpoint (not just list payload) to get reliable mergeable_state
    expect(raw).toContain('livePr.mergeable_state');
    expect(raw).toContain('livePr.head.sha');
    // D2: call update-branch via workflowDispatchToken (GITHUB_TOKEN, not App token)
    // to avoid D7 action_required parking trap
    expect(raw).toContain('workflowDispatchToken');
    expect(raw).toContain('/update-branch');
    expect(raw).toContain('expected_head_oid');
    expect(raw).toContain('reason=clean-behind');
  });

  it('uses break to halt admission after a BEHIND PR to preserve queue ordering', () => {
    const raw = readFileSync(RECONCILE_PATH, 'utf8');
    // Extract the admission loop body and verify break appears after update-branch
    // and before the disableAutoMerge/admitted.push path.
    const behindBlock = raw.slice(
      raw.indexOf("livePr.mergeable_state === 'behind'"),
      raw.indexOf('// Fence the legacy auto-merge path before this PR'),
    );
    expect(behindBlock).toContain('break;');
    expect(behindBlock).not.toContain('continue;');
  });
});
