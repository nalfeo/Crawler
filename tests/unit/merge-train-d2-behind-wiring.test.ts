import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RECONCILE_PATH = path.join(REPO_ROOT, '.github/scripts/merge-train/reconcile.mjs');
const RECONCILE_LIB_PATH = path.join(REPO_ROOT, '.github/scripts/merge-train/reconcile-lib.mjs');

describe('merge-train D2 fix: auto-update clean-BEHIND admitted PRs', () => {
  it('fetches authoritative per-PR state BEFORE eligible() to share one snapshot', () => {
    const raw = readFileSync(RECONCILE_PATH, 'utf8');
    // D2: fetch the per-PR endpoint (not just list payload) to get reliable mergeable_state.
    // The livePr fetch must appear BEFORE the eligible() call so both the BEHIND check and
    // the conflict-detection inside eligible() use the same authoritative snapshot, not the
    // stale list-pulls payload.
    expect(raw).toContain('livePr.mergeable_state');
    expect(raw).toContain('livePr.head.sha');
    // D2: call update-branch via updateBranchToken (CRAWLER_CI_PAT || GITHUB_TOKEN)
    // to ensure required CI is triggered after the branch update.
    expect(raw).toContain('updateBranchToken');
    expect(raw).toContain('/update-branch');
    expect(raw).toContain('expected_head_sha');
    expect(raw).toContain('reason=clean-behind');
  });

  it('fetches livePr before eligible() so stale list payload cannot cause wrong admission', () => {
    const raw = readFileSync(RECONCILE_PATH, 'utf8');
    // Behavior: the per-PR fetch must precede the eligible() call in source order.
    // If the list payload has stale BEHIND/DIRTY state, the authoritative livePr
    // is used for both checks — eligible() receives livePr, not the list item.
    const livePrFetchIdx = raw.indexOf(
      '(await request(token, `/repos/${owner}/${repo}/pulls/${pr.number}`)).data',
    );
    const eligibleCallIdx = raw.indexOf('await eligible(livePr)');
    expect(livePrFetchIdx).toBeGreaterThan(-1);
    expect(eligibleCallIdx).toBeGreaterThan(-1);
    // livePr fetch comes before eligible() call
    expect(livePrFetchIdx).toBeLessThan(eligibleCallIdx);
  });

  it('updateBranchToken in reconcile-lib uses CRAWLER_CI_PAT over GITHUB_TOKEN', () => {
    const lib = readFileSync(RECONCILE_LIB_PATH, 'utf8');
    // updateBranchToken must prefer CRAWLER_CI_PAT so push-triggered CI reruns are
    // not blocked by GITHUB_TOKEN recursion suppression.
    expect(lib).toContain('updateBranchToken');
    expect(lib).toContain('CRAWLER_CI_PAT');
    // CRAWLER_CI_PAT must appear before GITHUB_TOKEN in the updateBranchToken expression
    const updateBranchTokenIdx = lib.indexOf('updateBranchToken =');
    const patIdx = lib.indexOf('CRAWLER_CI_PAT', updateBranchTokenIdx);
    const ghTokenIdx = lib.indexOf('GITHUB_TOKEN', patIdx);
    expect(patIdx).toBeGreaterThan(updateBranchTokenIdx);
    expect(ghTokenIdx).toBeGreaterThan(patIdx);
  });

  it('dequeues 403 errors and never re-throws (prevents queue deadlock)', () => {
    const raw = readFileSync(RECONCILE_PATH, 'utf8');
    // Extract the update-branch try/catch block.
    // The template-literal URL uses backtick quotes: `/repos/.../update-branch`
    const updateBranchTryStart = raw.indexOf('/update-branch`');
    expect(updateBranchTryStart).toBeGreaterThan(-1);
    const catchStart = raw.indexOf('catch (err)', updateBranchTryStart);
    expect(catchStart).toBeGreaterThan(-1);
    // The catch block ends at the closing brace before "// Stop admitting"
    const catchEnd = raw.indexOf('// Stop admitting', catchStart);
    expect(catchEnd).toBeGreaterThan(-1);
    const catchBlock = raw.slice(catchStart, catchEnd);
    // 403 must be dequeued (removeLabel) so it does not poison every reconcile cycle
    expect(catchBlock).toContain('err.status === 403');
    expect(catchBlock).toContain('removeLabel');
    expect(catchBlock).toContain('yieldFifoLine = true');
    // 422 ("already up-to-date" / stale expected_head_sha) is expected and benign.
    expect(catchBlock).toContain('err.status === 422');
    expect(catchBlock).toContain('non-fatal:');
    // Novel statuses (404, 5xx, network) must stay VISIBLE via a distinct,
    // greppable stderr marker...
    expect(catchBlock).toContain('unexpected-status:');
    // ...but must NEVER re-throw. This catch is inside the
    // `for (const pr of queued)` admission loop, so an escaping throw abandons
    // every remaining queued PR — the shape that deadlocked the train for
    // ~90 minutes on 2026-07-29. Visibility comes from the log marker, not
    // from crashing the reconciler. Also enforced statically by the
    // `crawler/no-rethrow-in-automation-catch` ESLint rule, which is the
    // durable guard; this assertion pins the specific call site.
    expect(catchBlock).not.toContain('throw err');
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
