/**
 * Unit tests for the theme-equipment judge-speedup constants and the
 * `enableJudge` default they drive.
 *
 * `enableJudge` mirrors the generator's treatment of every theme-equipment
 * brief. The speedup is scoped to the variant-approval *rejudge*, so the
 * omitted-cap generation default stays 16, while the rejudge path uses the
 * lower `THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS` (6). An explicit (possibly
 * stricter) cap the maintainer typed must be preserved verbatim.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  enableJudge,
  THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS,
  THEME_EQUIPMENT_JUDGE_CONCURRENCY,
  THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS,
} from '../../../scripts/sprites/theme-equipment-brief.js';

function judgeOf(yaml: string): Record<string, unknown> {
  return (parseYaml(yaml) as Record<string, unknown>)['judge'] as Record<string, unknown>;
}

describe('theme-equipment judge-speedup constants', () => {
  it('keeps the generation default at 16 and scopes the speedup to rejudge (6) + concurrency 4', () => {
    // Generation is intentionally unaffected: the speedup is rejudge-only.
    expect(THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS).toBe(16);
    expect(THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS).toBe(6);
    expect(THEME_EQUIPMENT_JUDGE_CONCURRENCY).toBe(4);
    // The rejudge cap must be a genuine reduction from the generation default.
    expect(THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS).toBeLessThan(
      THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS,
    );
  });
});

describe('enableJudge', () => {
  it('defaults an omitted judge.maxVariants to the generation default (16)', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\n'));
    expect(judge['enabled']).toBe(true);
    expect(judge['maxVariants']).toBe(THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS);
    expect(judge['maxVariants']).toBe(16);
  });

  it('preserves an explicit (stricter) judge.maxVariants', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  maxVariants: 4\n'));
    expect(judge['enabled']).toBe(true);
    expect(judge['maxVariants']).toBe(4);
  });

  it('preserves an explicit higher judge.maxVariants (does not clamp)', () => {
    // enableJudge only fills the generation DEFAULT; the runtime cap-down to 6
    // happens on the rejudge path via judgeMaxVariants, not here.
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  maxVariants: 12\n'));
    expect(judge['maxVariants']).toBe(12);
  });

  it('forces judge.enabled = true even when the brief disabled it', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  enabled: false\n'));
    expect(judge['enabled']).toBe(true);
  });
});
