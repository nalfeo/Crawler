import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('HudUI mobile layout guards', () => {
  it('uses a lower scale cap for the bottom-center ability bar group', () => {
    const source = readFileSync('src/engine/HudUI.ts', 'utf-8');

    expect(source).toContain('const HUD_MAX_SCALE = 1.6;');
    expect(source).toContain('const ABILITY_BAR_MAX_SCALE = 1.2;');
    expect(source).toContain('const bottomCenterScale = Math.min(s, ABILITY_BAR_MAX_SCALE);');
    expect(source).toContain('.setScale(bottomCenterScale)');
    expect(source).toContain('h * (1 - bottomCenterScale)');
  });
});
