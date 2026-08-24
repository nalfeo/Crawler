import { describe, expect, it } from 'vitest';
import { createCombatAudio } from '../../src/engine/combat-audio.js';
import { combatSynthSpecForCue } from '../../src/engine/audio/combat-cue-specs.js';
import type { AudioCueEngine, SynthCueSpec } from '../../src/engine/audio/audio-cue-engine.js';
import type { CombatAudioCue, CombatAudioCueKind } from '../../src/shared/combat-audio-cues.js';
import { createTestWorld } from '../helpers/world-factory.js';

const ALL_KINDS: readonly CombatAudioCueKind[] = [
  'weaponHit',
  'weaponCrit',
  'weaponMiss',
  'damageTaken',
  'blocked',
  'dodge',
  'enemyDeath',
  'spellCast',
  'spellImpact',
  'abilityActivate',
  'pickup',
];

function cue(kind: CombatAudioCueKind, intensity = 0.5): CombatAudioCue {
  return { kind, intensity };
}

describe('combatSynthSpecForCue', () => {
  it('produces a valid SynthCueSpec for every cue kind', () => {
    for (const kind of ALL_KINDS) {
      const spec = combatSynthSpecForCue(cue(kind));
      expect(spec.durationMs).toBeGreaterThan(0);
      expect(spec.gain).toBeGreaterThan(0);
      expect(spec.gain).toBeLessThanOrEqual(1);
      expect(spec.frequencyHz).toBeGreaterThan(0);
      expect(spec.label).toContain('combat:');
    }
  });
});

function createFakeEngine(): AudioCueEngine & { specs: SynthCueSpec[] } {
  const specs: SynthCueSpec[] = [];
  return {
    specs,
    isAvailable: () => true,
    play: (spec: SynthCueSpec) => {
      specs.push(spec);
    },
    stopAll: () => {},
    dispose: () => {},
  };
}

describe('createCombatAudio', () => {
  it('does nothing when no events are queued', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    audio.update(world, 0);
    expect(engine.specs).toHaveLength(0);
  });

  it('plays a damageTaken cue when the player takes a hit', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 10,
      targetType: 'player',
      timestamp: 0,
    });
    audio.update(world, 0);
    expect(engine.specs.map((s) => s.label)).toContain('combat:damage-taken');
  });

  it('plays a spellCast cue when an ability activation fires with kind=spell', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    world.abilityActivations.push({
      abilityId: 'fireball',
      label: 'Fireball',
      kind: 'spell',
      category: 'combat',
      holderEid: 1,
      x: 0,
      y: 0,
      elapsedMs: 0,
    });
    audio.update(world, 0);
    expect(engine.specs.map((s) => s.label)).toContain('combat:spell-cast');
  });

  it('plays a pickup cue when a pickupSparkle vfx event fires', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    world.vfxEvents.push({ kind: 'pickupSparkle', x: 0, y: 0, color: 0xffd166 });
    audio.update(world, 0);
    expect(engine.specs.map((s) => s.label)).toContain('combat:pickup');
  });

  it('does NOT drain any of the three source queues', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 10,
      targetType: 'enemy',
      timestamp: 0,
    });
    world.vfxEvents.push({ kind: 'pickupSparkle', x: 0, y: 0 });
    world.abilityActivations.push({
      abilityId: 'a',
      label: 'A',
      kind: 'active',
      category: 'utility',
      holderEid: 1,
      x: 0,
      y: 0,
      elapsedMs: 0,
    });
    audio.update(world, 0);
    expect(world.combatEvents).toHaveLength(1);
    expect(world.vfxEvents).toHaveLength(1);
    expect(world.abilityActivations).toHaveLength(1);
  });

  it('throttles repeat cues of the same kind within the cooldown window', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();
    const pushHit = () =>
      world.combatEvents.push({
        type: 'hit',
        x: 0,
        y: 0,
        amount: 10,
        targetType: 'enemy',
        timestamp: 0,
      });

    pushHit();
    audio.update(world, 0);
    world.combatEvents.length = 0;
    expect(engine.specs).toHaveLength(1);

    // Well within weaponHit's 50ms cooldown — should be suppressed.
    pushHit();
    audio.update(world, 10);
    world.combatEvents.length = 0;
    expect(engine.specs).toHaveLength(1);

    // Past the cooldown — should play again.
    pushHit();
    audio.update(world, 200);
    expect(engine.specs).toHaveLength(2);
  });

  it('caps distinct cue kinds per frame, keeping the highest-priority candidates', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();

    // Push more than MAX_CUES_PER_FRAME (4) distinct kinds in one frame.
    world.combatEvents.push(
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'enemy', timestamp: 0 }, // weaponHit (low priority)
      { type: 'miss', x: 0, y: 0, amount: 0, targetType: 'enemy', timestamp: 0 }, // weaponMiss (lowest)
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'player', timestamp: 0 }, // damageTaken (highest)
      { type: 'death', x: 0, y: 0, amount: 0, targetType: 'enemy', timestamp: 0 }, // enemyDeath
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'enemy', isCrit: true, timestamp: 0 }, // weaponCrit
      { type: 'blocked', x: 0, y: 0, amount: 0, targetType: 'player', timestamp: 0 }, // blocked
    );

    audio.update(world, 0);

    expect(engine.specs.length).toBeLessThanOrEqual(4);
    const labels = engine.specs.map((s) => s.label);
    // The two lowest-priority kinds (weaponHit, weaponMiss) must be the ones dropped.
    expect(labels).toContain('combat:damage-taken');
    expect(labels).toContain('combat:enemy-death');
    expect(labels).toContain('combat:weapon-crit');
    expect(labels).not.toContain('combat:weapon-hit');
    expect(labels).not.toContain('combat:weapon-miss');
  });

  it('does not penalize a cue dropped only by the per-frame budget — it can still play next frame', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();

    // 5 distinct kinds in frame 1: weaponHit loses the per-frame budget (not its cooldown).
    world.combatEvents.push(
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'enemy', timestamp: 0 },
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'player', timestamp: 0 },
      { type: 'death', x: 0, y: 0, amount: 0, targetType: 'enemy', timestamp: 0 },
      { type: 'hit', x: 0, y: 0, amount: 10, targetType: 'enemy', isCrit: true, timestamp: 0 },
      { type: 'blocked', x: 0, y: 0, amount: 0, targetType: 'player', timestamp: 0 },
    );
    audio.update(world, 0);
    world.combatEvents.length = 0;
    expect(engine.specs.map((s) => s.label)).not.toContain('combat:weapon-hit');

    // Frame 2, only 5ms later (within weaponHit's 50ms cooldown if it had been
    // "played" in frame 1) — it should still be eligible since it never played.
    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 10,
      targetType: 'enemy',
      timestamp: 0,
    });
    audio.update(world, 5);
    expect(engine.specs.map((s) => s.label)).toContain('combat:weapon-hit');
  });

  it('destroy() stops and disposes the underlying engine', () => {
    const calls: string[] = [];
    const engine: AudioCueEngine = {
      isAvailable: () => true,
      play: () => {},
      stopAll: () => calls.push('stopAll'),
      dispose: () => calls.push('dispose'),
    };
    const audio = createCombatAudio(engine);
    audio.destroy();
    expect(calls).toEqual(['stopAll', 'dispose']);
  });
});
