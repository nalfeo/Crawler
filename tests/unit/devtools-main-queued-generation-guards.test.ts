import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('devtools queued generation guards', () => {
  it('guards queue and polling edge cases in devtools main workflow', () => {
    const source = readFileSync('src/devtools-main.ts', 'utf-8');

    expect(source).toContain('const alreadyQueuedNow = queueState.items.some(');
    expect(source).toContain('queueBtn.disabled = true;');
    expect(source).toContain('if (!Number.isFinite(Date.parse(item.generationRequestedAt))) {');
    expect(source).toContain('Queued-run poll failed (will retry)');
    expect(source).toContain("if (selectedAfterGenerate?.stage === 'generating')");
  });

  it('deletes only the selected run and never the whole store', () => {
    const source = readFileSync('src/devtools-main.ts', 'utf-8');

    // The delete button must resolve the run selected in the reload dropdown
    // and delete just that one via the single-run helper...
    expect(source).toContain('deleteSidecarRun(run.briefId, run.runId)');
    // ...refusing to act when nothing is selected...
    expect(source).toContain('Pick a run to delete first.');
    // ...and gating on the shared in-flight flag so it can't race Load/refresh.
    expect(source).toContain('azureLoadInFlight = true;');

    // Regression guard: the old button wiped the entire shared Azure container.
    // No caller of the destructive clear-all endpoint may return.
    expect(source).not.toContain('workflow/store/clear');
    expect(source).not.toContain("scope: 'all'");
  });

  it('pins the approve target before the durable queue-commit await so a mid-approval reselect cannot patch the wrong item', () => {
    const source = readFileSync('src/devtools-main.ts', 'utf-8');

    // FIX 7: postApprove now includes a seconds-long durable queue-commit git
    // push, during which queue-chip selection is NOT locked. The item being
    // approved must be captured BEFORE the await; patching a post-await
    // getSelectedItem() would corrupt whichever item the operator reselected
    // (and attach this asset's durability warning to it).
    const captureIdx = source.indexOf('const approveTarget = getSelectedItem(queueState);');
    const awaitIdx = source.indexOf('await postApprove(');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(-1);
    // The capture must precede the slow await.
    expect(captureIdx).toBeLessThan(awaitIdx);

    // Both the success branch and the 409 already-approved branch patch the
    // pinned target, not a freshly-read selection.
    const patchCount =
      source.split('queueState = queueUpdateItem(queueState, approveTarget.id, patch);').length - 1;
    expect(patchCount).toBe(2);

    // Regression guard scoped to the approve handler body (capture → finally):
    // getSelectedItem must be called exactly ONCE — the pre-await capture — so a
    // racy post-await re-read of the current selection cannot creep back in.
    // Other synchronous handlers legitimately read getSelectedItem(queueState),
    // so this must not be a whole-file assertion.
    const handlerEnd = source.indexOf(
      "setButtonBusy(triggerBtn, false, busyLabel, 'Approving...');",
      captureIdx,
    );
    expect(handlerEnd).toBeGreaterThan(captureIdx);
    const approveBody = source.slice(captureIdx, handlerEnd);
    const selectionReads = approveBody.split('getSelectedItem(queueState)').length - 1;
    expect(selectionReads).toBe(1);
  });
});
