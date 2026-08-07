import { describe, expect, it } from 'vitest';
import { extractSummary } from '../../../scripts/agent/docs/build-system-index';

describe('extractSummary', () => {
  it('returns a single-line What Was Done paragraph', () => {
    const md = `# Session Handoff\n\n## What Was Done\n\nFixed the bug.\n\n## Systems touched\n\nci\n`;
    expect(extractSummary(md, 'fallback')).toBe('Fixed the bug.');
  });

  it('joins soft-wrapped continuation lines in What Was Done', () => {
    const md = [
      '# Session Handoff',
      '',
      '## What Was Done',
      '',
      'The hourly `sprite-queue-reconciler` opened an art-only promotion PR **every',
      'cycle** (#2696…#2770, ~150 paths each) although no asset had been approved.',
      '',
      '## Systems touched',
      '',
      'sprite-pipeline',
    ].join('\n');
    const result = extractSummary(md, 'fallback');
    expect(result).toContain('every cycle**');
    expect(result).not.toMatch(/\*\*every\s*$/);
  });

  it('stops joining at a blank line (paragraph boundary)', () => {
    const md = [
      '## What Was Done',
      '',
      'First paragraph line one',
      'first paragraph line two',
      '',
      'Second paragraph',
    ].join('\n');
    const result = extractSummary(md, 'fallback');
    expect(result).toBe('First paragraph line one first paragraph line two');
  });

  it('stops joining at a new heading', () => {
    const md = ['## What Was Done', '', 'Line one', 'line two', '## Next Section'].join('\n');
    const result = extractSummary(md, 'fallback');
    expect(result).toBe('Line one line two');
  });

  it('falls back to H1 title when no What Was Done section exists', () => {
    const md = '# Session Handoff: My Cool Session\n\nSome text.\n';
    expect(extractSummary(md, 'fallback')).toBe('My Cool Session');
  });

  it('returns fallback when no section and no H1 exists', () => {
    expect(extractSummary('just some text', 'my-slug')).toBe('my-slug');
  });

  it('truncates summaries longer than 140 characters', () => {
    const longLine = 'A'.repeat(200);
    const md = `## What Was Done\n\n${longLine}\n`;
    const result = extractSummary(md, 'fallback');
    expect(result.length).toBeLessThanOrEqual(141); // 140 + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });
});
