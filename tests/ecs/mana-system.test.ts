import { describe, it, expect, beforeEach } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { manaSystem } from '../../src/core/systems/manaSystem.js';
import {
  MANA_BASE,
  MANA_PER_WISDOM,
  MANA_REGEN_PER_FRAME,
  deriveMaxMp,
} from '../../src/shared/mana.js';

/**
 * The Wisdom payoff: the player's MP pool scales with EFFECTIVE Wisdom, and MP
 * regenerates on the deterministic fixed-timestep clock (never Date.now).
 */
describe('manaSystem (Wisdom → MP pool)', () => {
  let world: GameWorld;
  let player: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    statSystem(world);
  });

  it('keeps a fresh player (effective Wisdom 1) at the historical 100 MP pool', () => {
    manaSystem(world);
    expect(world.playerMaxMp).toBeCloseTo(100, 6);
  });

  it('scales playerMaxMp from allocated Wisdom', () => {
    world.stores.coreStatPoints.wisdom[player] = 5;
    statSystem(world);
    manaSystem(world);
    // effective Wisdom = base 1 + 5 allocated = 6
    expect(world.playerMaxMp).toBeCloseTo(deriveMaxMp(6), 6);
    expect(world.playerMaxMp).toBeCloseTo(MANA_BASE + MANA_PER_WISDOM * 6, 6);
  });

  it('regenerates a fixed amount of MP per frame and clamps to max', () => {
    world.playerMp = 0;
    manaSystem(world);
    expect(world.playerMp).toBeCloseTo(MANA_REGEN_PER_FRAME, 6);

    for (let i = 0; i < 100000; i++) {
      manaSystem(world);
    }
    expect(world.playerMp).toBe(world.playerMaxMp);
  });

  it('clamps current MP down when the derived max is below it', () => {
    world.playerMp = 999;
    manaSystem(world); // effective Wisdom 1 → max 100
    expect(world.playerMp).toBe(world.playerMaxMp);
    expect(world.playerMaxMp).toBeCloseTo(100, 6);
  });

  it('is a no-op without a Player+EffectiveStats singleton (keeps the world default)', () => {
    const bare = createTestWorld();
    const maxBefore = bare.playerMaxMp;
    const mpBefore = bare.playerMp;
    manaSystem(bare);
    expect(bare.playerMaxMp).toBe(maxBefore);
    expect(bare.playerMp).toBe(mpBefore);
  });
});
