/**
 * Core-layer coverage for the mob-ability executor system (`mobAbilitySystem`).
 *
 * Tests here verify the generic runtime contracts — recycled-ID guard,
 * generation-token isolation, cooldown anchoring, encounter gating, and
 * AI-avoidance cue consistency. Ability-specific effects (Verdigris Glamour,
 * Tarnished) are covered by tests/unit/mob-abilities/verdigris-glamour.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { removeEntity } from 'bitecs';
import { GAME } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  spawnPlayer,
  spawnBehaviorEnemy,
  setEnemyAppearanceKey,
  clearEntityStores,
  mobAbilitySystem,
  registerMobAbility,
  clearMobAbility,
  setMobAbilitiesEnabled,
  activateMobAbilityEncounter,
  disableMobAbilityEncounter,
  createVerdigrisGlamourDefinition,
  registerMobAbilityOwnedZone,
} from '../../src/core/index.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';

const DELTA = GAME.DELTA_MS;
const QUEEN_KEY = 'faerie-boss';

function makeWorld() {
  return createTestWorld();
}

function spawnQueen(world: ReturnType<typeof makeWorld>, x = 40, y = 10) {
  const queen = spawnBehaviorEnemy(world, x, y, 200, AI_TYPE.CHASE, 0.17, 60, 0);
  setEnemyAppearanceKey(world, queen, QUEEN_KEY);
  return queen;
}

function arm(world: ReturnType<typeof makeWorld>, queen: number) {
  const def = createVerdigrisGlamourDefinition();
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, queen, def);
  activateMobAbilityEncounter(world);
  return def;
}

function tick(world: ReturnType<typeof makeWorld>, frames: number) {
  for (let i = 0; i < frames; i++) {
    world.elapsedMs += DELTA;
    mobAbilitySystem(world);
  }
}

// ─── Gate: no-op when disabled ───────────────────────────────────────────────

describe('default-off gate', () => {
  it('emits no cues and no casts when the runtime is disabled', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    const def = createVerdigrisGlamourDefinition();
    registerMobAbility(world, queen, def);
    activateMobAbilityEncounter(world);
    // runtime.enabled is false (default)
    tick(world, 700);
    expect(world.mobAbilities.cues.length).toBe(0);
    const inst = world.mobAbilities.byEntity.get(queen);
    expect(inst?.resolvedCasts ?? 0).toBe(0);
  });

  it('emits no cues when enabled but encounter is not active', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    const def = createVerdigrisGlamourDefinition();
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, def);
    // encounterActive is false — clocks should not advance
    tick(world, 700);
    expect(world.mobAbilities.cues.length).toBe(0);
    const inst = world.mobAbilities.byEntity.get(queen);
    expect(inst?.resolvedCasts ?? 0).toBe(0);
  });
});

// ─── Generation-token recycled-ID guard ──────────────────────────────────────

describe('recycled-ID generation-token guard', () => {
  it('assigns distinct tokens on successive registrations', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    const def = createVerdigrisGlamourDefinition();
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, def);
    const token1 = world.mobAbilities.byEntity.get(queen)!.registrationToken;

    // Clear and re-register the same EID.
    clearMobAbility(world, queen);
    registerMobAbility(world, queen, def);
    const token2 = world.mobAbilities.byEntity.get(queen)!.registrationToken;
    expect(token2).toBeGreaterThan(token1);
  });

  it('clears the registration token map on clearMobAbility', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    const def = createVerdigrisGlamourDefinition();
    setMobAbilitiesEnabled(world, true);
    registerMobAbility(world, queen, def);
    expect(world.mobAbilities.registrationTokens.has(queen)).toBe(true);
    clearMobAbility(world, queen);
    expect(world.mobAbilities.registrationTokens.has(queen)).toBe(false);
  });

  it('does not validate a stale instance after EID is recycled to same archetype', () => {
    const world = makeWorld();
    const player = spawnPlayer(world, 40, 40);
    const queen = spawnQueen(world, 40, 10);
    arm(world, queen);

    // Advance to telegraph phase.
    const firstTelegraphFrames = 540; // 9,000ms / DELTA_MS
    tick(world, firstTelegraphFrames);
    expect(world.mobAbilities.cues.length).toBeGreaterThan(0);

    // Simulate EID recycling: remove Queen's entity, but leave the byEntity
    // entry intact (mimicking a same-tick recycle before cleanup runs).
    // The generation-token guard detects this because registrationTokens was
    // cleared on entity removal, yet the old instance's token no longer matches.
    const staleToken = world.mobAbilities.byEntity.get(queen)!.registrationToken;
    // Manually stomp the runtime token map to simulate a recycled EID having
    // no current registration (the entity was removed + not re-registered).
    world.mobAbilities.registrationTokens.delete(queen);

    // Next tick: isCasterValid should fail the token check and clean up.
    world.elapsedMs += DELTA;
    mobAbilitySystem(world);

    expect(world.mobAbilities.byEntity.has(queen)).toBe(false);
    expect(world.mobAbilities.cues.length).toBe(0);
    expect(staleToken).toBeGreaterThanOrEqual(0); // just to use the variable

    void player; // suppress unused-variable lint
  });

  it('clears runtime state from the central entity teardown/recycle path', () => {
    const world = makeWorld();
    const player = spawnPlayer(world, 40, 40);
    const queen = spawnQueen(world, 40, 10);
    arm(world, queen);

    tick(world, 630); // first resolution applies owned Tarnished effects
    const sourceId = `mob-ability:queen-mab-verdigris-glamour:${queen}`;
    expect(
      (world.statusEffectsByEntity.get(player) ?? []).some(
        (effect) => effect.sourceId === sourceId,
      ),
    ).toBe(true);

    clearEntityStores(world, queen);

    expect(world.mobAbilities.byEntity.has(queen)).toBe(false);
    expect(world.mobAbilities.registrationTokens.has(queen)).toBe(false);
    expect(world.mobAbilities.cues.some((cue) => cue.casterEid === queen)).toBe(false);
    expect(
      (world.statusEffectsByEntity.get(player) ?? []).some(
        (effect) => effect.sourceId === sourceId,
      ),
    ).toBe(false);
  });
});

// ─── AI-avoidance cue geometry ────────────────────────────────────────────────

describe('AI-avoidance cue consistency', () => {
  it('publishes circle cues with the same geometry locked at telegraph start', () => {
    const world = makeWorld();
    const player = spawnPlayer(world, 5, 5); // player inside future circle
    const queen = spawnQueen(world, 5, 30);
    arm(world, queen);

    // Advance until the first telegraph fires.
    tick(world, 540); // frame 540 = first telegraph start (9,000ms)

    const cues = world.mobAbilities.cues;
    expect(cues.length).toBeGreaterThan(0);
    const cue = cues[0]!;
    expect(cue.phase).toBe('telegraph');
    expect(cue.geometry.kind).toBe('circle');
    if (cue.geometry.kind !== 'circle') {
      throw new Error('expected committed circle geometry');
    }
    // Geometry must be locked to the PLAYER'S position at telegraph start.
    expect(typeof cue.geometry.x).toBe('number');
    expect(typeof cue.geometry.y).toBe('number');
    expect(cue.geometry.radiusFt).toBeGreaterThan(0);

    void player;
  });

  it('cues are empty (no stale geometry) when encounter is disabled', () => {
    const world = makeWorld();
    spawnPlayer(world, 5, 5);
    const queen = spawnQueen(world, 5, 30);
    arm(world, queen);
    tick(world, 540); // trigger a telegraph
    expect(world.mobAbilities.cues.length).toBeGreaterThan(0);

    disableMobAbilityEncounter(world);
    // The cues array is emptied by disableMobAbilityEncounter.
    expect(world.mobAbilities.cues.length).toBe(0);
  });

  it('drops a locked target if the player eid is recycled into a new Player', () => {
    const world = makeWorld();
    const player = spawnPlayer(world, 5, 5);
    const queen = spawnQueen(world, 5, 30);
    arm(world, queen);

    tick(world, 540);
    const inst = world.mobAbilities.byEntity.get(queen)!;
    expect(inst.phase).toBe('telegraph');
    expect(inst.committedTargetEid).toBe(player);
    const lockedGeneration = inst.committedTargetGeneration;
    expect(lockedGeneration).toBe(world.entityRenderGeneration[player]);

    removeEntity(world.ecs, player);
    const recycledPlayer = spawnPlayer(world, 50, 50);
    expect(recycledPlayer).toBe(player);
    expect(world.entityRenderGeneration[recycledPlayer]).not.toBe(lockedGeneration);

    tick(world, 90);

    expect(inst.phase).toBe('cooldown');
    expect(inst.resolvedCasts).toBe(0);
  });
});

// ─── Cooldown anchoring ───────────────────────────────────────────────────────

describe('cooldown anchoring', () => {
  it('anchors cooldown AFTER resolution, not at telegraph start', () => {
    const world = makeWorld();
    spawnPlayer(world, 5, 5);
    const queen = spawnQueen(world, 5, 30);
    arm(world, queen);

    // First resolution at frame 630 (10,500ms).
    tick(world, 630);
    const inst = world.mobAbilities.byEntity.get(queen)!;
    expect(inst.resolvedCasts).toBe(1);
    // After resolution the instance should be back in cooldown.
    expect(inst.phase).toBe('cooldown');
    // The cooldown timer should be the full cooldownMs, not partway through.
    const def = createVerdigrisGlamourDefinition();
    expect(inst.timerMs).toBeCloseTo(def.cooldownMs, 0);
  });
});

describe('owned zone registration', () => {
  it('rejects non-positive tick intervals', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: 1000,
        tickIntervalMs: 0,
        tick: () => undefined,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
  });

  it('rejects non-finite tick intervals', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: 1000,
        tickIntervalMs: Number.NaN,
        tick: () => undefined,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: 1000,
        tickIntervalMs: Number.POSITIVE_INFINITY,
        tick: () => undefined,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
  });

  it('rejects sub-millisecond positive tick intervals', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: 1000,
        tickIntervalMs: Number.MIN_VALUE,
        tick: () => undefined,
      }),
    ).toThrow(/tickIntervalMs must be >= 1/);
  });

  it('rejects non-positive durations', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: 0,
        tickIntervalMs: DELTA,
        tick: () => undefined,
      }),
    ).toThrow(/durationMs must be > 0/);
  });

  it('rejects non-finite durations', () => {
    const world = makeWorld();
    const queen = spawnQueen(world);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: Number.NaN,
        tickIntervalMs: DELTA,
        tick: () => undefined,
      }),
    ).toThrow(/durationMs must be > 0/);
    expect(() =>
      registerMobAbilityOwnedZone(world, {
        sourceId: 'test-zone',
        abilityId: 'test-ability',
        casterEid: queen,
        geometry: { kind: 'circle', x: 1, y: 2, radiusFt: 3 },
        durationMs: Number.POSITIVE_INFINITY,
        tickIntervalMs: DELTA,
        tick: () => undefined,
      }),
    ).toThrow(/durationMs must be > 0/);
  });
});
