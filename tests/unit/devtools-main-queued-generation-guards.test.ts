import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('devtools queued generation guards', () => {
  it('guards queue and polling edge cases in devtools main workflow', () => {
    const source = readFileSync('src/devtools-main.ts', 'utf-8');

    expect(source).toContain('const alreadyQueuedNow = queueState.items.some(');
    expect(source).toContain('queueBtn.disabled = true;');
    expect(source).toContain('if (!Number.isFinite(requestedAt)) {');
    expect(source).toContain('Queued-run poll failed (will retry)');
    expect(source).toContain("if (selectedAfterGenerate?.stage === 'generating')");
  });
});
