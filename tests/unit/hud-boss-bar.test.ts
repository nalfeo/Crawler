import { describe, expect, it } from 'vitest';
import { BOSS_BAR_COLORS, resolveBossHealthBar } from '../../src/engine/boss-health-bar-state.js';
import type { Floor1BossEncounterState } from '../../src/shared/floor-types.js';
import { spawnEnemy } from '../../src/core/index.js';
import { createTestWorld } from '../helpers/world-factory.js';

function battle(overrides: Partial<Floor1BossEncounterState> = {}): Floor1BossEncounterState {
  return {
    started: true,
    bossEid: null,
    defeated: false,
    displayName: 'Slime Rat',
    ...overrides,
  };
}

describe('resolveBossHealthBar', () => {
  it('returns null when there are no boss battles', () => {
    const world = createTestWorld();
    expect(resolveBossHealthBar(undefined, world.ecs, world.stores.health)).toBeNull();
    expect(resolveBossHealthBar(new Map(), world.ecs, world.stores.health)).toBeNull();
  });

  it('returns null when the only battle has not started', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    const battles = new Map([['slime-rat', battle({ started: false, bossEid: eid })]]);
    expect(resolveBossHealthBar(battles, world.ecs, world.stores.health)).toBeNull();
  });

  it('returns null when a started battle has no spawned boss entity', () => {
    const world = createTestWorld();
    const battles = new Map([['slime-rat', battle({ bossEid: null })]]);
    expect(resolveBossHealthBar(battles, world.ecs, world.stores.health)).toBeNull();
  });

  it('skips battles whose boss entity no longer exists', () => {
    const world = createTestWorld();
    // EID 999 was never created, so entityExists is false.
    const battles = new Map([['slime-rat', battle({ bossEid: 999 })]]);
    expect(resolveBossHealthBar(battles, world.ecs, world.stores.health)).toBeNull();
  });

  it('resolves the active boss with high-band (green) colour above 50% health', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    world.stores.health.current[eid] = 80;
    const battles = new Map([['slime-rat', battle({ bossEid: eid, displayName: 'Slime Rat' })]]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state).not.toBeNull();
    expect(state?.displayName).toBe('Slime Rat');
    expect(state?.current).toBe(80);
    expect(state?.max).toBe(100);
    expect(state?.pct).toBeCloseTo(0.8, 6);
    expect(state?.fillColor).toBe(BOSS_BAR_COLORS.high);
  });

  it('uses the mid-band (amber) colour at exactly 50% and within [25%, 50%]', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    world.stores.health.current[eid] = 50;
    const battles = new Map([['slime-rat', battle({ bossEid: eid })]]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.pct).toBeCloseTo(0.5, 6);
    expect(state?.fillColor).toBe(BOSS_BAR_COLORS.mid);
  });

  it('uses the low-band (red) colour below 25% health', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    world.stores.health.current[eid] = 10;
    const battles = new Map([['slime-rat', battle({ bossEid: eid })]]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.fillColor).toBe(BOSS_BAR_COLORS.low);
  });

  it('clamps negative current health to zero and keeps pct in [0, 1]', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    world.stores.health.current[eid] = -25;
    const battles = new Map([['slime-rat', battle({ bossEid: eid })]]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.current).toBe(0);
    expect(state?.pct).toBe(0);
    expect(state?.fillColor).toBe(BOSS_BAR_COLORS.low);
  });

  it('picks the first started, alive battle in map insertion order', () => {
    const world = createTestWorld();
    const slimeRat = spawnEnemy(world, 0, 0, 100);
    const staircase = spawnEnemy(world, 0, 0, 200);
    const battles = new Map<string, Floor1BossEncounterState>([
      ['slime-rat', battle({ bossEid: slimeRat, displayName: 'Slime Rat' })],
      ['staircase', battle({ bossEid: staircase, displayName: 'Rat Slime' })],
    ]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.displayName).toBe('Slime Rat');
    expect(state?.max).toBe(100);
  });

  it('falls back to a later started battle when the earlier boss is gone', () => {
    const world = createTestWorld();
    const staircase = spawnEnemy(world, 0, 0, 200);
    const battles = new Map<string, Floor1BossEncounterState>([
      ['slime-rat', battle({ bossEid: null })],
      ['staircase', battle({ bossEid: staircase, displayName: 'Rat Slime' })],
    ]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.displayName).toBe('Rat Slime');
  });

  it('falls back to "Boss" when the battle has an empty display name', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 100);
    const battles = new Map([['slime-rat', battle({ bossEid: eid, displayName: '' })]]);

    const state = resolveBossHealthBar(battles, world.ecs, world.stores.health);
    expect(state?.displayName).toBe('Boss');
  });
});
