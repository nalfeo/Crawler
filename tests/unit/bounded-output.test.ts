import { describe, expect, it } from 'vitest';

import { boundOutput, formatCommandOutput, parseArgs } from '../../scripts/agent/bounded-output';

describe('agent bounded output', () => {
  it('leaves normal output intact and reports success', () => {
    expect(formatCommandOutput('ready\n', '', 0, { maxChars: 80, maxLines: 8 })).toBe(
      'ready\nExit status: 0',
    );
  });

  it('caps noisy output with an unambiguous marker while retaining both ends', () => {
    const value = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n');
    const result = boundOutput(value, { maxChars: 90, maxLines: 5 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('line-0');
    expect(result.text).toContain('line-9');
    expect(result.text).toContain('[agent-output truncated]');
    expect(result.text.split('\n')).toHaveLength(5);
    expect(result.text.length).toBeLessThanOrEqual(90);
  });

  it('keeps stderr tail and the failing exit status actionable', () => {
    const output = formatCommandOutput('progress\n', `error-${'x'.repeat(100)}`, 7, {
      maxChars: 90,
      maxLines: 5,
    });
    expect(output).toContain('Exit status: 7');
    expect(output).toContain('xxxxxxxxxx');
    expect(output.length).toBeLessThanOrEqual(90);
    expect(output.split('\n').length).toBeLessThanOrEqual(5);
  });

  it('accepts explicit bounded expansion and rejects unbounded values', () => {
    expect(
      parseArgs(['--max-chars', '12000', '--max-lines', '400', '--', 'node', '-v']).limits,
    ).toEqual({
      maxChars: 12000,
      maxLines: 400,
    });
    expect(() => parseArgs(['--max-chars', '64001', '--', 'node'])).toThrow('64 to 64000');
  });
});
