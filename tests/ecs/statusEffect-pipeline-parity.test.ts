import { describe, it, expect } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { applyStatusEffect } from '../../src/core/status-effects.js';
import { statusEffectSystem } from '../../src/core/systems/statusEffectSystem.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { runSimulationStep as runVisualStep } from '../../src/engine/sim/simulation-step.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import type { StatusEffectSpec } from '../../src/shared/status-effect-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Cross-pipeline parity (isolated fixture).
 *
 * The framework must behave identically no matter which sim pipeline drives it:
 * the headless runner (`src/game/ai/simulation-step.ts`, which hardcodes
 * `statusEffectSystem`) and the visual step (`src/engine/sim/simulation-step.ts`,
 * which receives it via `preSystems` from the Floor bootstrap).
 *
 * We deliberately use a controlled, player-only, NO-COMBAT world so the only
 * thing that can move `health.current` is the HoT apply inside `statusEffectSystem`.
 * That removes the weaponSystem/director confound (see plan review r2 #2) and lets
 * us assert EXACT equality — no epsilon — against a direct-`statusEffectSystem`
 * baseline. If either pipeline dropped the system from its pre-movement slot, the
 * wounded player would not heal and the exact-equal assertion would fail.
 */

const DELTA = GAME.DELTA_MS;
const FRAMES = 60; // 60 * (1000/60) = exactly 1000ms => +0.75 HP at 0.75 HP/s

const CHARM_HOT: StatusEffectSpec = {
  stat: 'hpRegen',
  op: 'add',
  value: 0.75,
  durationMs: null,
  sourceType: 'equipment',
  sourceId: 'equipment:parity',
  stackRule: { mode: 'replace' },
};

type World = ReturnType<typeof createTestWorld>;

/** A player-only world with a wounded player carrying the persistent HoT. */
function woundedPlayerWorld(): { world: World; player: number } {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, 0, 0);
  const { health } = world.stores;
  // Wound well below max so the HoT accrues without clamping to max this window.
  const max = health.max[player] ?? 100;
  health.current[player] = Math.max(1, Math.floor(max / 2));
  applyStatusEffect(world, player, CHARM_HOT);
  return { world, player };
}

const hp = (world: World, player: number): number => world.stores.health.current[player] ?? 0;

describe('status-effect cross-pipeline parity (HoT, no combat)', () => {
  it('heals the wounded player and never exceeds max', () => {
    const { world, player } = woundedPlayerWorld();
    const start = hp(world, player);
    for (let i = 0; i < FRAMES; i++) statusEffectSystem(world);

    expect(hp(world, player)).toBeGreaterThan(start);
    expect(hp(world, player)).toBeLessThanOrEqual(world.stores.health.max[player] ?? 0);
  });

  it('headless pipeline matches the direct-system baseline exactly', () => {
    const base = woundedPlayerWorld();
    for (let i = 0; i < FRAMES; i++) statusEffectSystem(base.world);

    const run = woundedPlayerWorld();
    const input = createInputState();
    for (let i = 0; i < FRAMES; i++) {
      runHeadlessStep(run.world, input, DELTA, { enableFloor1: false });
    }

    expect(hp(run.world, run.player)).toBe(hp(base.world, base.player));
  });

  it('visual pipeline matches the direct-system baseline exactly', () => {
    const base = woundedPlayerWorld();
    for (let i = 0; i < FRAMES; i++) statusEffectSystem(base.world);

    const run = woundedPlayerWorld();
    const input = createInputState();
    for (let i = 0; i < FRAMES; i++) {
      runVisualStep(run.world, input, { preSystems: [statusEffectSystem] });
    }

    expect(hp(run.world, run.player)).toBe(hp(base.world, base.player));
  });
});
