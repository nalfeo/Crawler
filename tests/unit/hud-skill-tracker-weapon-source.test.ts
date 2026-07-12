import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HudSkillTracker weapon source', () => {
  it('uses only core active-weapon state and does not fall back to floorScenario.selectedWeaponId', () => {
    const source = readFileSync('src/engine/HudSkillTracker.ts', 'utf8');

    expect(source).toMatch(
      /import\s+\{\s*getActiveWeaponDef\s*\}\s+from\s+'\.\.\/core\/active-weapon\.js'/,
    );
    expect(source).toMatch(/const def = getActiveWeaponDef\(world\);/);
    expect(source).not.toMatch(/floorScenario\?\.selectedWeaponId/);
    expect(source).not.toMatch(/getWeaponDef\(/);
  });
});
