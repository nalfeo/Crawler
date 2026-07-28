/**
 * Unit tests for the theme-equipment judge-speedup constants and the
 * `enableJudge` default they drive.
 *
 * `enableJudge` mirrors the generator's treatment of every theme-equipment
 * brief. The speedup lowered the omitted-cap default 16 → 6, so an edited brief
 * that never mentions `judge.maxVariants` must now bake in 6 — while an explicit
 * (possibly stricter) cap the maintainer typed must be preserved verbatim.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  enableJudge,
  THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS,
  THEME_EQUIPMENT_JUDGE_CONCURRENCY,
} from '../../../scripts/sprites/theme-equipment-brief.js';

function judgeOf(yaml: string): Record<string, unknown> {
  return (parseYaml(yaml) as Record<string, unknown>)['judge'] as Record<string, unknown>;
}

describe('theme-equipment judge-speedup constants', () => {
  it('caps default judged variants at 6 and rejudge concurrency at 4', () => {
    expect(THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS).toBe(6);
    expect(THEME_EQUIPMENT_JUDGE_CONCURRENCY).toBe(4);
  });
});

describe('enableJudge', () => {
  it('defaults an omitted judge.maxVariants to 6', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\n'));
    expect(judge['enabled']).toBe(true);
    expect(judge['maxVariants']).toBe(THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS);
    expect(judge['maxVariants']).toBe(6);
  });

  it('preserves an explicit (stricter) judge.maxVariants', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  maxVariants: 4\n'));
    expect(judge['enabled']).toBe(true);
    expect(judge['maxVariants']).toBe(4);
  });

  it('preserves an explicit higher judge.maxVariants (does not clamp)', () => {
    // enableJudge only fills the DEFAULT; the runtime cap-down to 6 happens on
    // the rejudge path via judgeMaxVariants, not here.
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  maxVariants: 12\n'));
    expect(judge['maxVariants']).toBe(12);
  });

  it('forces judge.enabled = true even when the brief disabled it', () => {
    const judge = judgeOf(enableJudge('name: iron-sword\njudge:\n  enabled: false\n'));
    expect(judge['enabled']).toBe(true);
  });
});
