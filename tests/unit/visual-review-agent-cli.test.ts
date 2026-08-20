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

  it('preserves probe readiness by default and allows an explicit opt-out', () => {
    expect(parseArgs(['--setup-file', 'setup.js']).skipProbeWait).toBe(false);
    expect(parseArgs(['--setup-file', 'setup.js', '--no-probe-wait']).skipProbeWait).toBe(true);
  });
});

describe('visual-review-agent lineage capture flags', () => {
  it('defaults to no lineage tracking (speculative/exploratory capture)', () => {
    const opts = parseArgs([]);
    expect(opts.lineageScenario).toBeNull();
    expect(opts.lineageState).toBeNull();
    expect(opts.lineageSide).toBe('after');
  });

  it('parses an explicit A|B iteration capture', () => {
    const opts = parseArgs([
      '--lineage-scenario',
      'equipment',
      '--lineage-state',
      'v3',
      '--lineage-side',
      'before',
    ]);
    expect(opts.lineageScenario).toBe('equipment');
    expect(opts.lineageState).toBe('v3');
    expect(opts.lineageSide).toBe('before');
  });

  it('defaults --lineage-side to "after" when omitted', () => {
    expect(
      parseArgs(['--lineage-scenario', 'equipment', '--lineage-state', 'main']).lineageSide,
    ).toBe('after');
  });

  it('sanitizes scenario/state to filesystem-safe slugs', () => {
    const opts = parseArgs(['--lineage-scenario', 'equipment panel!', '--lineage-state', 'v/../1']);
    expect(opts.lineageScenario).toBe('equipment-panel-');
    expect(opts.lineageState).toBe('v-1');
  });

  it('rejects an unknown --lineage-side value', () => {
    expect(() =>
      parseArgs([
        '--lineage-scenario',
        'equipment',
        '--lineage-state',
        'v1',
        '--lineage-side',
        'sideways',
      ]),
    ).toThrow(/invalid --lineage-side/);
  });

  it('requires --lineage-state whenever --lineage-scenario is set', () => {
    expect(() => parseArgs(['--lineage-scenario', 'equipment'])).toThrow(
      /--lineage-scenario requires --lineage-state/,
    );
  });
});
