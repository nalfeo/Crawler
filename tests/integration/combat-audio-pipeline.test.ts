/**
 * Integration coverage for the parts of the combat/loot SFX pipeline that a
 * real `GameWorld` can actually prove: that `createCombatAudio` maps all three
 * source queues (`world.combatEvents`, `world.abilityActivations`,
 * `world.vfxEvents`) to cues, that it NEVER mutates (drains) any of them, and
 * that per-kind throttling holds across frames even when the real drainers
 * clear the queues in between.
 *
 * It deliberately does NOT claim to prove the runtime call ORDER (that
 * `combatAudio.update()` runs before `CombatVfx`/`EffectsVfx` drain): this
 * suite drives the frame itself, so moving the production call after a drainer
 * would leave it green. That ordering is covered where it is real, against the
 * booted scene + bridge, in `tests/e2e/combat-audio-real-wiring.test.ts`,
 * which pushes onto the real queues and asserts the cue still fires on the
 * next real frame.
 */
import { describe, expect, it } from 'vitest';
import { createCombatAudio } from '../../src/engine/combat-audio.js';
import type { AudioCueEngine, SynthCueSpec } from '../../src/engine/audio/audio-cue-engine.js';
import { createTestWorld } from '../helpers/world-factory.js';

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

describe('combat-audio pipeline: queue mapping and non-draining contract', () => {
  it('maps combatEvents/abilityActivations/vfxEvents pushed in one frame to their cues', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();

    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 15,
      targetType: 'player',
      timestamp: world.elapsedMs,
    });
    world.abilityActivations.push({
      abilityId: 'fireball',
      label: 'Fireball',
      kind: 'spell',
      category: 'combat',
      holderEid: 1,
      x: 0,
      y: 0,
      elapsedMs: world.elapsedMs,
    });
    world.vfxEvents.push({ kind: 'pickupSparkle', x: 0, y: 0, color: 0xffd166 });

    audio.update(world, 0);

    const labels = engine.specs.map((s) => s.label);
    expect(labels).toContain('combat:damage-taken');
    expect(labels).toContain('combat:spell-cast');
    expect(labels).toContain('combat:pickup');
  });

  it('never mutates the queues itself, regardless of drain order', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();

    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 5,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
    });

    audio.update(world, 0);
    // The event is still there for CombatVfx to drain afterward.
    expect(world.combatEvents).toHaveLength(1);
  });

  it('across two simulated frames, throttling still holds even with intervening drains', () => {
    const engine = createFakeEngine();
    const audio = createCombatAudio(engine);
    const world = createTestWorld();

    for (const renderElapsedMs of [0, 10, 200]) {
      world.combatEvents.push({
        type: 'hit',
        x: 0,
        y: 0,
        amount: 10,
        targetType: 'enemy',
        timestamp: world.elapsedMs,
      });
      audio.update(world, renderElapsedMs);
      world.combatEvents.length = 0; // simulate CombatVfx draining every frame
    }

    // Frame at t=10 is within weaponHit's 50ms cooldown from t=0 -> suppressed.
    // Frame at t=200 is past cooldown -> plays again. So 2 total, not 3.
    expect(engine.specs.filter((s) => s.label === 'combat:weapon-hit')).toHaveLength(2);
  });
});
