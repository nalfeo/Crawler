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
});
