import { describe, expect, it } from 'vitest';
import {
  cueForAbilityActivation,
  cueForCombatEvent,
  cueForVfxEvent,
} from '../../src/shared/combat-audio-cues.js';
import type { CombatEvent } from '../../src/shared/combat-events.js';
import type { VfxEvent } from '../../src/shared/vfx-events.js';
import type { AbilityActivationEvent } from '../../src/shared/ability-activation-events.js';

function combatEvent(overrides: Partial<CombatEvent>): CombatEvent {
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

function abilityEvent(overrides: Partial<AbilityActivationEvent> = {}): AbilityActivationEvent {
  return {
    abilityId: 'fireball',
    label: 'Fireball',
    kind: 'spell',
    category: 'combat',
    holderEid: 1,
    x: 0,
    y: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe('cueForCombatEvent', () => {
  it('maps a non-crit enemy hit to weaponHit', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'hit', targetType: 'enemy', isCrit: false }));
    expect(cue?.kind).toBe('weaponHit');
  });

  it('maps a crit enemy hit to weaponCrit', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'hit', targetType: 'enemy', isCrit: true }));
    expect(cue?.kind).toBe('weaponCrit');
  });

  it('maps a player hit to damageTaken', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'hit', targetType: 'player', amount: 20 }));
    expect(cue?.kind).toBe('damageTaken');
  });

  it('maps an enemy death to enemyDeath', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'death', targetType: 'enemy' }));
    expect(cue?.kind).toBe('enemyDeath');
  });

  it('ignores a player death (out of scope)', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'death', targetType: 'player' }));
    expect(cue).toBeNull();
  });

  it('maps a player block to blocked', () => {
    const cue = cueForCombatEvent(
      combatEvent({ type: 'blocked', targetType: 'player', amount: 0 }),
    );
    expect(cue?.kind).toBe('blocked');
  });

  it('maps a player dodge to dodge', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'dodge', targetType: 'player', amount: 0 }));
    expect(cue?.kind).toBe('dodge');
  });

  it('maps a weapon miss (targeting an enemy) to weaponMiss', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'miss', targetType: 'enemy', amount: 0 }));
    expect(cue?.kind).toBe('weaponMiss');
  });

  it('ignores corpseExplode (covered by gore VFX, out of scope)', () => {
    const cue = cueForCombatEvent(combatEvent({ type: 'corpseExplode', targetType: 'enemy' }));
    expect(cue).toBeNull();
  });

  it('damage-derived intensity is monotonic non-decreasing in amount and never silent', () => {
    const zero = cueForCombatEvent(combatEvent({ amount: 0 }));
    const low = cueForCombatEvent(combatEvent({ amount: 10 }));
    const high = cueForCombatEvent(combatEvent({ amount: 40 }));
    const huge = cueForCombatEvent(combatEvent({ amount: 1000 }));
    expect(zero!.intensity).toBeGreaterThan(0);
    expect(low!.intensity).toBeGreaterThanOrEqual(zero!.intensity);
    expect(high!.intensity).toBeGreaterThanOrEqual(low!.intensity);
    expect(huge!.intensity).toBeLessThanOrEqual(1);
  });
});

describe('cueForVfxEvent', () => {
  function vfxEvent(kind: VfxEvent['kind'], color?: number): VfxEvent {
    return { kind, x: 0, y: 0, color };
  }

  it('maps pickupSparkle to a generic pickup cue', () => {
    const cue = cueForVfxEvent(vfxEvent('pickupSparkle'));
    expect(cue?.kind).toBe('pickup');
  });

  it('produces the same pickup cue regardless of tint (no color-based type inference)', () => {
    const gold = cueForVfxEvent(vfxEvent('pickupSparkle', 0xffd166));
    const gem = cueForVfxEvent(vfxEvent('pickupSparkle', 0x44ddff));
    // A chest/harvest producer using an ad hoc tint outside the known palette.
    const adHoc = cueForVfxEvent(vfxEvent('pickupSparkle', 0x123456));
    expect(gold?.kind).toBe('pickup');
    expect(gem?.kind).toBe('pickup');
    expect(adHoc?.kind).toBe('pickup');
  });

  it('ignores every other vfx kind (out of scope for this queue)', () => {
    expect(cueForVfxEvent(vfxEvent('levelUpBurst'))).toBeNull();
    expect(cueForVfxEvent(vfxEvent('weaponSwingArc'))).toBeNull();
    expect(cueForVfxEvent(vfxEvent('fireballBlast'))).toBeNull();
    expect(cueForVfxEvent(vfxEvent('abilityActivateFlash'))).toBeNull();
  });
});

describe('cueForAbilityActivation', () => {
  it('maps a spell activation to spellCast', () => {
    expect(cueForAbilityActivation(abilityEvent({ kind: 'spell' })).kind).toBe('spellCast');
  });

  it('maps an active-ability activation to abilityActivate', () => {
    expect(cueForAbilityActivation(abilityEvent({ kind: 'active' })).kind).toBe('abilityActivate');
  });

  it('every activation event yields a cue (no out-of-scope case)', () => {
    for (const kind of ['active', 'spell'] as const) {
      const cue = cueForAbilityActivation(abilityEvent({ kind }));
      expect(cue.intensity).toBeGreaterThan(0);
      expect(cue.intensity).toBeLessThanOrEqual(1);
    }
  });
});
