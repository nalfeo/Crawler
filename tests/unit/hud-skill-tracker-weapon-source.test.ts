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

  it('calls setAllVisible(false) when no active weapon is equipped', () => {
    const source = readFileSync('src/engine/HudSkillTracker.ts', 'utf8');

    // The guard must be: if (!def) { setAllVisible(false); return; }
    // This ensures removing the false-branch would break this test.
    expect(source).toMatch(/if\s*\(!def\)\s*\{[\s\S]*?setAllVisible\(false\)/);
  });

  it('renders spell-skill rows for the player equipped spells, using the shared thresholds', () => {
    const source = readFileSync('src/engine/HudSkillTracker.ts', 'utf8');

    expect(source).toMatch(
      /import\s+\{\s*countMatchingSpellSkills,\s*selectSpellSkillRows\s*\}\s+from\s+'\.\/hud-spell-skill-rows\.js'/,
    );
    expect(source).toMatch(
      /import\s+\{\s*SPELL_SKILL_THRESHOLDS\s*\}\s+from\s+'\.\.\/shared\/spell-skills\.js'/,
    );
    expect(source).toMatch(/selectSpellSkillRows\(equippedActiveAbilityIds, spellRows\.length\)/);
    expect(source).toMatch(/SPELL_SKILL_THRESHOLDS/);
  });

  it('shows a "+N" overflow indicator instead of silently dropping equipped spell skills', () => {
    const source = readFileSync('src/engine/HudSkillTracker.ts', 'utf8');

    expect(source).toMatch(/countMatchingSpellSkills\(equippedActiveAbilityIds\)/);
    expect(source).toMatch(
      /overflowText\.setText\(overflowCount > 0 \? `\+\$\{overflowCount\}` : ''\)/,
    );
  });
});
