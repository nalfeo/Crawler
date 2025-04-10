import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/agent/review/visual-review-agent.js';

describe('visual-review-agent viewport parsing', () => {
  it.each([
    ['1280x720', { width: 1280, height: 720 }],
    ['1920X1080', { width: 1920, height: 1080 }],
  ])('parses --viewport %s', (value, expected) => {
    expect(parseArgs(['--viewport', value]).viewport).toEqual(expected);
  });

  it.each(['1280', '1280*720', '1280x', 'x720', '0x720', '-1x720', '1280.5x720'])(
    'rejects malformed --viewport value %s',
    (value) => {
      expect(() => parseArgs(['--viewport', value])).toThrow(
        /invalid --viewport .*expected positive integer WIDTHxHEIGHT/,
      );
    },
  );

  it('rejects a missing --viewport value', () => {
    expect(() => parseArgs(['--viewport'])).toThrow(
      /invalid --viewport .*expected positive integer WIDTHxHEIGHT/,
    );
  });

  it('preserves the existing viewport when --viewport is omitted', () => {
    expect(parseArgs([]).viewport).toEqual({ width: 1600, height: 1000 });
  });

  it('updates the effective viewport when width/height flags are provided separately', () => {
    expect(parseArgs(['--viewport-width', '1280', '--viewport-height', '720']).viewport).toEqual({
      width: 1280,
      height: 720,
    });
  });
});
