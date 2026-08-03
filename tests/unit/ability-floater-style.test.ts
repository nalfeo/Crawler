import { describe, expect, it } from 'vitest';
import type { AbilityActivationEvent } from '../../src/shared/ability-activation-events.js';
import { abilityFloaterStyle } from '../../src/engine/CombatVfx.js';

function activation(overrides: Partial<AbilityActivationEvent> = {}): AbilityActivationEvent {
  return {
    abilityId: 'battle-focus',
    label: 'Battle Focus',
    kind: 'active',
    category: 'combat',
    holderEid: 1,
    x: 0,
    y: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe('abilityFloaterStyle', () => {
  it('renders the ability name upper-cased', () => {
    expect(abilityFloaterStyle(activation()).label).toBe('BATTLE FOCUS');
  });

  it('colours by category for non-spell actives', () => {
    const combat = abilityFloaterStyle(activation({ category: 'combat' })).color;
    const defense = abilityFloaterStyle(activation({ category: 'defense' })).color;
    const utility = abilityFloaterStyle(activation({ category: 'utility' })).color;
    expect(new Set([combat, defense, utility]).size).toBe(3);
  });

  it('uses the arcane spell colour regardless of category', () => {
    const spellCombat = abilityFloaterStyle(
      activation({ kind: 'spell', category: 'combat' }),
    ).color;
    const spellUtility = abilityFloaterStyle(
      activation({ kind: 'spell', category: 'utility' }),
    ).color;
    expect(spellCombat).toBe(spellUtility);
    expect(spellCombat).not.toBe(abilityFloaterStyle(activation({ category: 'combat' })).color);
  });

  it('is larger than the standard damage-number font so the name reads clearly', () => {
    expect(abilityFloaterStyle(activation()).fontSize).toBe('14px');
  });
});
