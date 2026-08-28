import { describe, expect, it } from 'vitest';
import {
  buildEvaluationImages,
  buildPrompt,
  parseArgs,
} from '../../scripts/agent/review/visual-review-agent.js';

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

describe('visual-review-agent deterministic-only flag', () => {
  it('defaults to false (LLM review runs)', () => {
    expect(parseArgs([]).deterministicOnly).toBe(false);
  });

  it('parses --deterministic-only', () => {
    expect(parseArgs(['--deterministic-only']).deterministicOnly).toBe(true);
  });
});

describe('visual-review-agent focused interaction prompt', () => {
  it('distinguishes the detail frame from full-panel measured context', () => {
    const opts = parseArgs([]);
    const prompt = buildPrompt(opts, 'equipment-panel x=0 y=0 w=1280 h=720', {
      expect: {
        tooltipAfterHover: true,
        statLabelsHumanReadable: false,
        sectionDividers: false,
      },
      regionIds: ['equipment-panel', 'hover-target:bag:leather-boots', 'tooltip'],
      focusedHover: true,
    });

    expect(prompt.user).toContain('DETAIL FOCUS FRAME');
    expect(prompt.user).toContain('FULL-PANEL PLACEMENT CONTEXT');
    expect(prompt.user).toContain('Two images are attached in this exact labeled order');
    expect(prompt.user).toContain('task_readiness');
    expect(prompt.user).toContain('non_occlusion');
    expect(prompt.user).toContain('Generic "cramped" / "needs padding" phrasing is advisory');
    expect(prompt.system).toContain('Scenario-specific measured contracts are authoritative');
  });

  it('sends labeled full-panel context before the detail focus image', () => {
    const detail = Buffer.from('detail');
    const context = Buffer.from('context');

    const images = buildEvaluationImages('equipment hover', detail, true, context);

    expect(images).toEqual([
      { label: 'equipment hover — FULL-PANEL PLACEMENT CONTEXT', png: context },
      { label: 'equipment hover — DETAIL FOCUS FRAME', png: detail },
    ]);
  });

  it('fails closed when a focused capture has no full-panel context image', () => {
    expect(() =>
      buildEvaluationImages('equipment hover', Buffer.from('detail'), true, null),
    ).toThrow(/requires a full-panel context image/);
  });

  it('keeps non-focused reviews on the existing single-image path', () => {
    const screenshot = Buffer.from('full');
    expect(buildEvaluationImages('equipment', screenshot, false, null)).toEqual([
      { label: 'equipment', png: screenshot },
    ]);
  });
});
