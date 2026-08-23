/**
 * Integration coverage for the combat/loot SFX pipeline's read-before-drain
 * contract: `createCombatAudio` must observe `world.combatEvents`,
 * `world.abilityActivations`, and `world.vfxEvents` events BEFORE the real
 * engine-layer renderers (`CombatVfx`/`EffectsVfx`) drain them each frame —
 * see `src/engine/combat-audio.ts`'s module doc comment.
 *
 * This uses a REAL `GameWorld` (via `createTestWorld`) and drives the SAME
 * per-frame call order `PhaserBridge.ts` uses (`combatAudio.update()` before
 * the drainers), simulating each drainer's `queue.length = 0` the way
 * `EffectsVfx`/`CombatVfx` actually do, rather than needing a real Phaser
 * scene — a WebAudio `AudioContext`/Phaser renderer have nothing further to
 * prove here (see `tests/unit/audio-cue-engine.test.ts` /
 * `tests/unit/combat-audio.test.ts` for those in isolation).
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

describe('combat-audio pipeline: read-before-drain ordering', () => {
  it('sees combatEvents/abilityActivations/vfxEvents pushed this frame even though a drainer clears them immediately after', () => {
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

    // Frame order mirrors PhaserBridge.ts: combatAudio.update() first, then
    // the real drainers (simulated here as their documented sole-consumer
    // `length = 0` resets — CombatVfx drains combatEvents+abilityActivations,
    // EffectsVfx drains vfxEvents).
    audio.update(world, 0);
    world.combatEvents.length = 0; // CombatVfx's drain
    world.abilityActivations.length = 0; // CombatVfx's drain
    world.vfxEvents.length = 0; // EffectsVfx's drain

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
