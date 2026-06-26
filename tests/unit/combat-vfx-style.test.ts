import { describe, expect, it } from 'vitest';
import type { CombatEvent } from '../../src/shared/combat-events.js';
import { combatFloaterStyle } from '../../src/engine/CombatVfx.js';

function hit(overrides: Partial<CombatEvent> = {}): CombatEvent {
  return {
    type: 'hit',
    x: 0,
    y: 0,
    amount: 10,
    targetType: 'enemy',
    timestamp: 0,
    ...overrides,
  };
}

describe('combatFloaterStyle', () => {
  it('rounds f32 damage artifacts to a whole number', () => {
    // 8 stored in an f32 ECS store reads back as 8.00000011920929.
    const style = combatFloaterStyle(hit({ amount: 8.00000011920929 }));
    expect(style.label).toBe('-8');
  });

  it('rounds fractional damage to the nearest whole number', () => {
    expect(combatFloaterStyle(hit({ amount: 22.4 })).label).toBe('-22');
    expect(combatFloaterStyle(hit({ amount: 22.5 })).label).toBe('-23');
    expect(combatFloaterStyle(hit({ amount: 7.9999999 })).label).toBe('-8');
  });

  it('rounds player-target damage and uses the player colour', () => {
    const style = combatFloaterStyle(hit({ targetType: 'player', amount: 5.00000007 }));
    expect(style.label).toBe('-5');
    expect(style.color).toBe('#ff4444');
  });

  it('rounds critical hits and keeps the emphasized "!" + larger font', () => {
    const style = combatFloaterStyle(hit({ amount: 14.0000002, isCrit: true }));
    expect(style.label).toBe('-14!');
    expect(style.color).toBe('#ff8800');
    expect(style.fontSize).toBe('16px');
  });

  it('rounds death-event amounts (maxHp from an f32 store)', () => {
    const style = combatFloaterStyle(hit({ type: 'death', amount: 30.000001 }));
    expect(style.label).toBe('-30');
  });

  it('leaves non-numeric indicators untouched', () => {
    expect(combatFloaterStyle(hit({ type: 'miss', amount: 0 })).label).toBe('MISS');
    expect(combatFloaterStyle(hit({ type: 'dodge', amount: 0 })).label).toBe('DODGE');
    expect(combatFloaterStyle(hit({ type: 'blocked', amount: 0 })).label).toBe('BLOCKED');
  });
});
